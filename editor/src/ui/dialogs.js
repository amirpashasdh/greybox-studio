import { frameTimes } from '../core/index.js';
import { exportPack, PASSES } from '../render/exporter.js';
import { chat } from '../agent/llm.js';
import { store } from './store.js';
import { h, mount, download, toast } from './dom.js';

function dialog(title, body, actions) {
  const dlg = h('dialog.dialog', { 'aria-label': title },
    h('form.dialog-inner', { method: 'dialog' },
      h('h2', title),
      body,
      h('div.dialog-actions', ...actions)));
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
  dlg.showModal();
  return dlg;
}

const field = (label, input, hint) => h('label.field.stack', h('span.label', label), input, hint ? h('span.hint', hint) : null);

export function openSettings() {
  const s = store.settings;
  const presets = [
    ['Ollama (local)', 'http://localhost:11434/v1', 'qwen3:14b'],
    ['LM Studio (local)', 'http://localhost:1234/v1', ''],
    ['llama.cpp server', 'http://localhost:8080/v1', ''],
    ['OpenRouter', 'https://openrouter.ai/api/v1', ''],
    ['OpenAI', 'https://api.openai.com/v1', ''],
  ];
  const base = h('input', { type: 'url', value: s.baseUrl, placeholder: 'http://localhost:11434/v1' });
  const model = h('input', { type: 'text', value: s.model, placeholder: 'Model name as the server knows it' });
  const key = h('input', { type: 'password', value: s.apiKey, autocomplete: 'off', placeholder: 'Leave empty for local servers' });
  const temp = h('input', { type: 'number', min: 0, max: 1.5, step: 0.05, value: s.temperature });
  const proxy = h('input', { type: 'checkbox', checked: s.useProxy });
  const result = h('p.hint', { role: 'status' });
  const presetRow = h('div.preset-row', ...presets.map(([label, url, m]) => h('button.chip', {
    type: 'button', on: { click: () => { base.value = url; if (m) model.value = m; } },
  }, label)));

  const save = () => store.saveSettings({
    baseUrl: base.value.trim(), model: model.value.trim(), apiKey: key.value, temperature: +temp.value || 0, useProxy: proxy.checked,
  });
  const test = h('button.btn', { type: 'button', on: { click: async () => {
    save();
    result.textContent = 'Asking the model to reply...';
    try {
      const out = await chat({ settings: store.settings, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], temperature: 0 });
      result.textContent = `Connected. The model replied: "${out.slice(0, 60)}"`;
    } catch (err) {
      result.textContent = err.message;
    }
  } } }, 'Test connection');

  dialog('Agent model', h('div.dialog-body',
    h('p', 'Any server with an OpenAI-compatible chat endpoint works. Local models keep your scenes on your machine.'),
    presetRow,
    field('Endpoint', base, 'The URL ending in /v1'),
    field('Model', model, 'For blocking, models of 14B parameters and up follow the command format reliably.'),
    field('API key', key, 'Stored only in this browser.'),
    field('Temperature', temp),
    h('label.field.check', proxy, h('span', 'Route through the dev server (avoids CORS errors; set GREYBOX_LLM_TARGET when running npm run dev)')),
    h('div.row-actions', test),
    result,
  ), [
    h('button.btn.ghost', { value: 'cancel' }, 'Cancel'),
    h('button.btn.primary', { value: 'ok', on: { click: save } }, 'Save'),
  ]);
}

export function openExport() {
  const doc = store.doc;
  const times = frameTimes(doc.meta.duration, doc.meta.fps);
  const checks = Object.fromEntries(PASSES.map((p) => [p, h('input', { type: 'checkbox', checked: true })]));
  const labels = {
    rgb: ['Clay', 'Grey previz. Also saved as previz.mp4 when the browser can encode video.'],
    depth: ['Depth', 'Near is white. One fixed range per cut, so it never flickers within a shot.'],
    pose: ['Pose', 'OpenPose skeletons drawn from the exact joints, for pose-conditioned models.'],
    ids: ['Masks', 'One flat colour per object, listed in manifest.json, for masks and regional prompts.'],
  };
  const mp4 = h('input', { type: 'checkbox', checked: true });
  const progress = h('progress', { max: times.length, value: 0, hidden: true });
  const status = h('p.hint', { role: 'status' }, `${times.length} frames at ${doc.meta.width} x ${doc.meta.height}, ${doc.meta.fps} fps.`);
  let controller = null;

  const startBtn = h('button.btn.primary', { type: 'button', on: { click: start } }, 'Export render pack');
  const cancelBtn = h('button.btn.ghost', { value: 'cancel', on: { click: () => controller?.abort() } }, 'Close');
  const dlg = dialog('Export render pack', h('div.dialog-body',
    h('p', 'One zip with every pass as numbered PNG frames, a manifest, the shot prompts and the scene. Load it in ComfyUI with the Greybox Render Pack node.'),
    h('fieldset.passes', h('legend', 'Passes'),
      ...PASSES.map((p) => h('label.field.check', checks[p], h('span', h('strong', labels[p][0]), ' ', labels[p][1])))),
    h('label.field.check', mp4, h('span', 'Include previz.mp4')),
    progress,
    status,
  ), [cancelBtn, startBtn]);

  async function start() {
    const passes = PASSES.filter((p) => checks[p].checked);
    if (!passes.length) { status.textContent = 'Pick at least one pass.'; return; }
    controller = new AbortController();
    startBtn.disabled = true;
    progress.hidden = false;
    cancelBtn.textContent = 'Cancel';
    const t0 = performance.now();
    try {
      const out = await exportPack(store.doc, {
        passes, mp4: mp4.checked, signal: controller.signal,
        onProgress: ({ frame, frames }) => {
          progress.value = frame;
          const secs = (performance.now() - t0) / 1000;
          const left = (secs / frame) * (frames - frame);
          status.textContent = `Rendering frame ${frame} of ${frames}${frame > 4 ? `, about ${Math.ceil(left)} s left` : ''}`;
        },
      });
      if (out.blob) download(out.blob, out.name);
      status.textContent = out.blob ? `Exported ${out.frames} frames as ${out.name}.` : `Saved ${out.frames} frames to ${out.name}.`;
      toast('Render pack exported');
      cancelBtn.textContent = 'Close';
    } catch (err) {
      status.textContent = err.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${err.message}`;
      cancelBtn.textContent = 'Close';
    } finally {
      controller = null;
      startBtn.disabled = false;
    }
  }
  return dlg;
}

export function openShortcuts() {
  const rows = [
    ['Space', 'Play or pause'], [', and .', 'Previous / next frame'], ['Home', 'Go to start'],
    ['C', 'Switch between Shot and Set view'], ['W / E / R', 'Move, rotate, scale (Set view)'],
    ['K', 'Key the selection at the playhead'], ['F', 'Frame the selection'],
    ['Delete', 'Delete the selection, key or cut'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Ctrl+S', 'Save the project'], ['/', 'Focus the agent'], ['Esc', 'Clear the selection'],
  ];
  dialog('Keyboard shortcuts', h('dl.shortcuts', ...rows.flatMap(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])), [h('button.btn.primary', { value: 'ok' }, 'Done')]);
}

export function confirmDialog(title, message, okLabel) {
  return new Promise((resolve) => {
    const dlg = dialog(title, h('p', message), [
      h('button.btn.ghost', { value: 'cancel' }, 'Cancel'),
      h('button.btn.primary', { value: 'ok' }, okLabel),
    ]);
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'));
  });
}

export { mount };
