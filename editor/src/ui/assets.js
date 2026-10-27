// Imported model files live in IndexedDB and are referenced from the scene as "asset:<id>",
// so the autosaved scene stays small. Saving a project embeds them; opening one restores them.

const DB = 'greybox-assets';
const STORE = 'files';
const urls = new Map();

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

async function hash(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function putAsset(file) {
  const buf = await file.arrayBuffer();
  const id = await hash(buf);
  await tx('readwrite', (s) => s.put({ name: file.name, type: file.type || 'model/gltf-binary', data: buf }, id));
  return `asset:${id}`;
}

export async function assetURL(src) {
  if (!src?.startsWith('asset:')) return src;
  if (urls.has(src)) return urls.get(src);
  const rec = await tx('readonly', (s) => s.get(src.slice(6)));
  if (!rec) throw new Error(`missing asset ${src}`);
  const url = URL.createObjectURL(new Blob([rec.data], { type: rec.type }));
  urls.set(src, url);
  return url;
}

// For project files: { "asset:<id>": { name, type, base64 } }
export async function bundleAssets(doc) {
  const out = {};
  for (const o of doc.objects) {
    if (!o.src?.startsWith('asset:') || out[o.src]) continue;
    const rec = await tx('readonly', (s) => s.get(o.src.slice(6)));
    if (!rec) continue;
    const bytes = new Uint8Array(rec.data);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out[o.src] = { name: rec.name, type: rec.type, base64: btoa(bin) };
  }
  return out;
}

export async function restoreAssets(assets = {}) {
  for (const [src, rec] of Object.entries(assets)) {
    const bin = atob(rec.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await tx('readwrite', (s) => s.put({ name: rec.name, type: rec.type, data: bytes.buffer }, src.slice(6)));
  }
}
