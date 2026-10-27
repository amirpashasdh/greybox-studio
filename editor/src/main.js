import '@fontsource/barlow-semi-condensed/400.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './styles.css';

import { createDoc, applyCommands, evaluateScene, findAny, normalizeDoc } from './core/index.js';
import { setAssetResolver } from './render/sceneView.js';
import { store } from './ui/store.js';
import { h, mount, toast, download } from './ui/dom.js';
import { createViewport } from './ui/viewport.js';
import { createOutliner } from './ui/outliner.js';
import { createInspector } from './ui/inspector.js';
import { createTimeline } from './ui/timeline.js';
import { createAgentPanel } from './ui/agentPanel.js';
import { createPromptPanel } from './ui/promptPanel.js';
import { openSettings, openExport, openShortcuts, confirmDialog } from './ui/dialogs.js';
import { assetURL, bundleAssets, restoreAssets } from './ui/assets.js';
import { keyAll } from './ui/edit.js';
import { EXAMPLES } from './examples.js';

setAssetResolver(assetURL);

// ---------- layout ----------
const app = document.getElementById('app');
const left = h('aside.panel.left', { 'aria-label': 'Scene contents' });
const centre = h('main.viewport', { 'aria-label': 'Viewport' });
const inspectorEl = h('section.panel.inspector', { 'aria-label': 'Inspector' });
const agentEl = h('div.tab-panel', { role: 'tabpanel', id: 'tab-agent' });
const promptEl = h('div.tab-panel', { role: 'tabpanel', id: 'tab-prompt', hidden: true });
const timelineEl = h('section.panel.timeline', { 'aria-label': 'Timeline' });

const tabBtn = (id, label) => h('button.tab', { type: 'button', role: 'tab', 'aria-controls': `tab-${id}`, dataset: { tab: id }, on: { click: () => showTab(id) } }, label);
const tabs = h('div.tabs', { role: 'tablist' }, tabBtn('agent', 'Agent'), tabBtn('prompt', 'Prompt'));
function showTab(id) {
  for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === id));
  agentEl.hidden = id !== 'agent';
  promptEl.hidden = id !== 'prompt';
}

const nameInput = h('input.shot-name', { type: 'text', 'aria-label': 'Shot name', on: { change: (e) => store.update((d) => { d.meta.name = e.target.value || 'Untitled shot'; }, 'Rename shot') } });
const undoBtn = h('button.btn.ghost', { type: 'button', title: 'Undo (Ctrl+Z)', on: { click: () => store.undo() } }, 'Undo');
const redoBtn = h('button.btn.ghost', { type: 'button', title: 'Redo (Ctrl+Shift+Z)', on: { click: () => store.redo() } }, 'Redo');
const fileInput = h('input', { type: 'file', accept: '.json,.txt,.greybox,application/json,text/plain', hidden: true, on: { change: openFile } });
const fileMenu = h('div.menu.file-menu', { role: 'menu', hidden: true },
  h('div.menu-group', h('div.menu-title', 'Project'),
    h('button.menu-item', { type: 'button', role: 'menuitem', on: { click: newShot } }, 'New shot'),
    h('button.menu-item', { type: 'button', role: 'menuitem', on: { click: () => fileInput.click() } }, 'Open project or script'),
    h('button.menu-item', { type: 'button', role: 'menuitem', on: { click: saveProject } }, 'Save project')),
  h('div.menu-group', h('div.menu-title', 'Examples'),
    ...EXAMPLES.map((ex) => h('button.menu-item', { type: 'button', role: 'menuitem', title: ex.blurb, on: { click: () => loadExample(ex) } }, ex.name))),
);
const fileBtn = h('button.btn.ghost', { type: 'button', 'aria-haspopup': 'menu', on: { click: (e) => { e.stopPropagation(); fileMenu.hidden = !fileMenu.hidden; } } }, 'File');
document.addEventListener('click', (e) => { if (!fileMenu.contains(e.target)) fileMenu.hidden = true; });
for (const item of fileMenu.querySelectorAll('.menu-item')) item.addEventListener('click', () => { fileMenu.hidden = true; });

const header = h('header.topbar',
  h('div.brand', { title: 'Greybox Studio' }, h('span.brand-mark', { 'aria-hidden': 'true' }), 'Greybox'),
  h('div.file-wrap', fileBtn, fileMenu),
  nameInput,
  undoBtn, redoBtn,
  h('div.spacer'),
  h('button.btn.ghost', { type: 'button', title: 'Keyboard shortcuts (?)', on: { click: openShortcuts } }, 'Shortcuts'),
  h('button.btn.ghost', { type: 'button', on: { click: openSettings } }, 'Model'),
  h('button.btn.primary', { type: 'button', on: { click: openExport } }, 'Export pack'),
  fileInput,
);

mount(app, header, left, centre, h('aside.panel.right', inspectorEl, h('section.panel.dock', tabs, agentEl, promptEl)), timelineEl);
showTab('agent');

// ---------- panels ----------
const viewport = createViewport(centre);
createOutliner(left, { onFrame: viewport.frameSelection });
createInspector(inspectorEl, { getFreeView: viewport.getFreeView });
const timeline = createTimeline(timelineEl);
const agent = createAgentPanel(agentEl, { openSettings });
createPromptPanel(promptEl);

function syncHeader() {
  if (document.activeElement !== nameInput) nameInput.value = store.doc.meta.name;
  undoBtn.disabled = !store.past.length;
  redoBtn.disabled = !store.future.length;
  document.title = `${store.doc.meta.name} - Greybox`;
}
store.on('doc', syncHeader);
syncHeader();

// ---------- files ----------
async function newShot() {
  if (!(await confirmDialog('Start a new shot?', 'The current shot stays in undo history until you close the tab. Save it first if you want to keep it.', 'New shot'))) return;
  store.load(createDoc());
}

function loadExample(ex) {
  const r = applyCommands(createDoc(), ex.script);
  if (r.errors.length) { toast(`Example failed: ${r.errors[0].msg}`, 'error'); return; }
  store.load(r.doc);
  store.set({ view: 'shot', pass: 'shaded' });
  toast(`${ex.name}: ${ex.blurb}`, 'info', 5000);
}

async function saveProject() {
  const assets = await bundleAssets(store.doc);
  const blob = new Blob([JSON.stringify({ greybox: 1, doc: store.doc, assets }, null, 2)], { type: 'application/json' });
  download(blob, `${store.doc.meta.name.replace(/[^\w.-]+/g, '_')}.greybox.json`);
}

async function openFile() {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  const text = await file.text();
  try {
    if (file.name.endsWith('.txt') || !text.trim().startsWith('{')) {
      const r = applyCommands(createDoc(), text);
      if (r.errors.length) throw new Error(`line ${r.errors[0].line}: ${r.errors[0].msg}`);
      store.load(r.doc);
    } else {
      const json = JSON.parse(text);
      if (json.assets) await restoreAssets(json.assets);
      store.load(normalizeDoc(json.doc || json.scene || json));
    }
    toast(`Opened ${file.name}`);
  } catch (err) {
    toast(`Could not open ${file.name}: ${err.message}`, 'error', 6000);
  }
}

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
  if (typing || mod || e.altKey) return;
  const sel = store.state.selection;
  switch (e.key) {
    case ' ': e.preventDefault(); timeline.togglePlay(); break;
    case ',': timeline.step(-1); break;
    case '.': timeline.step(1); break;
    case 'Home': store.setTime(0); break;
    case 'End': store.setTime(store.doc.meta.duration); break;
    case 'c': case 'C': store.set({ view: store.state.view === 'shot' ? 'free' : 'shot' }); break;
    case 'w': case 'W': store.set({ tool: 'translate' }); break;
    case 'e': case 'E': store.set({ tool: 'rotate' }); break;
    case 'r': case 'R': store.set({ tool: 'scale' }); break;
    case 'f': case 'F': viewport.frameSelection(); break;
    case 'k': case 'K':
      if (sel) {
        const ev = evaluateScene(store.doc, store.state.time);
        store.update((d) => keyAll(d, sel.split(':')[0], ev, store.snap(store.state.time)), 'Key');
        toast('Keyed at the playhead');
      }
      break;
    case 'Delete': case 'Backspace':
      if (sel && !e.target.closest('.key, .cut-handle')) {
        const id = sel.split(':')[0];
        if (findAny(store.doc, id) && id !== 'ground') {
          const r = store.run(`del ${id}`, 'Delete');
          if (r.errors.length) toast(r.errors[0].msg, 'error');
        }
      }
      break;
    case 'Escape': store.set({ selection: null, selectedKey: null }); break;
    case '/': e.preventDefault(); showTab('agent'); agent.focus(); break;
    case '?': openShortcuts(); break;
    default:
  }
});

// First visit: open an example so the screen is not empty.
if (!localStorage.getItem('greybox.visited')) {
  try { localStorage.setItem('greybox.visited', '1'); } catch { /* ignore */ }
  loadExample(EXAMPLES[0]);
}

// Scripting hook for the browser console and automated tests:
//   greybox.run('add box crate at=1,0,0')   greybox.exportPack(greybox.store.doc, { preferDisk: false })
import * as core from './core/index.js';
import { exportPack } from './render/exporter.js';
window.greybox = { store, core, exportPack, examples: EXAMPLES, run: (text) => store.run(text, 'Console') };
