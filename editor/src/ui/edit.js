// One rule for every manual edit (gizmo, inspector, "set from view"):
// if the channel is already animated, write a key at the playhead; otherwise change the base value.
// "Key" (K) always writes a key, which is how a channel becomes animated in the first place.

import { findAny, round, round3 } from '../core/index.js';

const BASE_FIELD = { pos: 'pos', rot: 'rot', scale: 'scale', target: 'target', fov: 'fov', roll: 'roll', pose: 'pose', look: 'look' };

const tidy = (v) => (Array.isArray(v) ? round3(v, 4) : typeof v === 'number' ? round(v, 4) : v);

export function isAnimated(ent, channel) {
  return !!ent?.keys?.[channel]?.length;
}

export function upsertKey(ent, channel, t, v, ease) {
  ent.keys = ent.keys || {};
  const keys = (ent.keys[channel] = ent.keys[channel] || []);
  const existing = keys.find((k) => Math.abs(k.t - t) < 1e-4);
  if (existing) existing.v = tidy(v);
  else {
    const key = { t: round(t, 4), v: tidy(v) };
    const e = ease ?? keys.find((k) => k.t < t)?.e ?? (channel === 'pose' || channel === 'look' ? undefined : 'inout');
    if (e) key.e = e;
    keys.push(key);
    keys.sort((a, b) => a.t - b.t);
  }
}

export function writeChannel(doc, id, channel, value, t, { forceKey = false } = {}) {
  const ent = findAny(doc, id);
  if (!ent) return;
  if (forceKey || isAnimated(ent, channel)) upsertKey(ent, channel, t, value);
  else ent[BASE_FIELD[channel] || channel] = tidy(value);
}

// Write keys for every transform channel of an entity at time t, from its evaluated state.
export function keyAll(doc, id, ev, t) {
  const ent = findAny(doc, id);
  if (!ent) return;
  if (doc.cameras.includes(ent)) {
    const c = ev.cameras.get(id);
    upsertKey(ent, 'pos', t, c.pos);
    upsertKey(ent, 'target', t, typeof ent.target === 'string' && !isAnimated(ent, 'target') ? ent.target : c.target);
    upsertKey(ent, 'fov', t, c.fov);
    return;
  }
  const st = ev.objects.get(id);
  if (!st) return;
  upsertKey(ent, 'pos', t, st.localPos);
  upsertKey(ent, 'rot', t, st.rot);
  if (ent.scale.some((s) => s !== 1) || isAnimated(ent, 'scale')) upsertKey(ent, 'scale', t, st.scale);
}

export function deleteKey(doc, id, channel, t) {
  const ent = findAny(doc, id);
  if (!ent?.keys?.[channel]) return;
  ent.keys[channel] = ent.keys[channel].filter((k) => Math.abs(k.t - t) > 1e-4);
  if (!ent.keys[channel].length) delete ent.keys[channel];
}

export function moveKey(doc, id, channel, fromT, toT) {
  const ent = findAny(doc, id);
  const keys = ent?.keys?.[channel];
  if (!keys) return;
  const k = keys.find((x) => Math.abs(x.t - fromT) < 1e-4);
  if (!k) return;
  const clash = keys.find((x) => x !== k && Math.abs(x.t - toT) < 1e-4);
  if (clash) keys.splice(keys.indexOf(clash), 1);
  k.t = round(Math.max(0, toT), 4);
  keys.sort((a, b) => a.t - b.t);
}
