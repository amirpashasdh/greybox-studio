// Procedural mannequin: a 1.75 m reference skeleton driven by a handful of joint angles.
// It exists so that blocking reads as a person in the depth pass and so the pose pass can be
// drawn from exact joint positions instead of being estimated from pixels.
//
// Body space: Y up, character faces +Z, character's LEFT is +X.

import { DEG, add, sub, mul, len, norm, dot, mat4Point, mat4Dir, clamp, lerp, smoothstep } from './math.js';

const REF_HEIGHT = 1.75;
const PELVIS_Y = 0.95;
const HIP_W = 0.09;
const THIGH = 0.44;
const SHIN = 0.43;
const SHOULDER_W = 0.19;
const SPINE = 0.47; // pelvis -> shoulder line
const NECK = 0.05;
const HEAD_UP = 0.15; // neck -> head centre
const UPPER_ARM = 0.28;
const FOREARM = 0.26;

export const POSE_BLEND = 0.35; // seconds to cross-fade between pose keys

const ZERO = {
  lean: 0, twist: 0, pelvis: 0, bob: 0,
  hipL: 0, hipR: 0, kneeL: 0, kneeR: 0,
  shPL: 0, shPR: 0, shRL: 6, shRR: 6, elL: 8, elR: 8,
  headYaw: 0, headPitch: 0, lie: 0,
};

// Joint angles (degrees; pelvis/bob in metres) for a named pose at time t.
export function poseParams(name, t, phase = 0) {
  const p = { ...ZERO };
  const breathe = Math.sin(t * 1.6 + phase);
  switch (name) {
    case 'walk': {
      const ph = (t * 2 * Math.PI) / 1.05 + phase;
      const s = Math.sin(ph);
      p.hipL = 25 * s;
      p.hipR = -25 * s;
      p.kneeL = 6 + 42 * Math.max(0, Math.cos(ph)) ** 1.5;
      p.kneeR = 6 + 42 * Math.max(0, -Math.cos(ph)) ** 1.5;
      p.shPL = -20 * s;
      p.shPR = 20 * s;
      p.elL = 14 + 6 * Math.max(0, -s);
      p.elR = 14 + 6 * Math.max(0, s);
      p.bob = -0.022 * (1 - Math.abs(Math.cos(ph)));
      p.lean = 3;
      break;
    }
    case 'run': {
      const ph = (t * 2 * Math.PI) / 0.68 + phase;
      const s = Math.sin(ph);
      p.hipL = 42 * s;
      p.hipR = -42 * s;
      p.kneeL = 18 + 75 * Math.max(0, Math.cos(ph)) ** 1.2;
      p.kneeR = 18 + 75 * Math.max(0, -Math.cos(ph)) ** 1.2;
      p.shPL = -38 * s;
      p.shPR = 38 * s;
      p.elL = 85;
      p.elR = 85;
      p.shRL = 10;
      p.shRR = 10;
      p.bob = -0.05 * (1 - Math.abs(Math.cos(ph)));
      p.lean = 12;
      break;
    }
    case 'sit':
      p.pelvis = -0.47;
      p.hipL = p.hipR = 90;
      p.kneeL = p.kneeR = 90;
      p.lean = 4 + breathe;
      p.shPL = p.shPR = 32;
      p.elL = p.elR = 48;
      break;
    case 'crouch':
      p.pelvis = -0.42;
      p.hipL = 72;
      p.hipR = 66;
      p.kneeL = 122;
      p.kneeR = 116;
      p.lean = 26;
      p.shPL = p.shPR = 40;
      p.elL = p.elR = 40;
      break;
    case 'talk':
      p.shPR = 26 + 16 * Math.sin(t * 1.7 + phase);
      p.elR = 58 + 22 * Math.sin(t * 2.3 + 1 + phase);
      p.shPL = 14 + 10 * Math.sin(t * 1.3 + 2 + phase);
      p.elL = 42;
      p.headPitch = 4 * Math.sin(t * 2.1 + phase);
      p.headYaw = 6 * Math.sin(t * 0.7 + phase);
      p.bob = 0.004 * breathe;
      break;
    case 'wave':
      p.shRR = 150;
      p.shPR = 12;
      p.elR = 25 + 28 * Math.sin(t * 8 + phase);
      p.headPitch = -4;
      break;
    case 'point':
      p.shPR = 86;
      p.shRR = 8;
      p.elR = 4;
      p.lean = 2;
      break;
    case 'lie':
      p.lie = 1;
      p.shRL = p.shRR = 12;
      break;
    case 'stand':
    default:
      p.bob = 0.004 * breathe;
      p.headPitch = 1.5 * breathe;
      break;
  }
  return p;
}

function blendParams(a, b, w) {
  const out = {};
  for (const k of Object.keys(ZERO)) out[k] = lerp(a[k], b[k], w);
  return out;
}

// Resolve the pose track at time t into blended joint parameters.
export function resolvePose(poseKeys, basePose, t, phase = 0) {
  if (!poseKeys || !poseKeys.length) return poseParams(basePose || 'stand', t, phase);
  const keys = [...poseKeys].sort((a, b) => a.t - b.t);
  let idx = -1;
  for (let i = 0; i < keys.length; i++) if (keys[i].t <= t + 1e-9) idx = i;
  if (idx === -1) return poseParams(keys[0].v, t, phase);
  const cur = keys[idx];
  const prevName = idx > 0 ? keys[idx - 1].v : basePose || 'stand';
  const w = smoothstep(clamp((t - cur.t) / POSE_BLEND, 0, 1));
  if (w >= 1 || prevName === cur.v) return poseParams(cur.v, t, phase);
  return blendParams(poseParams(prevName, t, phase), poseParams(cur.v, t, phase), w);
}

// ---- rotations in body space ----
// Forward pitch: positive swings a downward limb toward +Z.
const pitch = (v, deg) => {
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  return [v[0], v[1] * c + v[2] * s, -v[1] * s + v[2] * c];
};
const yaw = (v, deg) => {
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
};

// Joint positions in body space (reference height) for a parameter set.
export function bodyJoints(p) {
  const J = {};
  const pelvis = [0, PELVIS_Y + p.pelvis + p.bob, 0];
  J.pelvis = pelvis;

  // Legs
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    const hip = add(pelvis, [HIP_W * sx, -0.03, 0]);
    const hipA = side === 'L' ? p.hipL : p.hipR;
    const knA = side === 'L' ? p.kneeL : p.kneeR;
    const knee = add(hip, pitch([0, -THIGH, 0], hipA));
    const ankle = add(knee, pitch([0, -SHIN, 0], hipA - knA));
    const toe = add(ankle, [0, -0.05, 0.15]);
    J['hip' + side] = hip;
    J['knee' + side] = knee;
    J['ankle' + side] = ankle;
    J['toe' + side] = toe;
  }

  // Upper body pivots on the pelvis: lean forward, then twist.
  const upper = (v) => add(pelvis, yaw(pitch(v, -p.lean), p.twist));
  const neckL = [0, SPINE + NECK, 0];
  J.neck = upper(neckL);
  J.chest = upper([0, SPINE * 0.62, 0.02]);

  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    const shL = [SHOULDER_W * sx, SPINE - 0.03, 0];
    const roll = (side === 'L' ? p.shRL : p.shRR) * DEG;
    const fwd = side === 'L' ? p.shPL : p.shPR;
    const elb = side === 'L' ? p.elL : p.elR;
    const down = [sx * Math.sin(roll), -Math.cos(roll), 0];
    const elbowL = add(shL, mul(pitch(down, fwd), UPPER_ARM));
    const wristL = add(elbowL, mul(pitch(down, fwd + elb), FOREARM));
    J['shoulder' + side] = upper(shL);
    J['elbow' + side] = upper(elbowL);
    J['wrist' + side] = upper(wristL);
    J['hand' + side] = upper(add(wristL, mul(norm(pitch(down, fwd + elb)), 0.08)));
  }

  // Head: rotates about the neck.
  // headPitch > 0 tilts the face up.
  const headRot = (v) => upper(add(neckL, yaw(pitch(v, p.headPitch), p.headYaw)));
  J.head = headRot([0, HEAD_UP, 0.01]);
  J.nose = headRot([0, HEAD_UP - 0.01, 0.105]);
  J.eyeL = headRot([0.034, HEAD_UP + 0.025, 0.088]);
  J.eyeR = headRot([-0.034, HEAD_UP + 0.025, 0.088]);
  J.earL = headRot([0.078, HEAD_UP + 0.005, 0]);
  J.earR = headRot([-0.078, HEAD_UP + 0.005, 0]);

  if (p.lie > 0.5) {
    // Lying on the back, head toward -Z, face up.
    for (const k of Object.keys(J)) {
      const [x, y, z] = J[k];
      J[k] = [x, 0.12 + z, -y + 0.1];
    }
  }
  return J;
}

// Limbs used to build the mannequin mesh: [from, to, radius] (reference scale).
export const LIMBS = [
  ['pelvis', 'neck', 0.15],
  ['hipL', 'hipR', 0.1],
  ['shoulderL', 'shoulderR', 0.07],
  ['hipL', 'kneeL', 0.075],
  ['kneeL', 'ankleL', 0.058],
  ['ankleL', 'toeL', 0.045],
  ['hipR', 'kneeR', 0.075],
  ['kneeR', 'ankleR', 0.058],
  ['ankleR', 'toeR', 0.045],
  ['shoulderL', 'elbowL', 0.05],
  ['elbowL', 'wristL', 0.042],
  ['wristL', 'handL', 0.04],
  ['shoulderR', 'elbowR', 0.05],
  ['elbowR', 'wristR', 0.042],
  ['wristR', 'handR', 0.04],
  ['neck', 'head', 0.05],
];
export const HEAD_RADIUS = 0.105;

// Full world-space evaluation for one mannequin.
//   matrix: world matrix of the object (includes yaw and scale)
//   height: character height in metres
//   lookAt: optional world point the head (and, past its limit, the torso) turns toward
export function humanoidJoints({ matrix, height = REF_HEIGHT, poseKeys, basePose, t, lookAt = null, phase = 0 }) {
  const p = resolvePose(poseKeys, basePose, t, phase);
  const s = height / REF_HEIGHT;

  if (lookAt && p.lie < 0.5) {
    // Express the target in body space (undo object matrix), then split the turn between head and torso.
    const neckBody = bodyJoints(p).neck;
    const neckWorld = mat4Point(matrix, mul(neckBody, s));
    const toT = sub(lookAt, neckWorld);
    const fwd = norm(mat4Dir(matrix, [0, 0, 1]));
    const left = norm(mat4Dir(matrix, [1, 0, 0]));
    const up = norm(mat4Dir(matrix, [0, 1, 0]));
    const bx = dot(toT, left), by = dot(toT, up), bz = dot(toT, fwd);
    if (len(toT) > 1e-3) {
      const yawRel = Math.atan2(bx, bz) / DEG;
      const pitchRel = Math.atan2(by, Math.hypot(bx, bz)) / DEG;
      const headMax = 70;
      const twistMax = 45;
      const twist = clamp(Math.sign(yawRel) * Math.max(0, Math.abs(yawRel) - headMax), -twistMax, twistMax);
      p.twist += twist;
      p.headYaw += clamp(yawRel - twist, -headMax, headMax);
      p.headPitch += clamp(pitchRel, -35, 35);
    }
  }

  const J = bodyJoints(p);
  const out = {};
  for (const [k, v] of Object.entries(J)) out[k] = mat4Point(matrix, mul(v, s));
  return { joints: out, params: p, scale: s };
}

// OpenPose BODY_18 ordering (as drawn by ControlNet / controlnet_aux).
export const OPENPOSE_18 = [
  'nose', 'neck',
  'shoulderR', 'elbowR', 'wristR',
  'shoulderL', 'elbowL', 'wristL',
  'hipR', 'kneeR', 'ankleR',
  'hipL', 'kneeL', 'ankleL',
  'eyeR', 'eyeL', 'earR', 'earL',
];
