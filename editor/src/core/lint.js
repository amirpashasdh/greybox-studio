// Scene checks. Errors are things the render will visibly get wrong (camera inside a wall);
// warnings are probably-unintended blocking (a character never on screen).
// The agent receives these after every edit and gets one chance to fix errors.

import { evaluateScene, sampleTimes } from './evaluate.js';
import { project, dist, round } from './math.js';

const inside = (p, b, pad = 0) =>
  p[0] > b.min[0] - pad && p[0] < b.max[0] + pad &&
  p[1] > b.min[1] - pad && p[1] < b.max[1] + pad &&
  p[2] > b.min[2] - pad && p[2] < b.max[2] + pad;

const overlapXZ = (a, b, shrink = 0) =>
  a.min[0] + shrink < b.max[0] && a.max[0] - shrink > b.min[0] &&
  a.min[2] + shrink < b.max[2] && a.max[2] - shrink > b.min[2] &&
  a.min[1] < b.max[1] && a.max[1] > b.min[1] + 0.05;

const isSolid = (o) => o.type !== 'group' && o.type !== 'plane' && !(o.size && o.size[1] < 0.05);

export function lintScene(doc, { step = 0.25 } = {}) {
  const issues = [];
  const add = (level, code, msg, extra = {}) => {
    if (!issues.some((i) => i.code === code && i.id === extra.id && i.with === extra.with)) issues.push({ level, code, msg, ...extra });
  };
  const aspect = doc.meta.width / doc.meta.height;
  const dur = doc.meta.duration;
  const characters = doc.objects.filter((o) => o.role === 'character');
  const solids = doc.objects.filter(isSolid);

  // Static checks.
  for (const ent of [...doc.objects, ...doc.cameras]) {
    for (const [ch, ks] of Object.entries(ent.keys || {})) {
      const late = (ks || []).filter((k) => k.t > dur + 1e-6);
      if (late.length) add('warn', 'key-after-end', `${ent.id} has ${ch} keys after the shot ends (${dur}s); they never play`, { id: ent.id });
    }
  }
  for (const c of doc.cuts) {
    if (!doc.cameras.some((cam) => cam.id === c.camera)) add('error', 'cut-missing-camera', `cut at ${c.t}s uses missing camera ${c.camera}`);
    if (c.t > dur) add('warn', 'cut-after-end', `cut at ${c.t}s is after the shot ends`);
  }
  if (!characters.length && doc.objects.filter((o) => o.role === 'prop').length === 0) {
    add('warn', 'empty', 'the shot has no characters or props yet');
  }
  if (doc.meta.duration * doc.meta.fps > 900) add('warn', 'long', 'more than 900 frames; most video models top out around 10-15 s');

  const seen = new Map(characters.map((c) => [c.id, false]));
  const camBelow = new Set();

  for (const t of sampleTimes(doc, step)) {
    const ev = evaluateScene(doc, t);
    const cam = ev.cameras.get(ev.active);
    if (!cam) continue;
    const tt = round(t, 2);

    if (cam.pos[1] < 0.05 && !camBelow.has(cam.id)) {
      camBelow.add(cam.id);
      add('error', 'camera-below-ground', `camera ${cam.id} goes below the ground at ${tt}s`, { id: cam.id, t: tt });
    }
    if (dist(cam.pos, cam.target) < 0.2) add('warn', 'camera-target-close', `camera ${cam.id} is almost on top of its look target at ${tt}s`, { id: cam.id, t: tt });

    for (const o of solids) {
      const st = ev.objects.get(o.id);
      if (!st?.aabb) continue;
      if (o.type !== 'mannequin' && inside(cam.pos, st.aabb, 0.05)) {
        add('error', 'camera-inside', `camera ${cam.id} is inside ${o.id} at ${tt}s`, { id: cam.id, with: o.id, t: tt });
      }
      if (o.type === 'mannequin' && inside(cam.pos, st.aabb, -0.02)) {
        add('error', 'camera-inside', `camera ${cam.id} passes through ${o.id} at ${tt}s`, { id: cam.id, with: o.id, t: tt });
      }
      if (t === 0 && st.aabb.min[1] < -0.05 && !o.parent) {
        add(o.role === 'character' ? 'error' : 'warn', 'below-ground', `${o.id} sits ${round(-st.aabb.min[1], 2)} m below the ground`, { id: o.id });
      }
    }

    for (const c of characters) {
      const st = ev.objects.get(c.id);
      if (!st?.focus) continue;
      const p = project(cam, st.focus, aspect);
      if (p.inFront && p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98) seen.set(c.id, true);
      // Characters walking through props or walls.
      for (const o of solids) {
        if (o.id === c.id || (o.type === 'mannequin' && o.id < c.id)) continue;
        const os = ev.objects.get(o.id);
        if (!os?.aabb || !st.aabb) continue;
        if (o.type === 'mannequin') {
          const d = Math.hypot(st.pos[0] - os.pos[0], st.pos[2] - os.pos[2]);
          if (d < 0.35) add('warn', 'characters-overlap', `${c.id} and ${o.id} occupy the same spot at ${tt}s`, { id: c.id, with: o.id, t: tt });
        } else if (os.aabb.max[1] - os.aabb.min[1] > 0.3 && overlapXZ(st.aabb, os.aabb, 0.12)) {
          const seated = st.poseName === 'sit' || st.poseName === 'lie';
          if (!seated) add('warn', 'walks-through', `${c.id} intersects ${o.id} at ${tt}s`, { id: c.id, with: o.id, t: tt });
        }
      }
    }
  }

  for (const [id, ok] of seen) {
    if (!ok) add('warn', 'never-in-frame', `${id} is never in frame`, { id });
  }
  return issues;
}

export function formatIssues(issues) {
  if (!issues.length) return 'no issues';
  return issues.map((i) => `${i.level}: ${i.msg}`).join('\n');
}
