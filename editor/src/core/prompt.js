// Shot description from scene data. The camera move, framing and blocking are read off the
// evaluated scene, so the prompt says what the control video actually shows.
//
// analyzeShot(doc) -> structured facts per cut
// buildPrompts(doc) -> { generic, h3, wan, ltx } ready-to-edit prompt strings

import { evaluateScene, sortedKeys } from './evaluate.js';
import { project, dist, sub, focalFromFov, yawOf, round, DEG } from './math.js';
import { FRAMING } from './macros.js';

const label = (o) => {
  if (!o) return 'the subject';
  if (o.desc) return o.desc;
  if (o.name && o.name !== o.id) return o.name;
  return o.type === 'mannequin' ? 'a person' : `a ${o.type}`;
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const theify = (s) => s.replace(/^(a|an) /i, 'the ');
const sec = (t) => `${round(t, 1)}s`;

function framingName(frameHeight) {
  let best = 'medium', bestErr = Infinity;
  for (const [name, h] of Object.entries(FRAMING)) {
    const err = Math.abs(Math.log(frameHeight / h));
    if (err < bestErr) { best = name; bestErr = err; }
  }
  return {
    ecu: 'extreme close-up', closeup: 'close-up', mcu: 'medium close-up', medium: 'medium shot',
    cowboy: 'medium-wide shot', full: 'full shot', wide: 'wide shot', extreme_wide: 'extreme wide shot',
  }[best];
}

function screenThird(x) {
  if (x < 0.38) return 'frame left';
  if (x > 0.62) return 'frame right';
  return 'centre frame';
}

function unwrapSweep(angles) {
  let total = 0;
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    total += d;
  }
  return total;
}

// Choose the subject of a segment: the character that spends the most time near the centre of frame.
function pickSubject(doc, evs, aspect) {
  const chars = doc.objects.filter((o) => o.role === 'character' && !o.parent);
  const pool = chars.length ? chars : doc.objects.filter((o) => o.role === 'prop');
  let best = null, bestScore = -1;
  for (const o of pool) {
    let score = 0;
    for (const ev of evs) {
      const cam = ev.cameras.get(ev.active);
      const st = ev.objects.get(o.id);
      if (!st?.focus) continue;
      const p = project(cam, st.focus, aspect);
      if (!p.inFront || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue;
      score += 1 - Math.hypot(p.x - 0.5, p.y - 0.5);
    }
    if (score > bestScore) { best = o; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

export function analyzeShot(doc) {
  const aspect = doc.meta.width / doc.meta.height;
  const cuts = [...doc.cuts].sort((a, b) => a.t - b.t).filter((c) => c.t < doc.meta.duration - 1e-3);
  const segments = cuts.map((c, i) => ({ camera: c.camera, t0: c.t, t1: i + 1 < cuts.length ? cuts[i + 1].t : doc.meta.duration }));

  return segments.map((seg, index) => {
    const n = 12;
    const times = Array.from({ length: n + 1 }, (_, i) => seg.t0 + ((seg.t1 - seg.t0 - 1e-4) * i) / n);
    const evs = times.map((t) => evaluateScene(doc, t));
    const cams = evs.map((ev) => ev.cameras.get(seg.camera));
    const subject = pickSubject(doc, evs, aspect);
    const camDef = doc.cameras.find((c) => c.id === seg.camera);

    const lens0 = focalFromFov(cams[0].fov), lens1 = focalFromFov(cams[n].fov);
    const moves = [];
    const travel = dist(cams[0].pos, cams[n].pos);
    let framing0 = null, framing1 = null, angleLabel = 'eye level', subjectActs = [];

    if (subject) {
      const sts = evs.map((ev) => ev.objects.get(subject.id));
      const d = cams.map((c, i) => dist(c.pos, sts[i].focus));
      framing0 = framingName(2 * d[0] * Math.tan((cams[0].fov * DEG) / 2));
      framing1 = framingName(2 * d[n] * Math.tan((cams[n].fov * DEG) / 2));
      const az = cams.map((c, i) => yawOf(sub(c.pos, sts[i].focus)));
      const sweep = unwrapSweep(az);
      const subjMoved = dist(sts[0].pos, sts[n].pos);
      const ratio = d[n] / Math.max(0.01, d[0]);
      const dy = cams[n].pos[1] - cams[0].pos[1];
      const rel = cams[0].pos[1] - sts[0].focus[1];
      angleLabel = rel < -0.45 ? 'low angle looking up' : rel > 1.8 ? 'high angle looking down' : rel > 0.6 ? 'slightly high angle' : 'eye level';

      // Only call it a camera move when the camera itself travels; a subject walking toward a
      // locked-off camera changes the distance too, but that is blocking, not a push in.
      const camMoves = travel > 0.25;
      if (camMoves && Math.abs(sweep) > 25 && ratio > 0.6 && ratio < 1.6) {
        // Azimuth increasing (atan2(x, z)) means the camera travels toward its own right.
        moves.push(`${Math.abs(sweep) > 300 ? 'a full 360-degree' : `a ${Math.round(Math.abs(sweep))}-degree`} orbit, the camera arcing to the ${sweep > 0 ? 'right' : 'left'} around ${theify(label(subject))}`);
      } else if (camMoves && subjMoved > 0.8 && Math.abs(Math.log(ratio)) < 0.35) {
        moves.push(`a tracking shot travelling with ${theify(label(subject))}`);
      } else if (camMoves && ratio < 0.75) {
        moves.push(`a ${ratio < 0.4 ? 'strong' : 'slow'} push in toward ${theify(label(subject))}`);
      } else if (camMoves && ratio > 1.33) {
        moves.push(`a ${ratio > 2.5 ? 'big' : 'slow'} pull back away from ${theify(label(subject))}`);
      }
      if (Math.abs(dy) > 0.8) moves.push(dy > 0 ? 'the camera cranes up' : 'the camera cranes down');

      // Subject action.
      const keys = sortedKeys(doc.objects.find((o) => o.id === subject.id).keys?.pose).filter((k) => k.t >= seg.t0 && k.t < seg.t1);
      const startPose = sts[0].poseName;
      const gait = startPose === 'walk' || startPose === 'run';
      if (startPose && startPose !== 'stand' && !(gait && subjMoved > 0.5)) subjectActs.push(poseVerb(startPose, true));
      for (const k of keys) if (k.t > seg.t0 + 0.05) subjectActs.push(`at ${sec(k.t)} ${poseVerb(k.v, false)}`);
      if (subjMoved > 0.5) {
        const p0 = project(cams[0], sts[0].focus, aspect), p1 = project(cams[0], sts[n].focus, aspect);
        const dx = p1.x - p0.x;
        const towards = d[n] < d[0] - 0.6, away = d[n] > d[0] + 0.6;
        let dir;
        if (Math.abs(dx) > 0.25 && !(towards || away)) dir = dx > 0 ? 'from frame left to frame right' : 'from frame right to frame left';
        else if (towards) dir = 'toward the camera';
        else if (away) dir = 'away from the camera';
        else dir = 'across the space';
        subjectActs.unshift(`${gait ? poseVerb(startPose, true) : 'moves'} ${dir}`);
      }
      const look = sts.some((s) => s.look === 'cam');
      if (look) subjectActs.push('keeps looking into the lens');
    }

    if (!moves.length) {
      const t0 = cams[0].target, t1 = cams[n].target;
      const yaw0 = yawOf(sub(t0, cams[0].pos)), yaw1 = yawOf(sub(t1, cams[n].pos));
      let dyaw = yaw1 - yaw0;
      while (dyaw > 180) dyaw -= 360;
      while (dyaw < -180) dyaw += 360;
      const pitch = (c) => Math.atan2(c.target[1] - c.pos[1], Math.hypot(c.target[0] - c.pos[0], c.target[2] - c.pos[2])) / DEG;
      const dp = pitch(cams[n]) - pitch(cams[0]);
      if (travel > 0.6) moves.push('a smooth camera move');
      if (Math.abs(dyaw) > 10) moves.push(`a pan to the ${dyaw > 0 ? 'left' : 'right'}`);
      if (Math.abs(dp) > 8) moves.push(`a tilt ${dp > 0 ? 'up' : 'down'}`);
    }
    if (Math.abs(lens1 - lens0) / lens0 > 0.15) moves.push(`a ${lens1 > lens0 ? 'zoom in' : 'zoom out'} from ${Math.round(lens0)}mm to ${Math.round(lens1)}mm`);
    const handheld = camDef?.shake > 0.05;

    // Layout at the start of the segment: visible labelled things and where they sit in frame.
    const layout = [];
    const ev0 = evs[0];
    for (const o of doc.objects) {
      if (o.id === subject?.id || o.type === 'group' || o.type === 'plane' || !o.desc || o.parent && !o.desc) continue;
      const st = ev0.objects.get(o.id);
      if (!st?.focus) continue;
      const p = project(cams[0], st.focus, aspect);
      if (!p.inFront || p.x < -0.05 || p.x > 1.05 || p.y < -0.1 || p.y > 1.1) continue;
      const sd = subject ? dist(cams[0].pos, ev0.objects.get(subject.id).focus) : 4;
      const depth = p.depth < sd * 0.7 ? 'foreground' : p.depth > sd * 1.4 ? 'background' : null;
      layout.push({ id: o.id, label: label(o), third: screenThird(p.x), where: `${screenThird(p.x)}${depth ? ` in the ${depth}` : ''}`, role: o.role });
    }
    const subjPos = subject ? project(cams[0], ev0.objects.get(subject.id).focus, aspect) : null;

    return {
      index, camera: seg.camera, t0: seg.t0, t1: seg.t1,
      lens: Math.round(lens0), lensEnd: Math.round(lens1),
      framing: framing0, framingEnd: framing1, angle: angleLabel,
      moves, handheld, static: !moves.length,
      subject: subject ? { id: subject.id, label: label(subject), where: subjPos ? screenThird(subjPos.x) : null } : null,
      actions: subjectActs,
      layout: dedupeLayout(layout).slice(0, 5),
    };
  });
}

// Group repeated things ("a building" x 5) into one phrase and keep the list short: people and props
// first, then the most visible set pieces.
function dedupeLayout(items) {
  const groups = new Map();
  for (const it of items) {
    const g = groups.get(it.label) || { label: it.label, role: it.role, where: [], thirds: new Set(), n: 0 };
    g.n++;
    g.where.push(it.where);
    g.thirds.add(it.third);
    groups.set(it.label, g);
  }
  const plural = (l) => l.replace(/^(a|an|the) /i, '').replace(/([^s])$/, '$1s');
  const order = { character: 0, prop: 1, set: 2 };
  return [...groups.values()]
    .sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3))
    .map((g) => {
      if (g.n === 1) return { role: g.role, text: `${g.label} at ${g.where[0]}` };
      const t = g.thirds;
      const where = t.has('frame left') && t.has('frame right') ? 'on both sides of the frame' : `at ${[...t].join(' and ')}`;
      return { role: g.role, text: `${plural(g.label)} ${where}` };
    });
}

function poseVerb(p, initial) {
  const m = {
    walk: initial ? 'walks' : 'starts walking',
    run: initial ? 'runs' : 'breaks into a run',
    sit: initial ? 'is seated' : 'sits down',
    talk: initial ? 'talks, gesturing with the hands' : 'starts talking, gesturing with the hands',
    wave: initial ? 'waves' : 'waves',
    point: initial ? 'points ahead' : 'points ahead',
    crouch: initial ? 'crouches low' : 'crouches down',
    lie: initial ? 'lies on the ground' : 'lies down',
    stand: initial ? 'stands' : 'comes to a stop and stands',
  };
  return m[p] || p;
}

function cameraSentence(s) {
  const lens = s.lensEnd !== s.lens ? `${s.lens}mm` : `${s.lens}mm lens`;
  const fr = s.framing ? (s.framingEnd && s.framingEnd !== s.framing ? `${s.framing} ending as a ${s.framingEnd}` : s.framing) : 'shot';
  let out = `${cap(fr)}, ${s.angle}, ${lens}`;
  if (s.moves.length) out += `; ${s.moves.join(', then ')}`;
  else out += '; locked-off static camera';
  if (s.handheld) out += ', handheld with natural sway';
  return out + '.';
}

function subjectSentence(s, introduced = false) {
  if (!s.subject) return '';
  const who = cap(introduced ? theify(s.subject.label) : s.subject.label);
  const acts = s.actions.length ? s.actions.join(', ') : 'holds position';
  return `${who}${s.subject.where ? ` (${s.subject.where})` : ''} ${acts}.`;
}

function layoutSentence(s) {
  if (!s.layout.length) return '';
  return `In frame: ${s.layout.map((l) => l.text).join('; ')}.`;
}

function refLines(doc, style) {
  const refs = [...doc.meta.refs].sort((a, b) => a.slot - b.slot);
  return refs.map((r, i) => {
    const o = doc.objects.find((x) => x.id === r.id);
    const what = r.id === 'location' ? 'the location and set dressing' : r.id === 'style' ? 'the visual style' : `${theify(label(o))}`;
    const tag = style === 'h3' ? `<Picture ${i + 1}>` : `reference image ${i + 1}`;
    return `${tag} is ${what}${r.label ? ` (${r.label})` : ''}`;
  });
}

export function buildPrompts(doc, shots = analyzeShot(doc)) {
  const look = doc.meta.look ? cap(doc.meta.look.replace(/\.$/, '')) + '.' : '';
  const audio = doc.meta.audio ? doc.meta.audio.replace(/\.$/, '') + '.' : 'Natural ambient sound, no music.';
  const multi = shots.length > 1;
  const refs = refLines(doc, 'h3');
  const refsPlain = refLines(doc, 'plain');

  // Introduce a subject once ("a woman in..."), then refer back to it ("the woman in...").
  const seenSubjects = new Set();
  const subj = (s) => {
    const first = s.subject && !seenSubjects.has(s.subject.id);
    if (s.subject) seenSubjects.add(s.subject.id);
    return subjectSentence(s, !first);
  };
  const lower = (x) => (x ? x[0].toLowerCase() + x.slice(1) : x);
  const shotText = (s) => [subj(s), cameraSentence(s), layoutSentence(s)].filter(Boolean).join(' ');

  // Generic: readable by any model, also the base for LLM polishing.
  const generic = [
    look,
    ...shots.map((s) => (multi ? `Shot ${s.index + 1} (${sec(s.t0)}-${sec(s.t1)}): ` : '') + shotText(s)),
    refsPlain.length ? `References: ${refsPlain.join('; ')}.` : '',
    `Audio: ${audio}`,
  ].filter(Boolean).join('\n');

  seenSubjects.clear();
  // MiniMax H3: references by <Picture N> tag, timestamped beats, explicit Camera / Audio / Negative lines.
  const h3 = [
    [look, refs.length ? `${refs.map(cap).join('. ')}.` : ''].filter(Boolean).join(' '),
    ...shots.map((s) => `${multi ? `CUT ${s.index + 1} ` : ''}[${sec(s.t0)}-${sec(s.t1)}] ${subj(s) || ''} ${layoutSentence(s)}`.replace(/\s+/g, ' ').trim()),
    `Camera: ${shots.map((s) => cameraSentence(s).replace(/\.$/, '')).join(' / ')}.`,
    `Audio: ${audio}`,
    `Negative: no text overlays, no extra people, no ${multi ? 'transitions other than the hard cuts' : 'cuts'}.`,
  ].filter(Boolean).join('\n');

  // Wan (VACE): one flowing present-tense paragraph; identity comes from the reference image.
  const wanSubj = shots.map((s) => subjectSentence(s)).filter(Boolean)[0] || '';
  seenSubjects.clear();
  const wan = [
    wanSubj,
    shots.map((s) => cameraSentence(s)).join(' '),
    shots.flatMap((s) => s.layout.map((l) => l.text)).slice(0, 4).length ? `The scene includes ${shots.flatMap((s) => s.layout.map((l) => l.text)).slice(0, 4).join(', ')}.` : '',
    look,
  ].filter(Boolean).join(' ');

  seenSubjects.clear();
  // LTX-2: chronological paragraph that leads with the action, then camera, then sound (LTX makes audio).
  const ltx = [
    look,
    ...shots.map((s) => {
      const body = `${subj(s)} ${cameraSentence(s)} ${layoutSentence(s)}`.replace(/\s+/g, ' ').trim();
      return multi ? `From ${sec(s.t0)} to ${sec(s.t1)}, ${lower(body)}` : body;
    }),
    `Sound: ${audio}`,
  ].filter(Boolean).join(' ');

  return { generic, h3, wan, ltx };
}
