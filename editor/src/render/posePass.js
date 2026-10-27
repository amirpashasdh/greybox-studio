// OpenPose BODY_18 rendering from exact joint positions.
// Colours and limb order follow the convention used by ControlNet / controlnet_aux draw_bodypose,
// which is what pose-conditioned video models were trained on.

import * as THREE from 'three';
import { OPENPOSE_18, project, sub, dot, norm } from '../core/index.js';

// 1-based pairs, as in the reference implementation. The last two (shoulder-ear) are not drawn there either.
const LIMB_SEQ = [
  [2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11],
  [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18],
];
const COLORS = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
  [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];

const FACE = new Set(['nose', 'eyeL', 'eyeR', 'earL', 'earR']);

// Bone-name candidates for imported GLB characters (Mixamo first, then common game rigs).
const BONE_MAP = {
  neck: ['neck', 'neck_01', 'neck1'],
  head: ['head'],
  shoulderL: ['leftarm', 'upperarm_l', 'l_upperarm', 'arm_l', 'upper_arm.l'],
  elbowL: ['leftforearm', 'lowerarm_l', 'l_forearm', 'forearm_l', 'forearm.l'],
  wristL: ['lefthand', 'hand_l', 'l_hand', 'hand.l'],
  shoulderR: ['rightarm', 'upperarm_r', 'r_upperarm', 'arm_r', 'upper_arm.r'],
  elbowR: ['rightforearm', 'lowerarm_r', 'r_forearm', 'forearm_r', 'forearm.r'],
  wristR: ['righthand', 'hand_r', 'r_hand', 'hand.r'],
  hipL: ['leftupleg', 'thigh_l', 'l_thigh', 'thigh.l'],
  kneeL: ['leftleg', 'calf_l', 'l_calf', 'shin.l'],
  ankleL: ['leftfoot', 'foot_l', 'l_foot', 'foot.l'],
  hipR: ['rightupleg', 'thigh_r', 'r_thigh', 'thigh.r'],
  kneeR: ['rightleg', 'calf_r', 'r_calf', 'shin.r'],
  ankleR: ['rightfoot', 'foot_r', 'r_foot', 'foot.r'],
};

function findBones(model) {
  const bones = new Map();
  model.traverse((n) => {
    if (n.isBone) bones.set(n.name.toLowerCase().replace(/^mixamorig\d*[:_]?/, '').replace(/^bip\d*[ _]?/, ''), n);
  });
  const out = {};
  for (const [k, names] of Object.entries(BONE_MAP)) {
    for (const nm of names) if (bones.has(nm)) { out[k] = bones.get(nm); break; }
  }
  return out;
}

// World-space joints for an imported, rigged GLB character, or null if it is not a humanoid rig.
export function glbJoints(entry) {
  if (!entry.model) return null;
  if (!entry.bones) entry.bones = findBones(entry.model);
  const b = entry.bones;
  if (!b.head || !b.hipL || !b.hipR || !b.shoulderL || !b.shoulderR) return null;
  entry.model.updateMatrixWorld(true);
  const w = (bone) => bone.getWorldPosition(new THREE.Vector3()).toArray();
  const J = {};
  for (const k of Object.keys(BONE_MAP)) if (b[k]) J[k] = w(b[k]);
  const head = J.head;
  if (!J.neck) J.neck = J.shoulderL.map((v, i) => (v + J.shoulderR[i]) / 2);
  // Face points from the head bone's orientation (Mixamo heads look down local +Z).
  const q = b.head.getWorldQuaternion(new THREE.Quaternion());
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const l = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const u = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const s = new THREE.Vector3(...J.neck).distanceTo(new THREE.Vector3(...head)) / 0.12 || 1;
  const at = (fw, lf, up) => new THREE.Vector3(...head).addScaledVector(f, fw * s).addScaledVector(l, lf * s).addScaledVector(u, up * s).toArray();
  J.head = at(0, 0, 0.08);
  J.nose = at(0.1, 0, 0.06);
  J.eyeL = at(0.085, 0.034, 0.09);
  J.eyeR = at(0.085, -0.034, 0.09);
  J.earL = at(0, 0.078, 0.075);
  J.earR = at(0, -0.078, 0.075);
  return J;
}

// Project one skeleton into 18 keypoints (pixel coords) or null where hidden.
export function keypoints(J, cam, W, H, depthAt, near, far) {
  const aspect = W / H;
  return OPENPOSE_18.map((name) => {
    const p = J[name];
    if (!p) return null;
    const pr = project(cam, p, aspect);
    if (!pr.inFront) return null;
    const x = pr.x * W, y = pr.y * H;
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    if (FACE.has(name)) {
      // Face points: visible when their side of the head faces the camera.
      const outward = norm(sub(p, J.head));
      const toCam = norm(sub(cam.pos, p));
      if (dot(outward, toCam) < (name === 'nose' ? -0.15 : 0.02)) return null;
      return { x, y };
    }
    if (depthAt) {
      const d = depthAt(Math.floor(x), Math.floor(y));
      const sceneZ = d <= 0 ? Infinity : 1 / (d * (1 / near - 1 / far) + 1 / far);
      if (pr.depth > sceneZ + 0.2 + 0.05 * pr.depth) return null;
    }
    return { x, y };
  });
}

export function drawOpenPose(ctx, W, H, people) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const scale = Math.max(1, H / 512);
  const stick = 4 * scale;
  for (const kp of people) {
    for (let i = 0; i < LIMB_SEQ.length; i++) {
      const a = kp[LIMB_SEQ[i][0] - 1], b = kp[LIMB_SEQ[i][1] - 1];
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const len = Math.hypot(a.x - b.x, a.y - b.y);
      const ang = Math.atan2(a.y - b.y, a.x - b.x);
      const [r, g, bl] = COLORS[i];
      ctx.fillStyle = `rgb(${Math.round(r * 0.6)},${Math.round(g * 0.6)},${Math.round(bl * 0.6)})`;
      ctx.beginPath();
      ctx.ellipse(mx, my, len / 2, stick, ang, 0, Math.PI * 2);
      ctx.fill();
    }
    kp.forEach((p, i) => {
      if (!p) return;
      const [r, g, b] = COLORS[i];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 * scale, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}
