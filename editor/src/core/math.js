// Small, dependency-free math for the scene core.
// Conventions: Y up, metres, right-handed. Euler angles are degrees, order YXZ
// (yaw, then pitch, then roll), matching three.js `rotation.order = 'YXZ'`.
// A character or object "faces" +Z; a camera looks down its own -Z.

export const DEG = Math.PI / 180;

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => len(sub(a, b));
export const norm = (a) => {
  const l = len(a);
  return l < 1e-9 ? [0, 0, 0] : mul(a, 1 / l);
};
export const lerp = (a, b, t) => a + (b - a) * t;
export const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const smoothstep = (t) => t * t * (3 - 2 * t);

export const EASES = {
  linear: (t) => t,
  inout: (t) => smoothstep(t),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  step: () => 0,
  smooth: (t) => t, // timing is linear; the path is a Catmull-Rom spline
};

export function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] =
      0.5 *
      (2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }
  return out;
}

// Shortest-path interpolation for an angle in degrees.
export function lerpAngle(a, b, t) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

// ---- 4x4 matrices, column-major (same layout as three.js .elements) ----

export function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// Compose translation * rotation(YXZ, degrees) * scale.
export function mat4Compose(pos, rotDeg, scale) {
  const [x, y, z] = rotDeg.map((d) => d * DEG);
  const a = Math.cos(x), b = Math.sin(x);
  const c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  // Rotation matrix for order YXZ (identical to three.js Matrix4.makeRotationFromEuler).
  const ce = c * e, cf = c * f, de = d * e, df = d * f;
  const m = new Array(16);
  m[0] = ce + df * b;
  m[4] = de * b - cf;
  m[8] = a * d;
  m[1] = a * f;
  m[5] = a * e;
  m[9] = -b;
  m[2] = cf * b - de;
  m[6] = df + ce * b;
  m[10] = a * c;
  const [sx, sy, sz] = scale;
  m[0] *= sx; m[1] *= sx; m[2] *= sx;
  m[4] *= sy; m[5] *= sy; m[6] *= sy;
  m[8] *= sz; m[9] *= sz; m[10] *= sz;
  m[3] = 0; m[7] = 0; m[11] = 0;
  m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
  return m;
}

export function mat4Mul(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

export function mat4Point(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export function mat4Dir(m, p) {
  const [x, y, z] = p;
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

// Recover yaw (degrees) of a forward (+Z) direction.
export const yawOf = (dir) => Math.atan2(dir[0], dir[2]) / DEG;

// Camera basis from position + look target (camera looks down -Z, +Y up).
export function lookBasis(pos, target, rollDeg = 0) {
  let fwd = norm(sub(target, pos));
  if (len(fwd) === 0) fwd = [0, 0, -1];
  let right = norm(cross(fwd, [0, 1, 0]));
  if (len(right) === 0) right = [1, 0, 0];
  let up = cross(right, fwd);
  if (rollDeg) {
    const r = rollDeg * DEG;
    const c = Math.cos(r), s = Math.sin(r);
    const r2 = add(mul(right, c), mul(up, s));
    up = add(mul(up, c), mul(right, -s));
    right = r2;
  }
  return { fwd, right, up };
}

// Project a world point through a pinhole camera.
// Returns { x, y } in normalized frame coords (0..1, y down), depth in metres along view axis,
// and `inFront` (true if in front of the camera).
export function project(cam, p, aspect) {
  const { fwd, right, up } = lookBasis(cam.pos, cam.target, cam.roll || 0);
  const rel = sub(p, cam.pos);
  const z = dot(rel, fwd);
  const x = dot(rel, right);
  const y = dot(rel, up);
  const tanY = Math.tan((cam.fov * DEG) / 2);
  const tanX = tanY * aspect;
  const nx = z > 1e-6 ? x / (z * tanX) : 0;
  const ny = z > 1e-6 ? y / (z * tanY) : 0;
  return { x: (nx + 1) / 2, y: (1 - ny) / 2, depth: z, inFront: z > 1e-3 };
}

// 35mm-equivalent focal length from vertical field of view (24mm sensor height).
export const focalFromFov = (fovDeg) => 12 / Math.tan((fovDeg * DEG) / 2);
export const fovFromFocal = (mm) => (2 * Math.atan(12 / mm)) / DEG;

// Deterministic, smooth 1D noise (value noise with smoothstep), range about -1..1.
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    const s = Math.sin((n + seed * 101.3) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  return lerp(h(i), h(i + 1), smoothstep(f));
}

// Seeded PRNG (mulberry32) for macros that place things "randomly" but reproducibly.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round = (x, d = 3) => {
  const p = 10 ** d;
  return Math.round(x * p) / p;
};
export const round3 = (v, d = 3) => v.map((x) => round(x, d));
