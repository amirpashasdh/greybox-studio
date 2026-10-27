// Scene document: a plain JSON object, versioned, small enough to snapshot for undo.
//
// {
//   version: 1,
//   meta: { name, duration, fps, width, height, background, look, audio, refs: [...] },
//   objects: [ { id, type, name, desc, role, parent, pos, rot, scale, size, color,
//                height, pose, look, src, keys: { pos, rot, scale, pose, look } } ],
//   cameras: [ { id, name, fov, pos, target, roll, shake, keys: { pos, target, fov, roll } } ],
//   lights:  [ { id, type, pos, target, intensity, color } ],
//   cuts:    [ { t, camera } ]
// }
//
// Keys are arrays of { t, v, e } (time in seconds, value, ease of the segment ending at this key).

export const SCHEMA_VERSION = 1;

export const PRIMITIVES = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'capsule'];

// "Kit" types are single objects that render as a few primitives with a recognisable silhouette.
// Silhouettes matter: depth/pose control is literal, so a car should not be a plain box.
export const KITS = {
  car: { size: [1.8, 1.45, 4.4], role: 'prop', desc: 'a car' },
  truck: { size: [2.3, 2.6, 6.5], role: 'prop', desc: 'a truck' },
  tree: { size: [2.6, 5, 2.6], role: 'set', desc: 'a tree' },
  building: { size: [8, 12, 8], role: 'set', desc: 'a building' },
  table: { size: [1.6, 0.75, 0.9], role: 'prop', desc: 'a table' },
  chair: { size: [0.5, 0.95, 0.5], role: 'prop', desc: 'a chair' },
  sofa: { size: [2.0, 0.85, 0.9], role: 'prop', desc: 'a sofa' },
  bed: { size: [1.6, 0.6, 2.1], role: 'prop', desc: 'a bed' },
  door: { size: [1.0, 2.1, 0.1], role: 'set', desc: 'a door' },
  wall: { size: [4, 3, 0.2], role: 'set', desc: 'a wall' },
  lamp: { size: [0.4, 4.5, 0.4], role: 'set', desc: 'a street lamp' },
  stairs: { size: [1.2, 1.5, 2.4], role: 'set', desc: 'a flight of stairs' },
  window: { size: [1.2, 1.4, 0.15], role: 'set', desc: 'a window' },
};

export const TYPES = [...PRIMITIVES, 'mannequin', 'group', 'glb', ...Object.keys(KITS)];

export const ROLES = ['set', 'prop', 'character'];

export const POSES = ['stand', 'walk', 'run', 'sit', 'talk', 'wave', 'point', 'crouch', 'lie'];

export const DEFAULT_SIZE = {
  box: [1, 1, 1],
  sphere: [1, 1, 1],
  cylinder: [1, 1, 1],
  cone: [1, 1, 1],
  plane: [10, 0.01, 10],
  capsule: [0.6, 1.8, 0.6],
  mannequin: [0.5, 1.75, 0.3],
  group: [1, 1, 1],
  glb: [1, 1, 1],
};

export function defaultSize(type) {
  if (KITS[type]) return [...KITS[type].size];
  return [...(DEFAULT_SIZE[type] || [1, 1, 1])];
}

export function defaultRole(type) {
  if (type === 'mannequin') return 'character';
  if (KITS[type]) return KITS[type].role;
  if (type === 'plane' || type === 'group') return 'set';
  return 'prop';
}

export const ROLE_COLORS = {
  character: '#d9d4cf',
  prop: '#b9b4ad',
  set: '#9a9893',
};

export function createDoc(overrides = {}) {
  return {
    version: SCHEMA_VERSION,
    meta: {
      name: 'Untitled shot',
      duration: 8,
      fps: 24,
      width: 1280,
      height: 720,
      background: '#5f6368',
      look: '',
      audio: '',
      refs: [],
      ...overrides.meta,
    },
    objects: [
      {
        id: 'ground',
        type: 'plane',
        name: 'Ground',
        desc: 'the ground',
        role: 'set',
        parent: null,
        pos: [0, 0, 0],
        rot: [0, 0, 0],
        scale: [1, 1, 1],
        size: [40, 0.01, 40],
        color: '#8d8a85',
        keys: {},
      },
    ],
    cameras: [
      {
        id: 'cam1',
        name: 'Camera 1',
        fov: 40,
        pos: [0, 1.6, 6],
        target: [0, 1.2, 0],
        roll: 0,
        shake: 0,
        keys: {},
      },
    ],
    lights: [{ id: 'sun', type: 'sun', pos: [6, 10, 4], target: [0, 0, 0], intensity: 2.2, color: '#ffffff' }],
    cuts: [{ t: 0, camera: 'cam1' }],
  };
}

export function makeObject(type, id, props = {}) {
  const base = {
    id,
    type,
    name: props.name || id,
    desc: props.desc ?? (KITS[type] ? KITS[type].desc : ''),
    role: props.role || defaultRole(type),
    parent: null,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scale: [1, 1, 1],
    size: defaultSize(type),
    color: null,
    keys: {},
  };
  if (type === 'mannequin') {
    base.height = 1.75;
    base.pose = 'stand';
    base.look = null;
  }
  return { ...base, ...props, keys: props.keys || {} };
}

export function makeCamera(id, props = {}) {
  return {
    id,
    name: props.name || id,
    fov: 40,
    pos: [0, 1.6, 6],
    target: [0, 1.2, 0],
    roll: 0,
    shake: 0,
    keys: {},
    ...props,
  };
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,47}$/;
export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

export function allIds(doc) {
  return new Set([...doc.objects.map((o) => o.id), ...doc.cameras.map((c) => c.id), ...doc.lights.map((l) => l.id)]);
}

export function uniqueId(doc, base) {
  const ids = allIds(doc);
  const clean = (base || 'obj').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z_]/, 'o');
  if (!ids.has(clean)) return clean;
  for (let i = 2; ; i++) if (!ids.has(`${clean}${i}`)) return `${clean}${i}`;
}

export function findObject(doc, id) {
  return doc.objects.find((o) => o.id === id) || null;
}
export function findCamera(doc, id) {
  return doc.cameras.find((c) => c.id === id) || null;
}
export function findAny(doc, id) {
  return findObject(doc, id) || findCamera(doc, id) || doc.lights.find((l) => l.id === id) || null;
}

export const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

// Bring an arbitrary (e.g. older or hand-edited) document into the current shape.
export function normalizeDoc(input) {
  const doc = clone(input);
  const fresh = createDoc();
  doc.version = SCHEMA_VERSION;
  doc.meta = { ...fresh.meta, ...(doc.meta || {}) };
  doc.meta.refs = Array.isArray(doc.meta.refs) ? doc.meta.refs : [];
  doc.objects = (doc.objects || []).map((o) => makeObject(o.type || 'box', o.id, o));
  doc.cameras = (doc.cameras || []).map((c) => makeCamera(c.id, c));
  doc.lights = doc.lights || [];
  doc.cuts = (doc.cuts || []).filter((c) => doc.cameras.some((cam) => cam.id === c.camera));
  if (!doc.cameras.length) doc.cameras = fresh.cameras;
  if (!doc.cuts.length) doc.cuts = [{ t: 0, camera: doc.cameras[0].id }];
  doc.cuts.sort((a, b) => a.t - b.t);
  return doc;
}
