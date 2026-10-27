// Scene state at time t. Pure and deterministic: the viewport, the exporter and the linter all call
// this, so what you scrub is exactly what gets rendered.

import {
  EASES, catmull, lerp, lerp3, add, mul, noise1, mat4Compose, mat4Mul, mat4Point,
} from './math.js';
import { humanoidJoints, HEAD_RADIUS } from './humanoid.js';

const isVec = (v) => Array.isArray(v) && v.length === 3;

export function sortedKeys(keys) {
  return keys && keys.length ? [...keys].sort((a, b) => a.t - b.t) : [];
}

// Locate the segment for time t. Returns { i, u } where the segment is keys[i] -> keys[i+1].
function segment(keys, t) {
  if (t <= keys[0].t) return { i: 0, u: 0, before: true };
  const last = keys.length - 1;
  if (t >= keys[last].t) return { i: last, u: 0, after: true };
  for (let i = 0; i < last; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t < b.t) {
      const span = b.t - a.t;
      return { i, u: span > 0 ? (t - a.t) / span : 1 };
    }
  }
  return { i: last, u: 0, after: true };
}

// Interpolate a numeric or vec3 track. `resolve` turns a key value into a number/vec (for id targets).
export function sampleTrack(keys, base, t, resolve = (v) => v) {
  const ks = sortedKeys(keys);
  if (!ks.length) return resolve(base);
  if (ks.length === 1) return resolve(ks[0].v);
  const s = segment(ks, t);
  if (s.before) return resolve(ks[0].v);
  if (s.after) return resolve(ks[ks.length - 1].v);
  const a = ks[s.i], b = ks[s.i + 1];
  const ease = b.e || 'linear';
  if (ease === 'step') return resolve(a.v);
  const u = (EASES[ease] || EASES.linear)(s.u);
  const va = resolve(a.v), vb = resolve(b.v);
  if (typeof va === 'number') return lerp(va, vb, u);
  if (ease === 'smooth') {
    const p0 = resolve(ks[Math.max(0, s.i - 1)].v);
    const p3 = resolve(ks[Math.min(ks.length - 1, s.i + 2)].v);
    return catmull(p0, va, vb, p3, u);
  }
  return lerp3(va, vb, u);
}

// Discrete track (pose names, look targets): the last key at or before t wins.
export function sampleDiscrete(keys, base, t) {
  const ks = sortedKeys(keys);
  let v = base;
  for (const k of ks) if (k.t <= t + 1e-9) v = k.v;
  return v;
}

export function activeCut(doc, t) {
  const cuts = [...doc.cuts].sort((a, b) => a.t - b.t);
  let cur = cuts[0] || null;
  for (const c of cuts) if (c.t <= t + 1e-9) cur = c;
  return cur;
}

// Local bounding box of an object (pivot at bottom centre, except planes which are centred thin slabs).
export function localBox(obj) {
  const [sx, sy, sz] = obj.size || [1, 1, 1];
  if (obj.type === 'plane') return { min: [-sx / 2, 0, -sz / 2], max: [sx / 2, Math.max(sy, 0.01), sz / 2] };
  return { min: [-sx / 2, 0, -sz / 2], max: [sx / 2, sy, sz / 2] };
}

function boxCorners(b) {
  const out = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

function aabbOf(points) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i];
    if (p[i] > max[i]) max[i] = p[i];
  }
  return { min, max };
}

export function evaluateScene(doc, t, opts = {}) {
  const objects = new Map();
  const byId = new Map(doc.objects.map((o) => [o.id, o]));

  // 1. Local transforms and world matrices (parents first, cycle-safe).
  const visiting = new Set();
  const worldOf = (obj) => {
    if (objects.has(obj.id)) return objects.get(obj.id);
    if (visiting.has(obj.id)) return null;
    visiting.add(obj.id);
    const pos = sampleTrack(obj.keys?.pos, obj.pos, t);
    const rot = sampleTrack(obj.keys?.rot, obj.rot, t);
    const scale = sampleTrack(obj.keys?.scale, obj.scale, t);
    let matrix = mat4Compose(pos, rot, scale);
    const parent = obj.parent && byId.get(obj.parent);
    if (parent) {
      const ps = worldOf(parent);
      if (ps) matrix = mat4Mul(ps.matrix, matrix);
    }
    const state = { id: obj.id, type: obj.type, role: obj.role, localPos: pos, rot, scale, matrix, pos: mat4Point(matrix, [0, 0, 0]) };
    objects.set(obj.id, state);
    visiting.delete(obj.id);
    return state;
  };
  for (const o of doc.objects) worldOf(o);

  // 2. Camera positions (targets come later: they may track a mannequin's head).
  const cameras = new Map();
  const shakeOf = (cam, ci) => {
    const f = t * 1.7;
    const n = (k) => noise1(f + k * 17.3, ci + 1) * 0.7 + noise1(f * 2.9 + k * 5.1, ci + 7) * 0.3;
    return { pos: mul([n(0), n(1), n(2)], 0.035 * cam.shake), target: mul([n(3), n(4), n(5)], 0.06 * cam.shake) };
  };
  doc.cameras.forEach((cam, ci) => {
    let pos = sampleTrack(cam.keys?.pos, cam.pos, t);
    const shake = cam.shake > 0 ? shakeOf(cam, ci) : null;
    if (shake) pos = add(pos, shake.pos);
    cameras.set(cam.id, {
      id: cam.id, pos, target: null, shake,
      fov: sampleTrack(cam.keys?.fov, cam.fov, t),
      roll: sampleTrack(cam.keys?.roll, cam.roll || 0, t),
    });
  });
  const cut = activeCut(doc, t);
  const active = cut && cameras.has(cut.camera) ? cut.camera : doc.cameras[0]?.id;

  // 3. Mannequin skeletons, world AABBs and focus points.
  for (const o of doc.objects) {
    const st = objects.get(o.id);
    if (!st) continue;
    if (o.type === 'mannequin') {
      const look = sampleDiscrete(o.keys?.look, o.look, t);
      let lookAt = null;
      if (look === 'cam' || look === 'camera') lookAt = active ? cameras.get(active).pos : null;
      else if (typeof look === 'string' && look) lookAt = cameras.get(look)?.pos || objects.get(look)?.pos || null;
      else if (isVec(look)) lookAt = look;
      const { joints, params } = humanoidJoints({
        matrix: st.matrix, height: o.height || 1.75, poseKeys: o.keys?.pose, basePose: o.pose, t, lookAt, phase: hashPhase(o.id),
      });
      st.joints = joints;
      st.pose = params;
      st.poseName = sampleDiscrete(o.keys?.pose, o.pose || 'stand', t);
      st.look = look;
      const pad = HEAD_RADIUS * (o.height || 1.75) / 1.75;
      const box = aabbOf(Object.values(joints));
      st.aabb = { min: box.min.map((v) => v - pad), max: box.max.map((v) => v + pad) };
      // Feet rest on the object's origin; padding must not push the box below it.
      st.aabb.min[1] = Math.max(box.min[1] - 0.05, Math.min(st.pos[1], box.min[1]));
      // Frame people on the upper chest / face, the way an operator would.
      st.focus = [joints.neck[0], lerp(joints.chest[1], joints.head[1], 0.7), joints.neck[2]];
    } else if (o.type === 'group') {
      st.focus = st.pos;
    } else {
      st.aabb = aabbOf(boxCorners(localBox(o)).map((p) => mat4Point(st.matrix, p)));
      st.focus = mul(add(st.aabb.min, st.aabb.max), 0.5);
    }
  }
  // Groups: AABB of their children.
  for (const o of doc.objects) {
    if (o.type !== 'group') continue;
    const kids = doc.objects.filter((c) => c.parent === o.id).map((c) => objects.get(c.id)?.aabb).filter(Boolean);
    const st = objects.get(o.id);
    if (kids.length && st) {
      st.aabb = aabbOf(kids.flatMap((b) => [b.min, b.max]));
      st.focus = mul(add(st.aabb.min, st.aabb.max), 0.5);
    }
  }

  // 4. Camera targets.
  const resolveTarget = (v) => {
    if (isVec(v)) return v;
    if (typeof v === 'string') {
      const st = objects.get(v);
      if (st && st.focus) return st.focus;
    }
    return [0, 1, 0];
  };
  doc.cameras.forEach((cam) => {
    const c = cameras.get(cam.id);
    let target = sampleTrack(cam.keys?.target, cam.target, t, resolveTarget);
    if (c.shake) target = add(target, c.shake.target);
    c.target = target;
    delete c.shake;
  });

  return { t, objects, cameras, active, cut };
}

function hashPhase(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
}

// Times at which to sample the shot for analysis.
export function sampleTimes(doc, step = 0.25) {
  const out = [];
  const d = Math.max(0.01, doc.meta.duration);
  for (let t = 0; t < d - 1e-6; t += step) out.push(t);
  out.push(d);
  return out;
}

// Number of frames and the time of each frame, for a given fps.
export function frameTimes(duration, fps) {
  const n = Math.max(1, Math.round(duration * fps));
  return Array.from({ length: n }, (_, i) => i / fps);
}

export const _internal = { aabbOf, boxCorners };
