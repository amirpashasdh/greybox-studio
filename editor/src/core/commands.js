// Greybox command language: one line per change. This is what the scene agent writes, what the
// command box in the editor accepts, and what the agent is shown as the current scene.
//
//   add mannequin hero at=0,0,0 face=cam desc="a woman in a yellow raincoat"
//   key hero pos t=0 0,0,0 ; t=4 3,0,-2 e=inout
//   macro orbit cam=cam1 target=hero radius=2.5 from=-30 to=150 t0=0 t1=8
//
// Applying is transactional: commands run against a copy, and the caller decides whether to keep it.

import {
  clone, makeObject, makeCamera, findObject, findCamera, findAny, isValidId, TYPES, POSES, ROLES, defaultSize,
} from './schema.js';
import { sub, yawOf, round, round3, fovFromFocal, focalFromFov } from './math.js';
import { evaluateScene } from './evaluate.js';
import { MACROS } from './macros.js';

export class CommandError extends Error {}

// ---------- tokenizing ----------

export function tokenize(line) {
  // Tokens are split on whitespace and ';'. Double quotes group words: `desc="a red car"` yields the
  // string 'desc=a red car'; a token that is entirely quoted is returned as { q } so it is never
  // mistaken for key=value.
  const out = [];
  let i = 0;
  const isQuote = (c) => c === '"' || c === '\u201c' || c === '\u201d';
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === ';') { out.push(';'); i++; continue; }
    let tok = '';
    const wholeQuoted = isQuote(ch);
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== ';') {
      if (isQuote(line[i])) {
        i++;
        while (i < line.length && !isQuote(line[i])) {
          if (line[i] === '\\' && line[i + 1] === '"') { tok += '"'; i += 2; continue; }
          tok += line[i++];
        }
        i++;
      } else tok += line[i++];
    }
    out.push(wholeQuoted ? { q: tok } : tok);
  }
  return out;
}

const raw = (tok) => (typeof tok === 'object' && tok !== null ? tok.q : tok);

function splitKV(tokens) {
  const pos = [];
  const kv = {};
  for (const t of tokens) {
    if (typeof t === 'string') {
      const eq = t.indexOf('=');
      if (eq > 0) {
        kv[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1);
        continue;
      }
    }
    pos.push(raw(t));
  }
  return { pos, kv };
}

// ---------- value parsing ----------

export function parseNum(s, what = 'number') {
  const n = Number(s);
  if (s === undefined || s === '' || !Number.isFinite(n)) throw new CommandError(`expected ${what}, got "${s ?? ''}"`);
  return n;
}

export function parseVec(s, what = 'x,y,z') {
  if (s === undefined) throw new CommandError(`expected ${what}`);
  const parts = String(s).split(',').map((x) => x.trim());
  if (parts.length === 1) {
    const n = parseNum(parts[0], what);
    return [n, n, n];
  }
  if (parts.length === 2) return [parseNum(parts[0], what), 0, parseNum(parts[1], what)]; // x,z on the ground
  if (parts.length !== 3) throw new CommandError(`expected ${what}, got "${s}"`);
  return parts.map((p) => parseNum(p, what));
}

const isVecLike = (s) => /^-?[\d.]+(,-?[\d.]+){1,2}$/.test(String(s));

function parseColor(s) {
  if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s)) throw new CommandError(`expected a colour like #8a6a50, got "${s}"`);
  return s.startsWith('#') ? s : '#' + s;
}

const EASE_NAMES = ['linear', 'inout', 'in', 'out', 'step', 'smooth'];
function parseEase(s) {
  if (s === undefined) return undefined;
  const e = { 'ease-in-out': 'inout', easeinout: 'inout', ease: 'inout', hold: 'step' }[s] || s;
  if (!EASE_NAMES.includes(e)) throw new CommandError(`unknown ease "${s}" (use ${EASE_NAMES.join(', ')})`);
  return e;
}

// ---------- applying ----------

function requireId(doc, id, kind = 'object') {
  const o = kind === 'camera' ? findCamera(doc, id) : kind === 'any' ? findAny(doc, id) : findObject(doc, id);
  if (!o) throw new CommandError(`no ${kind === 'any' ? 'object or camera' : kind} called "${id}"`);
  return o;
}

function resolvePoint(doc, s, t = 0) {
  if (s === 'cam' || s === 'camera') {
    const ev = evaluateScene(doc, t);
    return ev.cameras.get(ev.active)?.pos;
  }
  if (isVecLike(s)) return parseVec(s);
  const ev = evaluateScene(doc, t);
  const st = ev.objects.get(s) || ev.cameras.get(s);
  if (!st) throw new CommandError(`no object or camera called "${s}"`);
  return st.focus || st.pos;
}

const OBJECT_PROPS = {
  name: (o, v) => { o.name = v; },
  desc: (o, v) => { o.desc = v; },
  role: (o, v) => {
    if (!ROLES.includes(v)) throw new CommandError(`role must be one of ${ROLES.join(', ')}`);
    o.role = v;
  },
  at: (o, v) => { o.pos = parseVec(v); },
  pos: (o, v) => { o.pos = parseVec(v); },
  rot: (o, v) => { o.rot = parseVec(v); },
  yaw: (o, v) => { o.rot = [o.rot[0], parseNum(v, 'yaw degrees'), o.rot[2]]; },
  scale: (o, v) => { o.scale = parseVec(v); },
  size: (o, v) => { o.size = parseVec(v).map((x) => Math.max(0.001, x)); },
  color: (o, v) => { o.color = v === 'none' ? null : parseColor(v); },
  height: (o, v) => { o.height = Math.max(0.3, parseNum(v, 'height in metres')); },
  pose: (o, v) => {
    if (!POSES.includes(v)) throw new CommandError(`pose must be one of ${POSES.join(', ')}`);
    o.pose = v;
  },
  look: (o, v, doc) => {
    if (v === 'none' || v === '') o.look = null;
    else if (v === 'cam' || v === 'camera') o.look = 'cam';
    else if (isVecLike(v)) o.look = parseVec(v);
    else { requireId(doc, v, 'any'); o.look = v; }
  },
  src: (o, v) => { o.src = v; },
};

function setObjectProps(doc, o, kv) {
  for (const [k, v] of Object.entries(kv)) {
    if (k === 'parent') {
      if (v === 'none' || v === '') o.parent = null;
      else {
        requireId(doc, v);
        if (v === o.id) throw new CommandError('an object cannot be its own parent');
        o.parent = v;
      }
    } else if (k === 'face') {
      const target = resolvePoint(doc, v);
      const ev = evaluateScene(doc, 0);
      const here = ev.objects.get(o.id)?.pos || o.pos;
      o.rot = [o.rot[0], round(yawOf(sub(target, here)), 1), o.rot[2]];
    } else if (OBJECT_PROPS[k]) OBJECT_PROPS[k](o, v, doc);
    else throw new CommandError(`unknown property "${k}" for ${o.type}`);
  }
}

const CAMERA_PROPS = {
  name: (c, v) => { c.name = v; },
  fov: (c, v) => { c.fov = Math.min(150, Math.max(5, parseNum(v, 'fov degrees'))); },
  lens: (c, v) => { c.fov = round(fovFromFocal(parseNum(v, 'focal length mm')), 2); },
  at: (c, v) => { c.pos = parseVec(v); },
  pos: (c, v) => { c.pos = parseVec(v); },
  look: (c, v, doc) => { c.target = isVecLike(v) ? parseVec(v) : (requireId(doc, v), v); },
  target: (c, v, doc) => { c.target = isVecLike(v) ? parseVec(v) : (requireId(doc, v), v); },
  roll: (c, v) => { c.roll = parseNum(v, 'roll degrees'); },
  shake: (c, v) => { c.shake = Math.max(0, parseNum(v, 'shake amount 0..1')); },
};

const LIGHT_TYPES = ['sun', 'point', 'spot'];

function applyKey(doc, id, channel, segments) {
  const ent = requireId(doc, id, 'any');
  const isCam = doc.cameras.includes(ent);
  const isLight = doc.lights.includes(ent);
  if (isLight) throw new CommandError('lights cannot be animated');
  const ch = channel === 'look' && isCam ? 'target' : channel;
  const allowed = isCam ? ['pos', 'target', 'fov', 'lens', 'roll'] : ['pos', 'rot', 'yaw', 'scale', 'pose', 'look'];
  if (!allowed.includes(ch)) throw new CommandError(`"${channel}" cannot be keyed on ${isCam ? 'a camera' : ent.type} (use ${allowed.join(', ')})`);
  if (ch === 'pose' && ent.type !== 'mannequin') throw new CommandError('only mannequins have poses');
  ent.keys = ent.keys || {};
  for (const seg of segments) {
    const { pos, kv } = splitKV(seg);
    if (kv.t === undefined) throw new CommandError('each key needs t=<seconds>');
    const t = Math.max(0, parseNum(kv.t, 'time in seconds'));
    const e = parseEase(kv.e ?? kv.ease);
    const valStr = pos[0];
    if (valStr === undefined) throw new CommandError(`key at t=${t} has no value`);
    let track = ch, v;
    switch (ch) {
      case 'pos': case 'rot': case 'scale': v = parseVec(valStr); break;
      case 'yaw': {
        track = 'rot';
        v = [ent.rot[0], parseNum(valStr, 'yaw degrees'), ent.rot[2]];
        break;
      }
      case 'fov': v = parseNum(valStr, 'fov degrees'); break;
      case 'lens': track = 'fov'; v = round(fovFromFocal(parseNum(valStr, 'focal length mm')), 2); break;
      case 'roll': v = parseNum(valStr, 'roll degrees'); break;
      case 'pose':
        if (!POSES.includes(valStr)) throw new CommandError(`pose must be one of ${POSES.join(', ')}`);
        v = valStr;
        break;
      case 'look':
        v = valStr === 'none' ? null : valStr === 'camera' ? 'cam' : isVecLike(valStr) ? parseVec(valStr) : valStr;
        if (typeof v === 'string' && v !== 'cam') requireId(doc, v, 'any');
        break;
      case 'target':
        v = isVecLike(valStr) ? parseVec(valStr) : valStr;
        if (typeof v === 'string') requireId(doc, v);
        break;
    }
    const keys = (ent.keys[track] = (ent.keys[track] || []).filter((k) => Math.abs(k.t - t) > 1e-6));
    const key = { t, v };
    if (e) key.e = e;
    keys.push(key);
    keys.sort((a, b) => a.t - b.t);
  }
}

function deleteEntity(doc, id) {
  const ent = requireId(doc, id, 'any');
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of doc.objects) if (o.parent && doomed.has(o.parent) && !doomed.has(o.id)) { doomed.add(o.id); grew = true; }
  }
  doc.objects = doc.objects.filter((o) => !doomed.has(o.id));
  if (doc.cameras.includes(ent)) {
    if (doc.cameras.length === 1) throw new CommandError('the shot needs at least one camera');
    doc.cameras = doc.cameras.filter((c) => c.id !== id);
    doc.cuts = doc.cuts.filter((c) => c.camera !== id);
    if (!doc.cuts.length) doc.cuts = [{ t: 0, camera: doc.cameras[0].id }];
  }
  doc.lights = doc.lights.filter((l) => l.id !== id);
  // Drop dangling references.
  for (const o of doc.objects) {
    if (typeof o.look === 'string' && doomed.has(o.look)) o.look = null;
    if (o.keys?.look) o.keys.look = o.keys.look.filter((k) => !(typeof k.v === 'string' && doomed.has(k.v)));
  }
  for (const c of doc.cameras) {
    if (typeof c.target === 'string' && doomed.has(c.target)) c.target = [0, 1, 0];
    if (c.keys?.target) c.keys.target = c.keys.target.filter((k) => !(typeof k.v === 'string' && doomed.has(k.v)));
  }
  doc.meta.refs = doc.meta.refs.filter((r) => !doomed.has(r.id));
}

export function applyLine(doc, line, ctx = {}) {
  const text = line.replace(/\s+#.*$/, '').trim();
  if (!text || text.startsWith('#') || text.startsWith('//')) return null;
  const toks = tokenize(text);
  // Split on ';' into segments (used by key and cut).
  const segs = [[]];
  for (const t of toks) {
    if (t === ';') segs.push([]);
    else segs[segs.length - 1].push(t);
  }
  const head = segs[0];
  const verb = raw(head[0]).toLowerCase();
  const rest = head.slice(1);

  switch (verb) {
    case 'duration': {
      const d = parseNum(raw(rest[0]), 'duration in seconds');
      if (d < 1 || d > 60) throw new CommandError('duration must be between 1 and 60 seconds');
      doc.meta.duration = d;
      return { verb };
    }
    case 'fps': {
      const f = parseNum(raw(rest[0]), 'frames per second');
      if (f < 8 || f > 60) throw new CommandError('fps must be between 8 and 60');
      doc.meta.fps = f;
      return { verb };
    }
    case 'size': {
      const m = /^(\d+)x(\d+)$/.exec(raw(rest[0]) || '');
      if (!m) throw new CommandError('size must look like 1280x720');
      const w = +m[1], h = +m[2];
      if (w < 64 || h < 64 || w > 4096 || h > 4096) throw new CommandError('size must be between 64 and 4096 pixels per side');
      doc.meta.width = w;
      doc.meta.height = h;
      return { verb };
    }
    case 'bg': doc.meta.background = parseColor(raw(rest[0])); return { verb };
    case 'name': doc.meta.name = rest.map(raw).join(' '); return { verb };
    case 'look': doc.meta.look = rest.map(raw).join(' '); return { verb };
    case 'audio': doc.meta.audio = rest.map(raw).join(' '); return { verb };
    case 'ref': {
      // ref 1 hero "the hero's costume"   |   ref 2 location "the street"   |   ref clear
      if (raw(rest[0]) === 'clear') { doc.meta.refs = []; return { verb }; }
      const slot = parseNum(raw(rest[0]), 'reference slot number');
      const id = raw(rest[1]);
      if (!id) throw new CommandError('ref needs a slot number and an object id (or "location" / "style")');
      if (!['location', 'style'].includes(id)) requireId(doc, id);
      const label = rest.slice(2).map(raw).join(' ');
      doc.meta.refs = doc.meta.refs.filter((r) => r.slot !== slot);
      doc.meta.refs.push({ slot, id, label });
      doc.meta.refs.sort((a, b) => a.slot - b.slot);
      return { verb };
    }
    case 'add': {
      const { pos, kv } = splitKV(rest);
      const type = (pos[0] || '').toLowerCase();
      const id = pos[1];
      if (!TYPES.includes(type)) throw new CommandError(`unknown type "${pos[0] ?? ''}" (use ${TYPES.join(', ')})`);
      if (!isValidId(id)) throw new CommandError(`"${id ?? ''}" is not a valid id (letters, digits, _ . - ; start with a letter)`);
      if (findAny(doc, id)) throw new CommandError(`"${id}" already exists (use set to change it)`);
      const o = makeObject(type, id, { size: defaultSize(type) });
      doc.objects.push(o);
      setObjectProps(doc, o, kv);
      return { verb, id };
    }
    case 'set': {
      const id = raw(rest[0]);
      const { kv } = splitKV(rest.slice(1));
      const ent = requireId(doc, id, 'any');
      if (doc.cameras.includes(ent)) {
        for (const [k, v] of Object.entries(kv)) {
          if (!CAMERA_PROPS[k]) throw new CommandError(`unknown camera property "${k}"`);
          CAMERA_PROPS[k](ent, v, doc);
        }
      } else if (doc.lights.includes(ent)) setLight(doc, ent, kv);
      else setObjectProps(doc, ent, kv);
      return { verb, id };
    }
    case 'del':
    case 'delete':
    case 'remove':
      for (const id of rest.map(raw)) deleteEntity(doc, id);
      return { verb };
    case 'parent': {
      const [id, p] = rest.map(raw);
      setObjectProps(doc, requireId(doc, id), { parent: p ?? 'none' });
      return { verb, id };
    }
    case 'key': {
      const id = raw(rest[0]);
      const channel = (raw(rest[1]) || '').toLowerCase();
      const first = rest.slice(2);
      applyKey(doc, id, channel, [first, ...segs.slice(1)].filter((s) => s.length));
      return { verb, id };
    }
    case 'clear': {
      const id = raw(rest[0]);
      const ch = (raw(rest[1]) || 'all').toLowerCase();
      const ent = requireId(doc, id, 'any');
      if (ch === 'all') ent.keys = {};
      else if (ent.keys) delete ent.keys[ch === 'yaw' ? 'rot' : ch === 'lens' ? 'fov' : ch === 'look' && doc.cameras.includes(ent) ? 'target' : ch];
      return { verb, id };
    }
    case 'cam':
    case 'camera': {
      const { pos, kv } = splitKV(rest);
      const id = pos[0];
      if (!isValidId(id)) throw new CommandError(`"${id ?? ''}" is not a valid camera id`);
      let cam = findCamera(doc, id);
      if (!cam) {
        if (findAny(doc, id)) throw new CommandError(`"${id}" is already used by an object`);
        cam = makeCamera(id);
        doc.cameras.push(cam);
      }
      for (const [k, v] of Object.entries(kv)) {
        if (!CAMERA_PROPS[k]) throw new CommandError(`unknown camera property "${k}"`);
        CAMERA_PROPS[k](cam, v, doc);
      }
      return { verb, id };
    }
    case 'cut':
    case 'cuts': {
      if (raw(rest[0]) === 'clear') {
        doc.cuts = [{ t: 0, camera: doc.cameras[0].id }];
        return { verb };
      }
      for (const seg of [rest, ...segs.slice(1)].filter((s) => s.length)) {
        const { pos, kv } = splitKV(seg);
        const t = Math.max(0, parseNum(kv.t, 'cut time in seconds'));
        const camId = pos[0];
        requireId(doc, camId, 'camera');
        doc.cuts = doc.cuts.filter((c) => Math.abs(c.t - t) > 1e-6);
        doc.cuts.push({ t, camera: camId });
      }
      doc.cuts.sort((a, b) => a.t - b.t);
      if (doc.cuts[0].t > 0) doc.cuts.unshift({ t: 0, camera: doc.cuts[0].camera });
      return { verb };
    }
    case 'light': {
      const { pos, kv } = splitKV(rest);
      const [type, id] = pos;
      if (!LIGHT_TYPES.includes(type)) throw new CommandError(`light type must be ${LIGHT_TYPES.join(', ')}`);
      if (!isValidId(id)) throw new CommandError(`"${id ?? ''}" is not a valid light id`);
      let l = doc.lights.find((x) => x.id === id);
      if (!l) {
        if (findAny(doc, id)) throw new CommandError(`"${id}" is already used`);
        l = { id, type, pos: [4, 6, 4], target: [0, 0, 0], intensity: type === 'sun' ? 2 : 20, color: '#ffffff' };
        doc.lights.push(l);
      }
      l.type = type;
      setLight(doc, l, kv);
      return { verb, id };
    }
    case 'macro': {
      const { pos, kv } = splitKV(rest);
      const name = (pos[0] || '').toLowerCase();
      const m = MACROS[name];
      if (!m) throw new CommandError(`unknown macro "${pos[0] ?? ''}" (use ${Object.keys(MACROS).join(', ')})`);
      m.run(doc, kv, { parseNum, parseVec, resolvePoint, requireId, CommandError, applyLine: (d, l) => applyLine(d, l, ctx) });
      return { verb, macro: name };
    }
    default:
      throw new CommandError(`unknown command "${verb}"`);
  }
}

function setLight(doc, l, kv) {
  for (const [k, v] of Object.entries(kv)) {
    if (k === 'at' || k === 'pos') l.pos = parseVec(v);
    else if (k === 'look' || k === 'target') l.target = isVecLike(v) ? parseVec(v) : resolvePoint(doc, v);
    else if (k === 'intensity') l.intensity = Math.max(0, parseNum(v, 'intensity'));
    else if (k === 'color') l.color = parseColor(v);
    else throw new CommandError(`unknown light property "${k}"`);
  }
}

// Apply a block of commands. Returns { doc, errors, results }.
// With { atomic: true } (default) a single error discards every change.
export function applyCommands(doc, text, { atomic = true } = {}) {
  const work = clone(doc);
  const errors = [];
  const results = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    try {
      const r = applyLine(work, line);
      if (r) results.push({ line: i + 1, ...r });
    } catch (err) {
      if (err instanceof CommandError) errors.push({ line: i + 1, text: line.trim(), msg: err.message });
      else errors.push({ line: i + 1, text: line.trim(), msg: `internal error: ${err.message}` });
    }
  });
  if (errors.length && atomic) return { doc, errors, results: [] };
  return { doc: work, errors, results };
}

// Pull command lines out of an LLM reply: fenced ```greybox blocks if present, else lines that start with a verb.
const VERBS = /^(add|set|del|delete|remove|parent|key|clear|cam|camera|cut|cuts|light|macro|duration|fps|size|bg|name|look|audio|ref)\b/i;
export function extractCommands(reply) {
  const fences = [...String(reply).matchAll(/```(?:greybox|gbx|commands|text)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const body = fences.length ? fences.join('\n') : String(reply);
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => VERBS.test(l))
    .join('\n');
}

// ---------- serializing (scene -> commands) ----------

const fmtV = (v) => round3(v, 3).join(',');
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

function fmtKeyVal(ch, v) {
  if (Array.isArray(v)) return fmtV(v);
  if (typeof v === 'number') return String(round(v, 3));
  if (v === null) return 'none';
  return String(v);
}

// Compact listing of the scene in its own language. With `maxKeys`, long key tracks are summarised.
export function docToCommands(doc, { maxKeys = Infinity } = {}) {
  const L = [];
  const m = doc.meta;
  L.push(`name ${q(m.name)}`);
  L.push(`duration ${m.duration}`);
  L.push(`fps ${m.fps}`);
  L.push(`size ${m.width}x${m.height}`);
  if (m.look) L.push(`look ${q(m.look)}`);
  if (m.audio) L.push(`audio ${q(m.audio)}`);
  // Parents before children.
  const ordered = [];
  const seen = new Set();
  const visit = (o) => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    if (o.parent) { const p = findObject(doc, o.parent); if (p) visit(p); }
    ordered.push(o);
  };
  doc.objects.forEach(visit);
  for (const o of ordered) {
    const parts = [`add ${o.type} ${o.id}`];
    if (o.name && o.name !== o.id) parts.push(`name=${q(o.name)}`);
    if (o.desc) parts.push(`desc=${q(o.desc)}`);
    if (o.role && o.role !== makeObject(o.type, 'x').role) parts.push(`role=${o.role}`);
    if (o.parent) parts.push(`parent=${o.parent}`);
    if (o.pos.some((x) => x !== 0)) parts.push(`at=${fmtV(o.pos)}`);
    if (o.rot.some((x) => x !== 0)) parts.push(o.rot[0] === 0 && o.rot[2] === 0 ? `yaw=${round(o.rot[1], 1)}` : `rot=${fmtV(o.rot)}`);
    if (o.scale.some((x) => x !== 1)) parts.push(`scale=${fmtV(o.scale)}`);
    if (o.type !== 'mannequin' && o.type !== 'group' && JSON.stringify(o.size) !== JSON.stringify(defaultSize(o.type))) parts.push(`size=${fmtV(o.size)}`);
    if (o.color) parts.push(`color=${o.color}`);
    if (o.type === 'mannequin') {
      if (o.height && o.height !== 1.75) parts.push(`height=${o.height}`);
      if (o.pose && o.pose !== 'stand') parts.push(`pose=${o.pose}`);
      if (o.look) parts.push(`look=${Array.isArray(o.look) ? fmtV(o.look) : o.look}`);
    }
    if (o.src) parts.push(`src=${q(o.src.startsWith('data:') ? '(embedded file)' : o.src)}`);
    L.push(parts.join(' '));
    keyLines(L, o.id, o.keys, maxKeys);
  }
  for (const c of doc.cameras) {
    const tgt = Array.isArray(c.target) ? fmtV(c.target) : c.target;
    let line = `cam ${c.id} at=${fmtV(c.pos)} look=${tgt} lens=${round(focalFromFov(c.fov), 0)}`;
    if (c.name && c.name !== c.id) line += ` name=${q(c.name)}`;
    if (c.roll) line += ` roll=${c.roll}`;
    if (c.shake) line += ` shake=${c.shake}`;
    L.push(line);
    keyLines(L, c.id, c.keys, maxKeys);
  }
  for (const l of doc.lights) L.push(`light ${l.type} ${l.id} at=${fmtV(l.pos)} look=${fmtV(l.target)} intensity=${l.intensity}`);
  if (doc.cuts.length > 1 || doc.cuts[0]?.camera !== doc.cameras[0]?.id) {
    L.push('cut ' + doc.cuts.map((c) => `t=${round(c.t, 3)} ${c.camera}`).join(' ; '));
  }
  for (const r of doc.meta.refs) L.push(`ref ${r.slot} ${r.id}${r.label ? ' ' + q(r.label) : ''}`);
  return L.join('\n');
}

function keyLines(L, id, keys, maxKeys) {
  if (!keys) return;
  for (const [ch, ks] of Object.entries(keys)) {
    if (!ks || !ks.length) continue;
    if (ks.length > maxKeys) {
      const a = ks[0], b = ks[ks.length - 1];
      L.push(`# ${id} ${ch}: ${ks.length} keys from t=${round(a.t, 2)} (${fmtKeyVal(ch, a.v)}) to t=${round(b.t, 2)} (${fmtKeyVal(ch, b.v)})`);
      continue;
    }
    L.push(`key ${id} ${ch} ` + ks.map((k) => `t=${round(k.t, 3)} ${fmtKeyVal(ch, k.v)}${k.e ? ' e=' + k.e : ''}`).join(' ; '));
  }
}

export const _test = { tokenize, splitKV };
