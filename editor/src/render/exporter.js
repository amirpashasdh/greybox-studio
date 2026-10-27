// Render pack exporter. Renders every frame deterministically (frame i at t = i / fps) into:
//   rgb/00000.png    clay previz (2x supersampled)
//   depth/00000.png  inverse depth, fixed near/far for the whole clip (no flicker)
//   pose/00000.png   OpenPose BODY_18 skeletons from exact joints
//   ids/00000.png    flat per-object colours, listed in manifest.json
//   previz.mp4       the RGB pass as H.264 (when the browser can encode it)
//   manifest.json    timing, depth range, object colours, prompts, shot analysis, the scene itself
//
// Output streams to disk when the File System Access API is available, otherwise builds a Blob.

import * as THREE from 'three';
import { Zip, ZipPassThrough, ZipDeflate, strToU8 } from 'fflate';
import { evaluateScene, frameTimes, project, analyzeShot, buildPrompts, docToCommands } from '../core/index.js';
import { SceneView } from './sceneView.js';
import { glbJoints, keypoints, drawOpenPose } from './posePass.js';

export const PASSES = ['rgb', 'depth', 'pose', 'ids'];

const pad = (i) => String(i).padStart(5, '0');

function canvas2d(W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
}

const toPNG = (canvas) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error('PNG encode failed'))), 'image/png'));

// Depth range for the whole clip. Using percentiles of what the camera sees (and keeping characters
// well inside the range) gives the subject a bright, readable value instead of letting one wall
// corner that brushes the lens squash everything else into grey.
export function depthRange(doc, times) {
  const depths = [];
  const charDepths = [];
  const aspect = doc.meta.width / doc.meta.height;
  for (const t of times) {
    const ev = evaluateScene(doc, t);
    const cam = ev.cameras.get(ev.active);
    for (const [id, st] of ev.objects) {
      if (!st.aabb) continue;
      const { min, max } = st.aabb;
      for (const x of [min[0], (min[0] + max[0]) / 2, max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], (min[2] + max[2]) / 2, max[2]]) {
        const p = project(cam, [x, y, z], aspect);
        if (!p.inFront || p.x < -0.2 || p.x > 1.2 || p.y < -0.2 || p.y > 1.2) continue;
        depths.push(p.depth);
      }
      if (st.joints && st.focus) {
        const p = project(cam, st.focus, aspect);
        if (p.inFront && p.x > -0.1 && p.x < 1.1 && p.y > -0.1 && p.y < 1.1) charDepths.push(p.depth);
      }
    }
  }
  if (!depths.length) return { near: 0.3, far: 50 };
  depths.sort((a, b) => a - b);
  const q = (f) => depths[Math.min(depths.length - 1, Math.floor(f * depths.length))];
  let near = q(0.05) * 0.85;
  if (charDepths.length) near = Math.min(near, Math.min(...charDepths) * 0.6);
  near = Math.max(0.1, near);
  const far = Math.min(200, Math.max(near * 4, q(0.98) * 1.1));
  return { near: +near.toFixed(3), far: +far.toFixed(3) };
}

async function makeSink(filename, preferDisk) {
  if (preferDisk && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }] });
      const writable = await handle.createWritable();
      let pending = Promise.resolve();
      return {
        kind: 'disk',
        write: (chunk) => { pending = pending.then(() => writable.write(chunk)); },
        close: async () => { await pending; await writable.close(); return null; },
        abort: async () => { try { await writable.abort(); } catch { /* ignore */ } },
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
    }
  }
  const chunks = [];
  return {
    kind: 'memory',
    write: (chunk) => chunks.push(chunk),
    close: async () => new Blob(chunks, { type: 'application/zip' }),
    abort: async () => { chunks.length = 0; },
  };
}

async function makeMp4(W, H, fps, canvas) {
  if (typeof VideoEncoder === 'undefined') return null;
  try {
    const mb = await import('mediabunny');
    const support = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: W, height: H, bitrate: 8e6, framerate: fps });
    if (!support.supported) return null;
    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const source = new mb.CanvasSource(canvas, { codec: 'avc', bitrate: mb.QUALITY_HIGH });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    return {
      add: (i) => source.add(i / fps, 1 / fps),
      finish: async () => { await output.finalize(); return new Uint8Array(target.buffer); },
    };
  } catch (err) {
    console.warn('MP4 encoding unavailable:', err);
    return null;
  }
}

export async function exportPack(doc, {
  passes = PASSES,
  mp4 = true,
  preferDisk = true,
  onProgress = () => {},
  signal,
  filename,
} = {}) {
  const W = doc.meta.width, H = doc.meta.height, fps = doc.meta.fps;
  const times = frameTimes(doc.meta.duration, fps);
  const name = filename || `${(doc.meta.name || 'shot').replace(/[^\w.-]+/g, '_')}.greybox.zip`;
  const sink = await makeSink(name, preferDisk);

  let zipErr = null;
  const zip = new Zip((err, chunk) => {
    if (err) zipErr = err;
    else if (chunk && chunk.length) sink.write(chunk);
  });
  const addFile = (path, data, compress = false) => {
    const f = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
    zip.add(f);
    f.push(data, true);
    if (zipErr) throw zipErr;
  };

  // Depth range per cut: a close-up and a wide shot need different ranges, and a cut is already a
  // discontinuity, so nothing flickers within a shot.
  const cuts = [...doc.cuts].sort((a, b) => a.t - b.t);
  const cutIndex = (t) => { let k = 0; cuts.forEach((c, i) => { if (c.t <= t + 1e-9) k = i; }); return k; };
  const ranges = cuts.map((c, i) => {
    const t1 = i + 1 < cuts.length ? cuts[i + 1].t : doc.meta.duration;
    const ts = times.filter((t) => t >= c.t - 1e-9 && t < t1 - 1e-9);
    return { t0: c.t, t1, camera: c.camera, ...depthRange(doc, ts.length ? ts : [c.t]) };
  });

  // Renderer: 2x supersampling for RGB via pixel ratio; 1x and no AA for depth and ids so values stay exact.
  const glCanvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, preserveDrawingBuffer: true, alpha: false });
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const view = new SceneView();
  view.showHelpers = false;
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 2000);

  const rgb = canvas2d(W, H);
  const depth = canvas2d(W, H);
  const pose = canvas2d(W, H);
  const ids = canvas2d(W, H);
  const video = mp4 && passes.includes('rgb') ? await makeMp4(W, H, fps, rgb.canvas) : null;

  // Wait for any GLB assets before the first frame.
  view.sync(doc, evaluateScene(doc, 0));
  await new Promise((r) => setTimeout(r, 0));
  await waitForAssets(doc, view);

  try {
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const t = times[i];
      const ev = evaluateScene(doc, t);
      view.sync(doc, ev);
      const camState = ev.cameras.get(ev.active);
      view.applyCamera(camera, camState, W / H);

      if (passes.includes('rgb')) {
        view.setPass('shaded', { background: doc.meta.background });
        renderer.setPixelRatio(2);
        renderer.setSize(W, H, false);
        renderer.render(view.scene, camera);
        rgb.ctx.drawImage(glCanvas, 0, 0, W, H);
        addFile(`rgb/${pad(i)}.png`, await toPNG(rgb.canvas));
        if (video) await video.add(i);
        renderer.setPixelRatio(1);
        renderer.setSize(W, H, false);
      }

      let depthPixels = null;
      const { near, far } = ranges[cutIndex(t)];
      if (passes.includes('depth') || passes.includes('pose')) {
        view.setPass('depth', { near, far });
        renderer.render(view.scene, camera);
        depth.ctx.drawImage(glCanvas, 0, 0, W, H);
        depthPixels = depth.ctx.getImageData(0, 0, W, H).data;
        if (passes.includes('depth')) addFile(`depth/${pad(i)}.png`, await toPNG(depth.canvas));
      }

      if (passes.includes('pose')) {
        const people = [];
        for (const o of doc.objects) {
          if (o.role !== 'character') continue;
          let J = ev.objects.get(o.id)?.joints;
          if (!J && o.type === 'glb') J = glbJoints(view.entries.get(o.id));
          if (!J) continue;
          const depthAt = depthPixels ? (x, y) => depthPixels[(y * W + x) * 4] / 255 : null;
          people.push(keypoints(J, camState, W, H, depthAt, near, far));
        }
        drawOpenPose(pose.ctx, W, H, people);
        addFile(`pose/${pad(i)}.png`, await toPNG(pose.canvas));
      }

      if (passes.includes('ids')) {
        view.setPass('ids');
        renderer.render(view.scene, camera);
        ids.ctx.drawImage(glCanvas, 0, 0, W, H);
        addFile(`ids/${pad(i)}.png`, await toPNG(ids.canvas));
      }

      onProgress({ frame: i + 1, frames: times.length });
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
    }

    const shots = analyzeShot(doc);
    const prompts = buildPrompts(doc, shots);
    const manifest = {
      generator: 'greybox-studio',
      format: 1,
      name: doc.meta.name,
      width: W,
      height: H,
      fps,
      frames: times.length,
      duration: doc.meta.duration,
      passes: Object.fromEntries(passes.map((p) => [p, `${p}/{frame:05d}.png`])),
      depth: {
        encoding: 'inverse',
        ranges: ranges.map((r) => ({ t0: r.t0, t1: r.t1, near: r.near, far: r.far })),
        note: 'value = (1/z - 1/far) / (1/near - 1/far) using the range of the cut the frame is in; white is near, black is far or empty',
      },
      objects: doc.objects.map((o) => ({ id: o.id, name: o.name, desc: o.desc, role: o.role, type: o.type, id_color: view.idColors.get(o.id) })),
      cuts: doc.cuts,
      refs: doc.meta.refs,
      look: doc.meta.look,
      audio: doc.meta.audio,
      shots,
      prompts: { ...prompts, ...(doc.meta.prompts || {}) },
      scene: doc,
    };
    if (video) {
      try { addFile('previz.mp4', await video.finish()); manifest.previz = 'previz.mp4'; } catch (err) { console.warn(err); }
    }
    addFile('manifest.json', strToU8(JSON.stringify(manifest, null, 2)), true);
    addFile('scene.greybox.txt', strToU8(docToCommands(doc)), true);
    zip.end();
    const blob = await sink.close();
    return { blob, name, sink: sink.kind, frames: times.length, ranges };
  } catch (err) {
    zip.terminate();
    await sink.abort();
    throw err;
  } finally {
    renderer.dispose();
  }
}

async function waitForAssets(doc, view, timeoutMs = 15000) {
  const glbs = doc.objects.filter((o) => o.type === 'glb' && o.src);
  const start = performance.now();
  while (glbs.some((o) => !view.entries.get(o.id)?.model) && performance.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Render a single still of one pass (used for the pass preview in the editor).
export function renderPassStill(renderer, view, camera, doc, t, pass) {
  const ev = evaluateScene(doc, t);
  view.sync(doc, ev);
  const camState = ev.cameras.get(ev.active);
  view.applyCamera(camera, camState, doc.meta.width / doc.meta.height);
  const range = depthRange(doc, [t]);
  view.setPass(pass === 'pose' ? 'depth' : pass, { ...range, background: doc.meta.background });
  renderer.render(view.scene, camera);
  return { ev, camState, range };
}
