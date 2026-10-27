import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { evaluateScene, findAny, focalFromFov, DEG, sampleTimes } from '../core/index.js';
import { SceneView } from '../render/sceneView.js';
import { depthRange } from '../render/exporter.js';
import { keypoints, drawOpenPose, glbJoints } from '../render/posePass.js';
import { store } from './store.js';
import { h, timecode } from './dom.js';
import { writeChannel } from './edit.js';

const ROLE_HEX = { character: 0xff5fa2, prop: 0xf4d03f, set: 0xc9c4bc, camera: 0x4fb3ff };

export function createViewport(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setScissorTest(true);
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '3D viewport');
  renderer.domElement.tabIndex = 0;

  let dirty = true;
  const markDirty = () => { dirty = true; };
  const view = new SceneView({
    onAsyncChange: (id, info) => {
      // Record an imported model's real size once, so lint and framing know about it.
      const o = store.doc.objects.find((x) => x.id === id);
      if (o && o.type === 'glb' && JSON.stringify(o.size) === '[1,1,1]' && info.size) {
        store.update((d) => { d.objects.find((x) => x.id === id).size = info.size.map((v) => +v.toFixed(3)); }, 'Measure model');
      }
      markDirty();
    },
  });
  const scene = view.scene;

  // ---------- helpers: floor grid, camera frusta, motion paths ----------
  const grid = new THREE.GridHelper(40, 40, 0x7b7871, 0x6c6963);
  grid.position.y = 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  view.helpers.add(grid);
  const frusta = new THREE.Group();
  const paths = new THREE.Group();
  const pickables = new THREE.Group();
  view.helpers.add(frusta, paths, pickables);

  // ---------- cameras and controls ----------
  const freeCam = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
  freeCam.position.set(9, 7, 11);
  const orbit = new OrbitControls(freeCam, renderer.domElement);
  orbit.target.set(0, 1, 0);
  orbit.enableDamping = true;
  orbit.addEventListener('change', markDirty);
  const shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 2000);

  const gizmo = new TransformControls(freeCam, renderer.domElement);
  gizmo.setSize(0.85);
  scene.add(gizmo.getHelper());
  const handle = new THREE.Object3D();
  handle.rotation.order = 'YXZ';
  scene.add(handle);
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (!e.value) store.commit(store.doc, 'Move', { live: false });
  });
  gizmo.addEventListener('change', markDirty);
  gizmo.addEventListener('objectChange', onGizmoChange);

  // ---------- overlay: viewfinder, view switch, pass chips ----------
  const finder = h('div.finder', { 'aria-hidden': 'true' },
    h('div.finder-matte.top'), h('div.finder-matte.bottom'), h('div.finder-matte.left'), h('div.finder-matte.right'),
    h('div.finder-frame',
      h('i.corner.tl'), h('i.corner.tr'), h('i.corner.bl'), h('i.corner.br'),
      h('div.safe'), h('div.centre'),
      h('div.finder-label.cam'), h('div.finder-label.tc'), h('div.finder-label.shot'),
    ),
  );
  const poseCanvas = h('canvas.pose-overlay');
  const passChips = h('div.pass-chips', { role: 'radiogroup', 'aria-label': 'Preview pass' },
    ...[['shaded', 'Clay'], ['depth', 'Depth'], ['pose', 'Pose'], ['ids', 'Masks']].map(([p, label]) =>
      h('button.chip', { type: 'button', role: 'radio', dataset: { pass: p }, on: { click: () => store.set({ pass: p }) } }, label)),
  );
  const viewSwitch = h('div.view-switch', { role: 'radiogroup', 'aria-label': 'Viewport camera' },
    h('button.chip', { type: 'button', role: 'radio', dataset: { view: 'shot' }, title: 'Look through the shot camera (C)', on: { click: () => store.set({ view: 'shot' }) } }, 'Shot'),
    h('button.chip', { type: 'button', role: 'radio', dataset: { view: 'free' }, title: 'Free camera for building the set (C)', on: { click: () => store.set({ view: 'free' }) } }, 'Set'),
  );
  container.append(poseCanvas, finder, h('div.viewport-bar', viewSwitch, passChips));

  // ---------- state ----------
  let ev = evaluateScene(store.doc, store.state.time);
  let depthCache = null;
  let pathsDirty = true;

  store.on('doc', () => { pathsDirty = true; depthCache = null; markDirty(); });
  store.on('time', markDirty);
  store.on('ui', () => { pathsDirty = true; markDirty(); syncChips(); });

  function syncChips() {
    for (const b of passChips.children) b.setAttribute('aria-checked', String(b.dataset.pass === store.state.pass));
    for (const b of viewSwitch.children) b.setAttribute('aria-checked', String(b.dataset.view === store.state.view));
    container.classList.toggle('is-shot', store.state.view === 'shot');
    gizmo.setMode(store.state.tool);
  }
  syncChips();

  // ---------- frame layout ----------
  function shotRect() {
    const W = container.clientWidth, H = container.clientHeight;
    const aspect = store.doc.meta.width / store.doc.meta.height;
    const pad = 28;
    let w = W - pad * 2, hh = w / aspect;
    if (hh > H - pad * 2 - 34) { hh = H - pad * 2 - 34; w = hh * aspect; }
    return { x: Math.round((W - w) / 2), y: Math.round((H - hh) / 2 + 10), w: Math.round(w), h: Math.round(hh) };
  }

  function layoutFinder(r) {
    const W = container.clientWidth, H = container.clientHeight;
    const [top, bottom, left, right, frame] = finder.children;
    Object.assign(top.style, { left: 0, top: 0, width: `${W}px`, height: `${r.y}px` });
    Object.assign(bottom.style, { left: 0, top: `${r.y + r.h}px`, width: `${W}px`, height: `${H - r.y - r.h}px` });
    Object.assign(left.style, { left: 0, top: `${r.y}px`, width: `${r.x}px`, height: `${r.h}px` });
    Object.assign(right.style, { left: `${r.x + r.w}px`, top: `${r.y}px`, width: `${W - r.x - r.w}px`, height: `${r.h}px` });
    Object.assign(frame.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    Object.assign(poseCanvas.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  function updateFinderLabels() {
    const cam = ev.cameras.get(ev.active);
    const camDef = store.doc.cameras.find((c) => c.id === ev.active);
    const frame = finder.querySelector('.finder-frame');
    frame.querySelector('.cam').textContent = `${camDef?.name || ev.active}   ${Math.round(focalFromFov(cam.fov))} mm`;
    frame.querySelector('.tc').textContent = timecode(store.state.time, store.doc.meta.fps);
    const cuts = store.doc.cuts;
    const idx = cuts.indexOf(ev.cut) + 1;
    frame.querySelector('.shot').textContent = cuts.length > 1 ? `Cut ${idx} of ${cuts.length}` : store.doc.meta.name;
  }

  // ---------- helpers geometry ----------
  function clearGroup(g) {
    for (const c of g.children) {
      c.geometry?.dispose();
      c.material?.dispose();
    }
    g.clear();
  }

  function rebuildHelpers() {
    clearGroup(frusta);
    clearGroup(paths);
    clearGroup(pickables);
    const doc = store.doc;
    const aspect = doc.meta.width / doc.meta.height;
    const sel = store.state.selection;
    for (const c of doc.cameras) {
      const st = ev.cameras.get(c.id);
      const active = ev.active === c.id;
      const color = sel === c.id ? 0xffffff : active ? 0x4fb3ff : 0x2f6f99;
      frusta.add(frustumLines(st, aspect, color, active ? 1.1 : 0.7));
      // Invisible pick target for the camera body.
      const pick = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
      pick.position.set(...st.pos);
      pick.userData.pickId = c.id;
      pickables.add(pick);
      if (Array.isArray(c.target) && !c.keys?.target?.length) {
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), new THREE.MeshBasicMaterial({ color: 0x4fb3ff }));
        m.position.set(...st.target);
        m.userData.pickId = `${c.id}:target`;
        pickables.add(m);
      }
    }
    // Motion paths for everything that moves (cameras always, others when selected or moving).
    const times = sampleTimes(doc, Math.max(0.04, doc.meta.duration / 160));
    const evs = times.map((t) => evaluateScene(doc, t));
    const addPath = (pts, color, opacity) => {
      if (pts.length < 2) return;
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
      paths.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
    };
    for (const c of doc.cameras) {
      if (!c.keys?.pos?.length) continue;
      addPath(evs.map((e) => e.cameras.get(c.id).pos), 0x4fb3ff, sel === c.id ? 1 : 0.55);
    }
    for (const o of doc.objects) {
      if (!o.keys?.pos?.length) continue;
      addPath(evs.map((e) => {
        const p = e.objects.get(o.id).pos;
        return [p[0], p[1] + 0.03, p[2]];
      }), ROLE_HEX[o.role] || 0xffffff, sel === o.id ? 1 : 0.5);
    }
    pathsDirty = false;
  }

  function frustumLines(st, aspect, color, scale) {
    const cam = new THREE.PerspectiveCamera(st.fov, aspect, 0.1, 1);
    view.applyCamera(cam, st, aspect);
    const d = scale;
    const hh = Math.tan((st.fov * DEG) / 2) * d, ww = hh * aspect;
    const local = [[0, 0, 0], [-ww, -hh, -d], [ww, -hh, -d], [ww, hh, -d], [-ww, hh, -d]].map((p) => new THREE.Vector3(...p).applyMatrix4(cam.matrixWorld));
    const [o, a, b, c, e] = local;
    const up = new THREE.Vector3(0, hh * 1.35, -d).applyMatrix4(cam.matrixWorld);
    const segs = [o, a, o, b, o, c, o, e, a, b, b, c, c, e, e, a, c, up, up, e];
    const g = new THREE.BufferGeometry().setFromPoints(segs);
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
  }

  // ---------- gizmo <-> document ----------
  function attachGizmo() {
    const id = store.state.selection;
    const shot = store.state.view === 'shot';
    if (!id || shot) { gizmo.detach(); return; }
    const [baseId, sub] = id.split(':');
    const ent = findAny(store.doc, baseId);
    if (!ent) { gizmo.detach(); return; }
    if (store.doc.cameras.includes(ent)) {
      const st = ev.cameras.get(ent.id);
      handle.position.set(...(sub === 'target' ? st.target : st.pos));
      handle.rotation.set(0, 0, 0);
      handle.scale.set(1, 1, 1);
      gizmo.showX = gizmo.showY = gizmo.showZ = true;
      if (store.state.tool !== 'translate') gizmo.setMode('translate');
    } else if (store.doc.lights.includes(ent)) {
      handle.position.set(...ent.pos);
      gizmo.setMode('translate');
    } else {
      const st = ev.objects.get(ent.id);
      if (!st) { gizmo.detach(); return; }
      const m = new THREE.Matrix4().fromArray(st.matrix);
      const q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      m.decompose(p, q, s);
      handle.position.copy(p);
      handle.quaternion.copy(q);
      handle.scale.copy(s);
      gizmo.setMode(store.state.tool);
    }
    if (gizmo.object !== handle) gizmo.attach(handle);
  }

  function onGizmoChange() {
    const id = store.state.selection;
    if (!id) return;
    const [baseId, sub] = id.split(':');
    const t = store.snap(store.state.time);
    store.update((doc) => {
      const ent = findAny(doc, baseId);
      if (!ent) return;
      const p = handle.position.toArray();
      if (doc.cameras.includes(ent)) {
        writeChannel(doc, baseId, sub === 'target' ? 'target' : 'pos', p, t);
        return;
      }
      if (doc.lights.includes(ent)) { ent.pos = p; return; }
      // World -> parent-local.
      let world = new THREE.Matrix4().compose(handle.position, handle.quaternion, handle.scale);
      if (ent.parent) {
        const ps = ev.objects.get(ent.parent);
        if (ps) world = new THREE.Matrix4().fromArray(ps.matrix).invert().multiply(world);
      }
      const lp = new THREE.Vector3(), lq = new THREE.Quaternion(), ls = new THREE.Vector3();
      world.decompose(lp, lq, ls);
      const e = new THREE.Euler().setFromQuaternion(lq, 'YXZ');
      const mode = gizmo.mode;
      if (mode === 'translate') writeChannel(doc, baseId, 'pos', lp.toArray(), t);
      if (mode === 'rotate') writeChannel(doc, baseId, 'rot', [e.x / DEG, e.y / DEG, e.z / DEG], t);
      if (mode === 'scale') writeChannel(doc, baseId, 'scale', ls.toArray(), t);
    }, 'Move', { live: true });
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || gizmo.dragging) return;
    const r = renderer.domElement.getBoundingClientRect();
    let cam = freeCam, nx, ny;
    if (store.state.view === 'shot') {
      const fr = shotRect();
      cam = shotCam;
      nx = ((e.clientX - r.left - fr.x) / fr.w) * 2 - 1;
      ny = -((e.clientY - r.top - fr.y) / fr.h) * 2 + 1;
    } else {
      nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    }
    ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
    const hits = ray.intersectObjects([view.root, pickables], true);
    const hit = hits.find((x) => x.object.userData.pickId || x.object.userData.objectId);
    let id = hit ? hit.object.userData.pickId || hit.object.userData.objectId : null;
    // Prefer the top-level group a child belongs to only when the child is not itself selectable.
    if (id === 'ground') id = null;
    store.set({ selection: id });
  });

  // ---------- public helpers ----------
  function frameSelection() {
    const id = store.state.selection?.split(':')[0];
    const st = id && (ev.objects.get(id) || ev.cameras.get(id));
    if (!st) return;
    const focus = st.focus || st.pos;
    const size = st.aabb ? new THREE.Vector3(...st.aabb.max).sub(new THREE.Vector3(...st.aabb.min)).length() : 2;
    const dir = freeCam.position.clone().sub(orbit.target).normalize();
    orbit.target.set(...focus);
    freeCam.position.copy(orbit.target).addScaledVector(dir, Math.max(2, size * 1.6));
    store.set({ view: 'free' });
    markDirty();
  }

  function getFreeView() {
    return { pos: freeCam.position.toArray(), target: orbit.target.toArray(), fov: freeCam.fov };
  }

  // ---------- render loop ----------
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (store.state.playing) {
      const d = store.doc.meta.duration;
      let t = store.state.time + dt;
      if (t >= d) t = 0;
      store.state.time = t;
      store.emit('time');
      dirty = true;
    }
    orbit.update();
    if (dirty) render();
    requestAnimationFrame(loop);
  }

  function render() {
    dirty = false;
    const doc = store.doc;
    ev = evaluateScene(doc, store.state.time);
    view.sync(doc, ev);
    view.setSelected(store.state.selection?.split(':')[0]);
    if (pathsDirty) rebuildHelpers();
    else {
      // Frusta follow animated cameras every frame; cheap to rebuild.
      clearGroup(frusta);
      const aspect = doc.meta.width / doc.meta.height;
      for (const c of doc.cameras) {
        const st = ev.cameras.get(c.id);
        const active = ev.active === c.id;
        frusta.add(frustumLines(st, aspect, store.state.selection === c.id ? 0xffffff : active ? 0x4fb3ff : 0x2f6f99, active ? 1.1 : 0.7));
      }
    }
    if (!gizmo.dragging) attachGizmo();

    const W = container.clientWidth, H = container.clientHeight;
    const shot = store.state.view === 'shot';
    const pass = store.state.pass;
    const camState = ev.cameras.get(ev.active);
    let range = { near: 0.5, far: 50 };
    if (pass === 'depth' || pass === 'pose') {
      // Same per-cut range the exporter uses.
      const cuts = [...doc.cuts].sort((a, b) => a.t - b.t);
      const i = Math.max(0, cuts.indexOf(ev.cut));
      const key = `${i}`;
      if (!depthCache || depthCache.key !== key) {
        const t0 = cuts[i]?.t ?? 0, t1 = cuts[i + 1]?.t ?? doc.meta.duration;
        depthCache = { key, ...depthRange(doc, sampleTimes(doc, 0.5).filter((t) => t >= t0 && t < t1).concat([t0])) };
      }
      range = depthCache;
    }

    renderer.setScissor(0, 0, W, H);
    renderer.setViewport(0, 0, W, H);
    renderer.setClearColor(0x2b2d31);
    renderer.clear();

    view.showHelpers = !shot;
    view.setPass(pass === 'pose' ? 'depth' : pass, { ...range, background: doc.meta.background });
    if (shot) {
      const r = shotRect();
      layoutFinder(r);
      updateFinderLabels();
      view.applyCamera(shotCam, camState, doc.meta.width / doc.meta.height);
      const y = H - r.y - r.h;
      renderer.setScissor(r.x, y, r.w, r.h);
      renderer.setViewport(r.x, y, r.w, r.h);
      gizmo.getHelper().visible = false;
      renderer.render(scene, shotCam);
      drawPoseOverlay(pass === 'pose', r, camState, range);
    } else {
      freeCam.aspect = W / H;
      freeCam.updateProjectionMatrix();
      gizmo.getHelper().visible = true;
      renderer.render(scene, freeCam);
      drawPoseOverlay(false);
    }
  }

  function drawPoseOverlay(show, r, camState, range) {
    poseCanvas.hidden = !show;
    if (!show) return;
    const W = Math.round(r.w), H = Math.round(r.h);
    if (poseCanvas.width !== W || poseCanvas.height !== H) { poseCanvas.width = W; poseCanvas.height = H; }
    const ctx = poseCanvas.getContext('2d');
    const people = [];
    for (const o of store.doc.objects) {
      if (o.role !== 'character') continue;
      const J = ev.objects.get(o.id)?.joints || (o.type === 'glb' ? glbJoints(view.entries.get(o.id) || {}) : null);
      if (J) people.push(keypoints(J, camState, W, H, null, range.near, range.far));
    }
    drawOpenPose(ctx, W, H, people);
  }

  const ro = new ResizeObserver(() => {
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    markDirty();
  });
  ro.observe(container);
  renderer.setSize(container.clientWidth, container.clientHeight, false);
  requestAnimationFrame(loop);

  return { frameSelection, getFreeView, markDirty, renderer, view, getEval: () => ev };
}
