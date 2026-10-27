// Macros expand one intent into many keys or objects, so the language model never has to do geometry.
// Each macro documents itself; `macroHelp()` turns this into the agent's reference sheet.
//
// Angles around a subject: 0 = in front of it (along its facing direction), +90 = its left side,
// 180 = behind, -90 (or 270) = its right side. Heights are metres above the ground.

import { evaluateScene } from './evaluate.js';
import { DEG, add, sub, mul, len, norm, round, round3, yawOf, rng, fovFromFocal, lerp, EASES, mat4Dir } from './math.js';
import { makeObject, findObject, findCamera, uniqueId } from './schema.js';

const FRAMING = {
  // vertical frame height (metres) to fit around the subject's focus point
  ecu: 0.22, // extreme close-up: eyes/mouth
  closeup: 0.42, // head and shoulders
  mcu: 0.62, // medium close-up: chest up
  medium: 0.95, // waist up
  cowboy: 1.35, // mid-thigh up
  full: 2.2, // whole body
  wide: 5.5, // body in its surroundings
  extreme_wide: 16,
};

function num(ctx, kv, k, def) {
  return kv[k] === undefined ? def : ctx.parseNum(kv[k], k);
}

function getCam(ctx, doc, kv) {
  const id = kv.cam || kv.camera || doc.cameras[0]?.id;
  const cam = findCamera(doc, id);
  if (!cam) throw new ctx.CommandError(`no camera called "${id}"`);
  return cam;
}

// Subject frame at time t: centre point and forward/left directions (horizontal).
function subjectFrame(doc, target, t, ctx) {
  const ev = evaluateScene(doc, t);
  if (typeof target === 'string' && !/^-?[\d.]/.test(target)) {
    const st = ev.objects.get(target);
    if (!st) throw new ctx.CommandError(`no object called "${target}"`);
    let fwd = mat4Dir(st.matrix, [0, 0, 1]);
    fwd = norm([fwd[0], 0, fwd[2]]);
    if (len(fwd) === 0) fwd = [0, 0, 1];
    return { center: st.focus || st.pos, ground: st.pos, fwd, left: [fwd[2], 0, -fwd[0]], id: target };
  }
  const p = ctx.parseVec(target);
  return { center: p, ground: [p[0], 0, p[2]], fwd: [0, 0, 1], left: [1, 0, 0], id: null };
}

// Point on a horizontal circle around a subject. angle 0 = subject's front, +90 = subject's left.
function around(frame, angleDeg, radius, y) {
  const a = angleDeg * DEG;
  const dir = add(mul(frame.fwd, Math.cos(a)), mul(frame.left, Math.sin(a)));
  const p = add(frame.center, mul(dir, radius));
  return [p[0], y, p[2]];
}

function setKeys(ent, track, keys, t0, t1) {
  ent.keys = ent.keys || {};
  const old = (ent.keys[track] || []).filter((k) => k.t < t0 - 1e-6 || k.t > t1 + 1e-6);
  ent.keys[track] = [...old, ...keys].sort((a, b) => a.t - b.t);
}

function sampleSpan(t0, t1, maxStep = 0.25, min = 6) {
  const n = Math.max(min, Math.ceil((t1 - t0) / maxStep));
  return Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n);
}

function timing(ctx, doc, kv) {
  const t0 = num(ctx, kv, 't0', 0);
  const t1 = num(ctx, kv, 't1', doc.meta.duration);
  if (t1 <= t0) throw new ctx.CommandError('t1 must be after t0');
  const ease = kv.e || kv.ease || 'inout';
  if (!EASES[ease]) throw new ctx.CommandError(`unknown ease "${ease}"`);
  return { t0, t1, ease, f: EASES[ease] === EASES.step ? EASES.linear : EASES[ease] };
}

function heightFor(kv, frame, ctx) {
  const h = kv.height;
  if (h === undefined || h === 'eye') return frame.center[1];
  if (h === 'low') return Math.max(0.35, frame.center[1] - 0.9);
  if (h === 'high') return frame.center[1] + 1.4;
  if (h === 'overhead') return frame.center[1] + 4;
  return ctx.parseNum(h, 'height');
}

function distanceFor(cam, kv, ctx) {
  if (kv.radius !== undefined) return ctx.parseNum(kv.radius, 'radius');
  if (kv.dist !== undefined) return ctx.parseNum(kv.dist, 'dist');
  const size = kv.size || kv.framing || 'medium';
  const h = FRAMING[size];
  if (h === undefined) throw new ctx.CommandError(`framing must be one of ${Object.keys(FRAMING).join(', ')}`);
  return h / (2 * Math.tan((cam.fov * DEG) / 2));
}

export const MACROS = {
  frame: {
    help: 'frame cam=<cam> target=<id|x,y,z> size=ecu|closeup|mcu|medium|cowboy|full|wide|extreme_wide angle=<deg> height=eye|low|high|overhead|<m> [lens=<mm>] [t=<s>] — place a camera so the subject fills the frame; keys at t if given',
    run(doc, kv, ctx) {
      const cam = getCam(ctx, doc, kv);
      if (kv.lens) cam.fov = round(fovFromFocal(ctx.parseNum(kv.lens, 'lens')), 2);
      const t = kv.t === undefined ? null : ctx.parseNum(kv.t, 't');
      const target = kv.target || kv.subject;
      if (!target) throw new ctx.CommandError('frame needs target=<id or x,y,z>');
      const frame = subjectFrame(doc, target, t ?? 0, ctx);
      const d = distanceFor(cam, kv, ctx);
      const y = heightFor(kv, frame, ctx);
      // Keep the true distance to the subject when the camera is raised or lowered.
      const dy = y - frame.center[1];
      const horiz = Math.sqrt(Math.max(0.05, d * d - dy * dy));
      const pos = round3(around(frame, num(ctx, kv, 'angle', 0), horiz, y));
      const look = frame.id || round3(frame.center);
      if (t === null) {
        cam.pos = pos;
        cam.target = look;
      } else {
        setKeys(cam, 'pos', [{ t, v: pos, e: kv.e || 'inout' }], t, t);
        setKeys(cam, 'target', [{ t, v: look, e: kv.e || 'inout' }], t, t);
      }
    },
  },

  orbit: {
    help: 'orbit cam=<cam> target=<id|x,y,z> from=<deg> to=<deg> [radius=<m> | size=<framing>] [height=eye|low|high|<m>] [t0 t1] [e=inout] — circle the subject; angles as above, to>from turns toward the subject\'s left',
    run(doc, kv, ctx) {
      const cam = getCam(ctx, doc, kv);
      const target = kv.target || kv.subject;
      if (!target) throw new ctx.CommandError('orbit needs target=<id or x,y,z>');
      const { t0, t1, f } = timing(ctx, doc, kv);
      const a0 = num(ctx, kv, 'from', 0);
      const a1 = num(ctx, kv, 'to', a0 + 180);
      const r = distanceFor(cam, kv, ctx);
      // Orient the circle by the subject's facing at t0 so it does not swing if the subject turns.
      const base = subjectFrame(doc, target, t0, ctx);
      const keys = sampleSpan(t0, t1, 0.25, 8).map((t) => {
        const fr = subjectFrame(doc, target, t, ctx);
        const u = f((t - t0) / (t1 - t0));
        const y = heightFor(kv, fr, ctx);
        return { t: round(t, 4), v: round3(around({ ...fr, fwd: base.fwd, left: base.left }, lerp(a0, a1, u), r, y)), e: 'smooth' };
      });
      setKeys(cam, 'pos', keys, t0, t1);
      cam.target = base.id || round3(base.center);
      if (cam.keys.target) cam.keys.target = cam.keys.target.filter((k) => k.t < t0 || k.t > t1);
    },
  },

  push: {
    help: 'push cam=<cam> target=<id|x,y,z> from=<framing|m> to=<framing|m> [angle=<deg>] [height=...] [t0 t1] [e] — dolly in (or out) along a line toward the subject',
    run(doc, kv, ctx) {
      const cam = getCam(ctx, doc, kv);
      const target = kv.target || kv.subject;
      if (!target) throw new ctx.CommandError('push needs target=<id or x,y,z>');
      const { t0, t1, f } = timing(ctx, doc, kv);
      const dist = (v, def) => (v === undefined ? def : FRAMING[v] !== undefined ? distanceFor(cam, { size: v }, ctx) : ctx.parseNum(v, 'distance'));
      const d0 = dist(kv.from, distanceFor(cam, { size: 'full' }, ctx));
      const d1 = dist(kv.to, distanceFor(cam, { size: 'closeup' }, ctx));
      const angle = num(ctx, kv, 'angle', 0);
      const base = subjectFrame(doc, target, t0, ctx);
      const keys = sampleSpan(t0, t1, 0.5, 4).map((t) => {
        const fr = subjectFrame(doc, target, t, ctx);
        const u = f((t - t0) / (t1 - t0));
        return { t: round(t, 4), v: round3(around({ ...fr, fwd: base.fwd, left: base.left }, angle, lerp(d0, d1, u), heightFor(kv, fr, ctx))), e: 'smooth' };
      });
      setKeys(cam, 'pos', keys, t0, t1);
      cam.target = base.id || round3(base.center);
    },
  },

  crane: {
    help: 'crane cam=<cam> target=<id|x,y,z> from=<height m> to=<height m> [dist=<m> | size=<framing>] [angle=<deg>] [t0 t1] [e] — rise or descend while holding the subject',
    run(doc, kv, ctx) {
      const cam = getCam(ctx, doc, kv);
      const target = kv.target || kv.subject;
      if (!target) throw new ctx.CommandError('crane needs target=<id or x,y,z>');
      const { t0, t1, f } = timing(ctx, doc, kv);
      const h0 = num(ctx, kv, 'from', 0.6);
      const h1 = num(ctx, kv, 'to', 4);
      const d = distanceFor(cam, { ...kv, size: kv.size || 'full' }, ctx);
      const angle = num(ctx, kv, 'angle', 0);
      const base = subjectFrame(doc, target, t0, ctx);
      const keys = sampleSpan(t0, t1, 0.5, 4).map((t) => {
        const fr = subjectFrame(doc, target, t, ctx);
        const u = f((t - t0) / (t1 - t0));
        return { t: round(t, 4), v: round3(around({ ...fr, fwd: base.fwd, left: base.left }, angle, d, lerp(h0, h1, u))), e: 'smooth' };
      });
      setKeys(cam, 'pos', keys, t0, t1);
      cam.target = base.id || round3(base.center);
    },
  },

  follow: {
    help: 'follow cam=<cam> target=<id> [angle=180] [dist=<m> | size=<framing>] [height=...] [t0 t1] — travel with a moving subject at a fixed offset (180 = behind, 0 = leading in front, 90 = alongside on its left)',
    run(doc, kv, ctx) {
      const cam = getCam(ctx, doc, kv);
      const target = kv.target || kv.subject;
      if (!target || !findObject(doc, target)) throw new ctx.CommandError('follow needs target=<object id>');
      const { t0, t1 } = timing(ctx, doc, { ...kv, e: 'linear' });
      const angle = num(ctx, kv, 'angle', 180);
      const d = distanceFor(cam, { ...kv, size: kv.size || 'full' }, ctx);
      const keys = sampleSpan(t0, t1, 0.25, 6).map((t) => {
        const fr = subjectFrame(doc, target, t, ctx);
        return { t: round(t, 4), v: round3(around(fr, angle, d, heightFor(kv, fr, ctx))), e: 'smooth' };
      });
      setKeys(cam, 'pos', keys, t0, t1);
      cam.target = target;
    },
  },

  pan: {
    help: 'pan cam=<cam> from=<id|x,y,z> to=<id|x,y,z> [t0 t1] [e] — camera stays put and turns from one point of interest to another',
    run(doc, kv, ctx) {
      const cam = getCam(ctx, doc, kv);
      const { t0, t1 } = timing(ctx, doc, kv);
      if (!kv.from || !kv.to) throw new ctx.CommandError('pan needs from= and to=');
      const val = (s) => (/^-?[\d.]/.test(s) ? ctx.parseVec(s) : (ctx.requireId(doc, s, 'any'), s));
      setKeys(cam, 'target', [{ t: t0, v: val(kv.from) }, { t: t1, v: val(kv.to), e: kv.e || 'inout' }], t0, t1);
    },
  },

  move: {
    help: 'move cam=<cam> to=<x,y,z> [from=<x,y,z>] [look=<id|x,y,z>] [t0 t1] [e] — straight camera move (dolly, truck or pedestal)',
    run(doc, kv, ctx) {
      const cam = getCam(ctx, doc, kv);
      const { t0, t1 } = timing(ctx, doc, kv);
      if (!kv.to) throw new ctx.CommandError('move needs to=<x,y,z>');
      const ev = evaluateScene(doc, t0);
      const from = kv.from ? ctx.parseVec(kv.from) : round3(ev.cameras.get(cam.id).pos);
      setKeys(cam, 'pos', [{ t: t0, v: from }, { t: t1, v: ctx.parseVec(kv.to), e: kv.e || 'inout' }], t0, t1);
      if (kv.look) cam.target = /^-?[\d.]/.test(kv.look) ? ctx.parseVec(kv.look) : (ctx.requireId(doc, kv.look, 'any'), kv.look);
    },
  },

  zoom: {
    help: 'zoom cam=<cam> from=<mm> to=<mm> [t0 t1] [e] — change focal length over time',
    run(doc, kv, ctx) {
      const cam = getCam(ctx, doc, kv);
      const { t0, t1 } = timing(ctx, doc, kv);
      const f0 = kv.from ? ctx.parseNum(kv.from, 'from mm') : null;
      const f1 = ctx.parseNum(kv.to, 'to mm');
      const v0 = f0 ? round(fovFromFocal(f0), 2) : cam.fov;
      setKeys(cam, 'fov', [{ t: t0, v: v0 }, { t: t1, v: round(fovFromFocal(f1), 2), e: kv.e || 'inout' }], t0, t1);
    },
  },

  walk: {
    help: 'walk who=<mannequin> path=<x,z|x,z|...> [t0 t1] [pose=walk|run] [end=stand|sit|talk|...] — walk through ground points, facing the direction of travel',
    run(doc, kv, ctx) {
      const who = findObject(doc, kv.who || kv.id);
      if (!who || who.type !== 'mannequin') throw new ctx.CommandError('walk needs who=<mannequin id>');
      if (!kv.path) throw new ctx.CommandError('walk needs path=x,z|x,z|...');
      const { t0, t1 } = timing(ctx, doc, { ...kv, e: 'linear' });
      let pts = kv.path.split(/[|\s]+/).filter(Boolean).map((p) => ctx.parseVec(p));
      pts = pts.map((p) => [p[0], p[1] || who.pos[1] || 0, p[2]]);
      const start = round3(evaluateScene(doc, t0).objects.get(who.id).localPos);
      if (len(sub(pts[0], start)) > 0.05) pts.unshift(start);
      if (pts.length < 2) throw new ctx.CommandError('walk path needs at least one point away from the start');
      const segLens = pts.slice(1).map((p, i) => len(sub(p, pts[i])));
      const total = segLens.reduce((a, b) => a + b, 0);
      if (total < 0.05) throw new ctx.CommandError('walk path is too short');
      const gait = kv.pose || 'walk';
      const posKeys = [{ t: t0, v: pts[0] }];
      const yawKeys = [];
      let acc = 0;
      let prevYaw = who.rot[1];
      const turn = Math.min(0.3, (t1 - t0) / (pts.length * 3));
      for (let i = 0; i < segLens.length; i++) {
        const ta = t0 + ((t1 - t0) * acc) / total;
        acc += segLens[i];
        const tb = t0 + ((t1 - t0) * acc) / total;
        posKeys.push({ t: round(tb, 4), v: round3(pts[i + 1]) });
        let y = yawOf(sub(pts[i + 1], pts[i]));
        // Unwrap so the turn takes the short way round.
        while (y - prevYaw > 180) y -= 360;
        while (y - prevYaw < -180) y += 360;
        yawKeys.push({ t: round(Math.max(t0, ta - (i === 0 ? 0 : turn / 2)), 4), v: [who.rot[0], round(prevYaw, 1), who.rot[2]] });
        yawKeys.push({ t: round(Math.min(tb, ta + (i === 0 ? 0.001 : turn / 2)), 4), v: [who.rot[0], round(y, 1), who.rot[2]], e: 'inout' });
        prevYaw = y;
      }
      setKeys(who, 'pos', posKeys, t0, t1);
      setKeys(who, 'rot', dedupe(yawKeys), t0, t1);
      setKeys(who, 'pose', [{ t: t0, v: gait }, { t: t1, v: kv.end || 'stand' }], t0, t1);
    },
  },

  room: {
    help: 'room id=<id> [at=x,y,z] [w=6 d=8 h=3] [door=front|back|left|right|none] — four walls and a floor; the front wall is on +Z',
    run(doc, kv, ctx) {
      const id = kv.id || uniqueId(doc, 'room');
      const at = kv.at ? ctx.parseVec(kv.at) : [0, 0, 0];
      const w = num(ctx, kv, 'w', 6), d = num(ctx, kv, 'd', 8), h = num(ctx, kv, 'h', 3);
      const th = 0.15;
      const door = kv.door || 'front';
      ctx.applyLine(doc, `add group ${id} at=${at.join(',')} desc="a room" name="${id}"`);
      ctx.applyLine(doc, `add box ${id}.floor parent=${id} size=${w},0.02,${d} desc="the floor" role=set`);
      const walls = {
        back: { c: [0, 0, -d / 2], s: [w, h, th], along: 'x' },
        front: { c: [0, 0, d / 2], s: [w, h, th], along: 'x' },
        left: { c: [w / 2, 0, 0], s: [th, h, d], along: 'z' },
        right: { c: [-w / 2, 0, 0], s: [th, h, d], along: 'z' },
      };
      for (const [side, wl] of Object.entries(walls)) {
        if (side === door) {
          const span = wl.along === 'x' ? w : d;
          const dw = Math.min(1.1, span * 0.4), dh = Math.min(2.15, h - 0.2);
          const seg = (span - dw) / 2;
          for (const k of [-1, 1]) {
            const off = k * (dw / 2 + seg / 2);
            const c = wl.along === 'x' ? [off, 0, wl.c[2]] : [wl.c[0], 0, off];
            const s = wl.along === 'x' ? [seg, h, th] : [th, h, seg];
            ctx.applyLine(doc, `add box ${id}.${side}${k < 0 ? 'A' : 'B'} parent=${id} at=${c.map((x) => round(x)).join(',')} size=${s.map((x) => round(x)).join(',')} desc="a wall" role=set`);
          }
          const lc = wl.along === 'x' ? [0, dh, wl.c[2]] : [wl.c[0], dh, 0];
          const ls = wl.along === 'x' ? [dw, h - dh, th] : [th, h - dh, dw];
          ctx.applyLine(doc, `add box ${id}.${side}Top parent=${id} at=${lc.map((x) => round(x)).join(',')} size=${ls.map((x) => round(x)).join(',')} desc="a wall above the doorway" role=set`);
        } else {
          ctx.applyLine(doc, `add box ${id}.${side} parent=${id} at=${wl.c.map((x) => round(x)).join(',')} size=${wl.s.map((x) => round(x)).join(',')} desc="a wall" role=set`);
        }
      }
    },
  },

  street: {
    help: 'street id=<id> [at=x,y,z] [length=40] [width=8] [buildings=yes|no] [lamps=yes|no] [seed=1] — a road along Z with pavements, buildings and lamps on both sides',
    run(doc, kv, ctx) {
      const id = kv.id || uniqueId(doc, 'street');
      const at = kv.at ? ctx.parseVec(kv.at) : [0, 0, 0];
      const L = num(ctx, kv, 'length', 40), W = num(ctx, kv, 'width', 8);
      const side = 3;
      const rand = rng(num(ctx, kv, 'seed', 1));
      ctx.applyLine(doc, `add group ${id} at=${at.join(',')} desc="a street" name="${id}"`);
      ctx.applyLine(doc, `add box ${id}.road parent=${id} size=${W},0.02,${L} desc="the road" role=set`);
      for (const k of [-1, 1]) {
        const sx = k * (W / 2 + side / 2);
        const tag = k < 0 ? 'R' : 'L';
        ctx.applyLine(doc, `add box ${id}.pave${tag} parent=${id} at=${round(sx)},0,0 size=${side},0.15,${L} desc="the pavement" role=set`);
        if (kv.buildings !== 'no') {
          let z = -L / 2;
          let n = 0;
          while (z < L / 2 - 2) {
            const bw = 6 + rand() * 6;
            const bh = 6 + rand() * 16;
            const depth = 8;
            const cz = Math.min(z + bw / 2, L / 2 - bw / 2);
            const bx = k * (W / 2 + side + depth / 2);
            ctx.applyLine(doc, `add building ${id}.b${tag}${++n} parent=${id} at=${round(bx)},0,${round(cz)} yaw=${k < 0 ? 90 : -90} size=${round(bw)},${round(bh)},${depth} desc="a building" role=set`);
            z += bw + 0.4;
          }
        }
        if (kv.lamps !== 'no') {
          for (let z = -L / 2 + 4, i = 0; z < L / 2; z += 12, i++) {
            ctx.applyLine(doc, `add lamp ${id}.lamp${tag}${i + 1} parent=${id} at=${round(k * (W / 2 + 0.6))},0,${round(z)} yaw=${k < 0 ? 90 : -90} role=set`);
          }
        }
      }
    },
  },

  crowd: {
    help: 'crowd id=<id> count=<n> [at=x,y,z] [area=w,d] [pose=stand|walk|talk] [look=cam|<id>] [seed=1] — background people standing around',
    run(doc, kv, ctx) {
      const id = kv.id || uniqueId(doc, 'crowd');
      const at = kv.at ? ctx.parseVec(kv.at) : [0, 0, 0];
      const n = Math.min(40, Math.max(1, Math.round(num(ctx, kv, 'count', 8))));
      const area = kv.area ? kv.area.split(',').map((x) => ctx.parseNum(x, 'area')) : [8, 6];
      const rand = rng(num(ctx, kv, 'seed', 1));
      const pose = kv.pose || 'stand';
      ctx.applyLine(doc, `add group ${id} at=${at.join(',')} desc="a crowd of people" name="${id}"`);
      const placed = [];
      for (let i = 0; i < n; i++) {
        let p;
        for (let tries = 0; tries < 30; tries++) {
          p = [(rand() - 0.5) * area[0], 0, (rand() - 0.5) * area[1]];
          if (placed.every((q) => Math.hypot(q[0] - p[0], q[2] - p[2]) > 0.7)) break;
        }
        placed.push(p);
        const h = 1.6 + rand() * 0.3;
        const look = kv.look ? ` look=${kv.look}` : '';
        ctx.applyLine(doc, `add mannequin ${id}.p${i + 1} parent=${id} at=${round(p[0])},0,${round(p[2])} yaw=${Math.round(rand() * 360 - 180)} height=${round(h, 2)} pose=${pose}${look} desc="a bystander" role=character`);
      }
    },
  },
};

function dedupe(keys) {
  const out = [];
  for (const k of keys.sort((a, b) => a.t - b.t)) {
    if (out.length && Math.abs(out[out.length - 1].t - k.t) < 1e-4) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

export function macroHelp() {
  return Object.entries(MACROS).map(([, m]) => `macro ${m.help}`).join('\n');
}

export { FRAMING };
