import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc, applyCommands, evaluateScene, mat4Compose, mat4Point, lintScene, analyzeShot, buildPrompts,
  docToCommands, extractCommands, dist, focalFromFov, fovFromFocal, frameTimes, OPENPOSE_18, kitParts, tokenize,
} from '../src/core/index.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearV = (a, b, eps = 1e-3) => a.forEach((x, i) => near(x, b[i], eps));

function run(doc, text) {
  const r = applyCommands(doc, text);
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  return r.doc;
}

test('YXZ matrix: yaw 90 turns +Z toward +X', () => {
  const m = mat4Compose([1, 0, 0], [0, 90, 0], [1, 1, 1]);
  nearV(mat4Point(m, [0, 0, 1]), [2, 0, 0]);
});

test('lens and fov round-trip', () => {
  near(focalFromFov(fovFromFocal(35)), 35);
});

test('tokenizer keeps quoted values and splits on semicolons', () => {
  const t = tokenize('add box b desc="a red car" ; t=1 "x y"');
  assert.deepEqual(t, ['add', 'box', 'b', 'desc=a red car', ';', 't=1', { q: 'x y' }]);
});

test('add / set / key / del', () => {
  let doc = run(createDoc(), [
    'add box crate at=1,0,2 size=0.6 desc="a wooden crate"',
    'set crate color=#8a6a50 yaw=45',
    'key crate pos t=0 1,0,2 ; t=2 3,0,2 e=linear',
  ].join('\n'));
  const crate = doc.objects.find((o) => o.id === 'crate');
  assert.equal(crate.desc, 'a wooden crate');
  assert.deepEqual(crate.size, [0.6, 0.6, 0.6]);
  assert.equal(crate.rot[1], 45);
  nearV(evaluateScene(doc, 1).objects.get('crate').pos, [2, 0, 2]);
  doc = run(doc, 'del crate');
  assert.ok(!doc.objects.some((o) => o.id === 'crate'));
});

test('errors are atomic and point at the line', () => {
  const doc = createDoc();
  const r = applyCommands(doc, 'add box a\nadd blob b\nadd box c');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 2);
  assert.match(r.errors[0].msg, /unknown type/);
  assert.equal(r.doc, doc);
  assert.ok(!doc.objects.some((o) => o.id === 'a'));
});

test('parenting composes transforms', () => {
  const doc = run(createDoc(), 'add group g at=10,0,0 yaw=90\nadd box b parent=g at=0,0,1');
  nearV(evaluateScene(doc, 0).objects.get('b').pos, [11, 0, 0]);
});

test('camera targets track an object id', () => {
  const doc = run(createDoc(), 'add box b at=0,0,0 size=1\nkey b pos t=0 0,0,0 ; t=2 4,0,0\ncam cam1 at=0,2,8 look=b');
  const c = evaluateScene(doc, 2).cameras.get('cam1');
  nearV(c.target, [4, 0.5, 0]);
});

test('mannequin stands on the ground at the right height', () => {
  const doc = run(createDoc(), 'add mannequin hero at=0,0,0 height=1.8');
  const st = evaluateScene(doc, 0).objects.get('hero');
  assert.ok(st.joints.head[1] > 1.6 && st.joints.head[1] < 1.75, `head at ${st.joints.head[1]}`);
  assert.ok(Math.min(st.joints.ankleL[1], st.joints.ankleR[1]) < 0.12);
  assert.ok(st.aabb.min[1] >= -0.05);
  assert.equal(OPENPOSE_18.length, 18);
  for (const k of OPENPOSE_18) assert.ok(st.joints[k], `missing joint ${k}`);
});

test('mannequin faces +Z: nose is in front of the head', () => {
  const doc = run(createDoc(), 'add mannequin hero');
  const j = evaluateScene(doc, 0).objects.get('hero').joints;
  assert.ok(j.nose[2] > j.head[2]);
  assert.ok(j.shoulderL[0] > 0 && j.shoulderR[0] < 0, 'left shoulder on +X');
});

test('head turns toward the camera but within human range', () => {
  const doc = run(createDoc(), 'add mannequin hero look=cam\ncam cam1 at=0,1.6,-4 look=hero');
  const j = evaluateScene(doc, 0).objects.get('hero').joints;
  // Camera directly behind: head turns hard but cannot face it fully.
  const facing = [j.nose[0] - j.head[0], j.nose[2] - j.head[2]];
  assert.ok(Math.abs(facing[0]) > 0.05, 'head turned to one side');
});

test('walk cycle swings the legs in opposite phase', () => {
  const doc = run(createDoc(), 'add mannequin w pose=walk');
  const a = evaluateScene(doc, 0.26).objects.get('w').joints;
  assert.ok((a.ankleL[2] - a.hipL[2]) * (a.ankleR[2] - a.hipR[2]) < 0);
});

test('frame macro places the camera at the right distance', () => {
  const doc = run(createDoc(), 'add mannequin hero\nmacro frame cam=cam1 target=hero size=closeup angle=0');
  const ev = evaluateScene(doc, 0);
  const d = dist(ev.cameras.get('cam1').pos, ev.objects.get('hero').focus);
  near(d, 0.42 / (2 * Math.tan((40 * Math.PI) / 360)), 0.05);
  assert.ok(ev.cameras.get('cam1').pos[2] > 0, 'angle 0 is in front of the subject');
});

test('orbit keeps a constant radius and sweeps the requested angle', () => {
  const doc = run(createDoc(), 'add mannequin hero\nmacro orbit cam=cam1 target=hero radius=3 from=0 to=180 t0=0 t1=4');
  const radii = [0, 1, 2, 3, 4].map((t) => {
    const ev = evaluateScene(doc, t);
    const c = ev.cameras.get('cam1').pos, f = ev.objects.get('hero').focus;
    return Math.hypot(c[0] - f[0], c[2] - f[2]);
  });
  for (const r of radii) near(r, 3, 0.08);
  const end = evaluateScene(doc, 4).cameras.get('cam1').pos;
  assert.ok(end[2] < -2.5, 'ended behind the subject');
  const shots = analyzeShot(doc);
  assert.match(shots[0].moves.join(' '), /orbit/);
});

test('walk macro reaches the end of the path facing the travel direction', () => {
  const doc = run(createDoc(), 'add mannequin hero\nmacro walk who=hero path=0,4|4,4 t0=0 t1=6');
  const st = evaluateScene(doc, 6).objects.get('hero');
  nearV(st.pos, [4, 0, 4], 0.01);
  near(st.rot[1], 90, 1);
  assert.equal(st.poseName, 'stand');
  assert.equal(evaluateScene(doc, 1).objects.get('hero').poseName, 'walk');
});

test('push macro is described as a push in', () => {
  const doc = run(createDoc(), 'add mannequin hero desc="a man in a grey suit"\nmacro push cam=cam1 target=hero from=full to=closeup');
  const [s] = analyzeShot(doc);
  assert.match(s.moves.join(' '), /push in/);
  assert.equal(s.framing, 'full shot');
  const p = buildPrompts(doc);
  assert.match(p.generic, /a man in a grey suit/i);
});

test('room and street macros build valid scenes', () => {
  const doc = run(createDoc(), 'macro room id=kitchen w=5 d=6 door=front\nmacro street id=main length=30 seed=3\nmacro crowd id=folk count=5 at=0,0,10');
  assert.ok(doc.objects.filter((o) => o.parent === 'kitchen').length >= 6);
  assert.ok(doc.objects.some((o) => o.type === 'building'));
  assert.equal(doc.objects.filter((o) => o.parent === 'folk').length, 5);
});

test('lint catches a camera inside a wall and a character out of shot', () => {
  const doc = run(createDoc(), 'add wall w at=0,0,6\nadd mannequin hero at=20,0,0\ncam cam1 at=0,1.5,6 look=0,1,0');
  const issues = lintScene(doc);
  assert.ok(issues.some((i) => i.code === 'camera-inside' && i.level === 'error'));
  assert.ok(issues.some((i) => i.code === 'never-in-frame'));
});

test('cuts switch the active camera', () => {
  const doc = run(createDoc(), 'cam cam2 at=4,1.6,0 look=0,1,0\ncut t=0 cam1 ; t=3 cam2');
  assert.equal(evaluateScene(doc, 2.9).active, 'cam1');
  assert.equal(evaluateScene(doc, 3).active, 'cam2');
  assert.equal(analyzeShot(doc).length, 2);
});

test('serialised scene re-applies to the same state', () => {
  const doc = run(createDoc(), [
    'duration 6',
    'add mannequin hero desc="a woman in a yellow raincoat" look=cam',
    'add car c1 at=3,0,-2 yaw=30',
    'macro walk who=hero path=2,0 t0=0 t1=3',
    'cam cam2 at=4,1.6,0 look=hero lens=50',
    'cut t=0 cam1 ; t=3 cam2',
    'ref 1 hero "costume"',
  ].join('\n'));
  const text = docToCommands(doc);
  const fresh = createDoc();
  fresh.objects = [];
  const r = applyCommands(fresh, text.replace(/^add plane ground.*$/m, 'add plane ground size=40,0.01,40 color=#8d8a85 desc="the ground"'));
  assert.deepEqual(r.errors, []);
  for (const t of [0, 1.5, 4]) {
    const a = evaluateScene(doc, t), b = evaluateScene(r.doc, t);
    nearV(a.objects.get('hero').pos, b.objects.get('hero').pos, 0.01);
    nearV(a.cameras.get(a.active).pos, b.cameras.get(b.active).pos, 0.01);
  }
});

test('extractCommands pulls fenced commands out of a chatty reply', () => {
  const reply = 'Sure! Here you go:\n```greybox\nadd box a\nmacro frame cam=cam1 target=a size=wide\n```\nThat frames it.';
  assert.equal(extractCommands(reply), 'add box a\nmacro frame cam=cam1 target=a size=wide');
});

test('frame times and kits', () => {
  assert.equal(frameTimes(2, 24).length, 48);
  const parts = kitParts('car', [1.8, 1.45, 4.4]);
  assert.ok(parts.length >= 6);
});

test('a subject walking toward a static camera is not a push in', () => {
  const doc = run(createDoc(), 'add mannequin hero at=0,0,-6 desc="a man"\nmacro walk who=hero path=0,0 t0=0 t1=4\ncam cam1 at=0,1.6,4 look=0,1.4,0');
  const [s] = analyzeShot(doc);
  assert.deepEqual(s.moves, []);
  assert.match(s.actions[0], /walks toward the camera/);
});
