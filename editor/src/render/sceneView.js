// Keeps a three.js scene in sync with the document at a given time, and renders it in one of
// several passes. Used by the editor viewport and by the exporter, so they cannot disagree.
//
// Passes:
//   shaded - clay-grey previz with sun + ambient light (viewport and the RGB pass)
//   depth  - inverse depth, near = white, far/background = black, fixed near/far for the whole clip
//   ids    - flat, unique colour per object; background black

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LIMBS, HEAD_RADIUS, kitParts, KITS, ROLE_COLORS, DEG } from '../core/index.js';

const UNIT = {
  box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  boxC: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 24, 16).translate(0, 0.5, 0),
  sphereC: new THREE.SphereGeometry(0.5, 24, 16),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 24).translate(0, 0.5, 0),
  cylinderC: new THREE.CylinderGeometry(0.5, 0.5, 1, 20),
  cone: new THREE.ConeGeometry(0.5, 1, 24).translate(0, 0.5, 0),
  coneC: new THREE.ConeGeometry(0.5, 1, 20),
  limb: new THREE.CylinderGeometry(1, 1, 1, 14),
  joint: new THREE.SphereGeometry(1, 14, 10),
};

// ---------- depth material (works on skinned meshes too) ----------

export function makeDepthMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uNear: { value: 0.5 }, uFar: { value: 50 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      #include <morphtarget_pars_vertex>
      varying float vViewZ;
      void main() {
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vViewZ = -mvPosition.z;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNear;
      uniform float uFar;
      varying float vViewZ;
      void main() {
        float z = max(vViewZ, 1e-3);
        float d = (1.0 / z - 1.0 / uFar) / (1.0 / uNear - 1.0 / uFar);
        gl_FragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
      }`,
    side: THREE.DoubleSide,
  });
}

// Flat colour written verbatim (no colour-space conversion), so id PNGs hold exact values.
export function makeIdMaterial(rgb) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Vector3(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      #include <morphtarget_pars_vertex>
      void main() {
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: THREE.DoubleSide,
  });
}

// Stable, well-separated id colours (never pure black).
export function idColor(index) {
  const h = (index * 0.61803398875) % 1;
  const s = 0.65 + 0.3 * ((index * 7) % 3) / 2;
  const v = 0.6 + 0.4 * ((index * 5) % 4) / 3;
  const c = new THREE.Color().setHSL(h, s, v * 0.5);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)].map((x) => Math.max(16, x));
}

const gltfCache = new Map();
const loader = new GLTFLoader();
let resolveSrc = async (src) => src;
// The editor plugs in IndexedDB-backed "asset:" URLs here.
export function setAssetResolver(fn) { resolveSrc = fn; }
function loadGLB(src) {
  if (!gltfCache.has(src)) {
    gltfCache.set(src, resolveSrc(src).then((url) => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject))));
  }
  return gltfCache.get(src);
}

export class SceneView {
  constructor({ onAsyncChange } = {}) {
    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);
    this.entries = new Map(); // id -> { obj, group, meshes:[], kind, sig }
    this.onAsyncChange = onAsyncChange || (() => {});
    this.depthMaterial = makeDepthMaterial();
    this.pass = 'shaded';
    this.idColors = new Map();

    this.hemi = new THREE.HemisphereLight(0xdfe3ea, 0x5a554e, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -25;
    this.sun.shadow.camera.right = 25;
    this.sun.shadow.camera.top = 25;
    this.sun.shadow.camera.bottom = -25;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
    this.extraLights = new Map();
  }

  // ---------- building ----------

  material(color, role) {
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(color || ROLE_COLORS[role] || '#b9b4ad'),
      roughness: 0.92,
      metalness: 0,
    });
  }

  signature(o) {
    return JSON.stringify([o.type, o.size, o.color, o.role, o.src, o.height]);
  }

  build(o) {
    const group = new THREE.Group();
    group.userData.objectId = o.id;
    group.rotation.order = 'YXZ';
    const mat = this.material(o.color, o.role);
    const meshes = [];
    const add = (geo, m = mat) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = o.type !== 'plane';
      mesh.receiveShadow = true;
      mesh.userData.objectId = o.id;
      group.add(mesh);
      meshes.push(mesh);
      return mesh;
    };
    const [sx, sy, sz] = o.size || [1, 1, 1];
    let kind = 'static';

    if (o.type === 'box' || o.type === 'plane') add(UNIT.box).scale.set(sx, Math.max(sy, 0.005), sz);
    else if (o.type === 'sphere') add(UNIT.sphere).scale.set(sx, sy, sz);
    else if (o.type === 'cylinder') add(UNIT.cylinder).scale.set(sx, sy, sz);
    else if (o.type === 'cone') add(UNIT.cone).scale.set(sx, sy, sz);
    else if (o.type === 'capsule') {
      const r = Math.max(0.005, Math.min(sx, sz) / 2);
      const m = add(new THREE.CapsuleGeometry(r, Math.max(0.01, sy - 2 * r), 6, 16).translate(0, sy / 2, 0));
      m.scale.set(sx / (2 * r), 1, sz / (2 * r));
    } else if (KITS[o.type]) {
      for (const p of kitParts(o.type, o.size)) {
        const geo = { box: UNIT.boxC, cylinder: UNIT.cylinderC, sphere: UNIT.sphereC, cone: UNIT.coneC }[p.shape];
        const m = add(geo);
        m.position.set(...p.c);
        m.rotation.set(p.r[0] * DEG, p.r[1] * DEG, p.r[2] * DEG, 'YXZ');
        m.scale.set(...p.s);
      }
    } else if (o.type === 'mannequin') {
      kind = 'mannequin';
      group.userData.limbs = LIMBS.map(([a, b, r]) => ({ a, b, r, mesh: add(UNIT.limb) }));
      const jointNames = ['shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'kneeL', 'kneeR', 'hipL', 'hipR', 'wristL', 'wristR', 'ankleL', 'ankleR', 'handL', 'handR', 'chest'];
      const jr = { shoulderL: 0.065, shoulderR: 0.065, elbowL: 0.05, elbowR: 0.05, kneeL: 0.065, kneeR: 0.065, hipL: 0.09, hipR: 0.09, wristL: 0.042, wristR: 0.042, ankleL: 0.055, ankleR: 0.055, handL: 0.055, handR: 0.055, chest: 0.17 };
      group.userData.joints = jointNames.map((name) => ({ name, r: jr[name], mesh: add(UNIT.joint) }));
      group.userData.head = add(UNIT.joint);
      group.userData.nose = add(UNIT.joint);
    } else if (o.type === 'glb' && o.src) {
      kind = 'glb';
      const holder = new THREE.Group();
      group.add(holder);
      loadGLB(o.src).then((gltf) => {
        const model = cloneSkinned(gltf.scene);
        model.traverse((n) => {
          if (n.isMesh) {
            n.castShadow = true;
            n.receiveShadow = true;
            n.userData.objectId = o.id;
            n.userData.ownMaterial = n.material;
            meshes.push(n);
          }
        });
        // Bottom-centre pivot, like every other object.
        const box = new THREE.Box3().setFromObject(model);
        const c = box.getCenter(new THREE.Vector3());
        model.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
        holder.add(model);
        const entry = this.entries.get(o.id);
        if (entry) {
          entry.mixer = gltf.animations.length ? new THREE.AnimationMixer(model) : null;
          if (entry.mixer) {
            entry.action = entry.mixer.clipAction(gltf.animations[0]);
            entry.action.play();
          }
          entry.model = model;
          entry.glbSize = box.getSize(new THREE.Vector3()).toArray();
          this.applyPass(entry);
        }
        this.onAsyncChange(o.id, { size: box.getSize(new THREE.Vector3()).toArray() });
      }).catch((err) => console.warn('GLB load failed', o.id, err));
    } else if (o.type === 'glb') {
      add(UNIT.box).scale.set(sx, sy, sz);
    }
    for (const m of meshes) m.userData.ownMaterial = m.material;
    return { obj: o, group, meshes, kind, sig: this.signature(o) };
  }

  // ---------- syncing ----------

  sync(doc, ev) {
    const seen = new Set();
    doc.objects.forEach((o, index) => {
      seen.add(o.id);
      let e = this.entries.get(o.id);
      if (e && e.sig !== this.signature(o)) {
        this.root.remove(e.group);
        this.disposeEntry(e);
        e = null;
      }
      if (!e) {
        e = this.build(o);
        this.entries.set(o.id, e);
        this.root.add(e.group);
        this.applyPass(e);
      }
      e.obj = o;
      if (!this.idColors.has(o.id)) this.idColors.set(o.id, idColor(this.idColors.size + 1));
      const st = ev.objects.get(o.id);
      if (!st) return;
      const m = new THREE.Matrix4().fromArray(st.matrix);
      if (e.kind === 'mannequin') {
        // Joints are already in world space; keep the group at identity.
        e.group.matrixAutoUpdate = false;
        e.group.matrix.identity();
        this.poseMannequin(e, st, o);
      } else {
        e.group.matrixAutoUpdate = false;
        e.group.matrix.copy(m);
        if (e.mixer && e.action) {
          const dur = e.action.getClip().duration || 1;
          e.mixer.setTime(((ev.t % dur) + dur) % dur);
        }
      }
      e.group.matrixWorldNeedsUpdate = true;
    });
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.root.remove(e.group);
        this.disposeEntry(e);
        this.entries.delete(id);
      }
    }
    this.syncLights(doc);
  }

  poseMannequin(e, st, o) {
    const J = st.joints;
    const s = (o.height || 1.75) / 1.75;
    const v = (p) => new THREE.Vector3(p[0], p[1], p[2]);
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = v(J.nose).sub(v(J.head)).setY(0).normalize();
    for (const limb of e.group.userData.limbs) {
      const a = v(J[limb.a]), b = v(J[limb.b]);
      const d = b.clone().sub(a);
      const l = d.length();
      const mesh = limb.mesh;
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      const dir = d.normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir.lengthSq() > 0 ? dir : up);
      if (limb.a === 'pelvis' && limb.b === 'neck') {
        // Torso is wider than it is deep: align its flat side with the body.
        const z = fwd.clone().sub(dir.clone().multiplyScalar(fwd.dot(dir))).normalize();
        const x = new THREE.Vector3().crossVectors(dir, z).normalize();
        q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, dir, z));
        mesh.scale.set(limb.r * s, l, limb.r * s * 0.62);
      } else {
        mesh.scale.set(limb.r * s, Math.max(l, 0.001), limb.r * s);
      }
      mesh.quaternion.copy(q);
    }
    for (const j of e.group.userData.joints) {
      j.mesh.position.copy(v(J[j.name]));
      const r = j.r * s;
      j.mesh.scale.set(r, r, j.name === 'chest' ? r * 0.7 : r);
      if (j.name === 'chest') j.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd.lengthSq() ? fwd : new THREE.Vector3(0, 0, 1));
    }
    const hr = HEAD_RADIUS * s;
    e.group.userData.head.position.copy(v(J.head));
    e.group.userData.head.scale.set(hr * 0.9, hr * 1.12, hr);
    const nose = e.group.userData.nose;
    nose.position.copy(v(J.nose)).lerp(v(J.head), 0.25);
    nose.scale.set(0.024 * s, 0.024 * s, 0.018 * s);
    nose.lookAt(v(J.nose).multiplyScalar(2).sub(v(J.head)));
    for (const m of e.meshes) m.updateMatrix();
  }

  syncLights(doc) {
    const sun = doc.lights.find((l) => l.type === 'sun');
    if (sun) {
      this.sun.position.set(...sun.pos);
      this.sun.target.position.set(...sun.target);
      this.sun.intensity = sun.intensity;
      this.sun.color.set(sun.color);
    }
    const seen = new Set();
    for (const l of doc.lights) {
      if (l.type === 'sun') continue;
      seen.add(l.id);
      let light = this.extraLights.get(l.id);
      if (!light || light.userData.type !== l.type) {
        if (light) this.scene.remove(light);
        light = l.type === 'spot' ? new THREE.SpotLight(0xffffff, 20, 30, Math.PI / 5, 0.4) : new THREE.PointLight(0xffffff, 20, 30);
        light.userData.type = l.type;
        this.scene.add(light);
        if (light.target) this.scene.add(light.target);
        this.extraLights.set(l.id, light);
      }
      light.position.set(...l.pos);
      if (light.target) light.target.position.set(...l.target);
      light.intensity = l.intensity;
      light.color.set(l.color);
    }
    for (const [id, light] of this.extraLights) if (!seen.has(id)) { this.scene.remove(light); this.extraLights.delete(id); }
  }

  disposeEntry(e) {
    for (const m of e.meshes) if (m.userData.ownMaterial?.dispose) m.userData.ownMaterial.dispose();
  }

  // ---------- passes ----------

  setPass(pass, { near = 0.5, far = 50, background } = {}) {
    this.pass = pass;
    this.helpers.visible = pass === 'shaded' && this.showHelpers !== false;
    if (pass === 'depth') {
      this.depthMaterial.uniforms.uNear.value = near;
      this.depthMaterial.uniforms.uFar.value = far;
      this.scene.overrideMaterial = this.depthMaterial;
      this.scene.background = new THREE.Color(0x000000);
    } else {
      this.scene.overrideMaterial = null;
      this.scene.background = pass === 'ids' ? new THREE.Color(0x000000) : new THREE.Color(background || '#5f6368');
    }
    for (const e of this.entries.values()) this.applyPass(e);
    const lit = pass === 'shaded';
    this.hemi.visible = lit;
    this.sun.visible = lit;
    for (const l of this.extraLights.values()) l.visible = lit;
  }

  applyPass(e) {
    const col = this.idColors.get(e.obj.id) || [255, 255, 255];
    const meshes = e.model ? [] : e.meshes;
    if (e.model) e.model.traverse((n) => n.isMesh && meshes.push(n));
    for (const m of meshes) {
      if (!m.userData.ownMaterial) m.userData.ownMaterial = m.material;
      if (this.pass === 'ids') {
        if (!m.userData.idMaterial) m.userData.idMaterial = makeIdMaterial(col);
        m.userData.idMaterial.uniforms.uColor.value.set(col[0] / 255, col[1] / 255, col[2] / 255);
        m.material = m.userData.idMaterial;
      } else {
        m.material = m.userData.ownMaterial;
      }
    }
  }

  // ---------- camera ----------

  applyCamera(camera, camState, aspect) {
    camera.fov = camState.fov;
    camera.aspect = aspect;
    camera.position.set(...camState.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(new THREE.Vector3(...camState.target));
    if (camState.roll) camera.rotateZ(camState.roll * DEG);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  // Highlight for selection in the viewport.
  setSelected(id) {
    for (const [eid, e] of this.entries) {
      for (const m of e.meshes) {
        const mat = m.userData.ownMaterial;
        if (mat && mat.emissive) mat.emissive.setHex(eid === id ? 0x3a2a12 : 0x000000);
      }
    }
  }
}
