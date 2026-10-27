// Editor state: the document (with undo/redo) plus UI state. Panels subscribe to change events:
//   'doc'  - the scene changed
//   'time' - the playhead moved
//   'ui'   - selection, view mode, pass or other UI state changed

import { createDoc, normalizeDoc, clone, applyCommands, findAny } from '../core/index.js';

const AUTOSAVE_KEY = 'greybox.autosave.v1';
const SETTINGS_KEY = 'greybox.settings.v1';
const MAX_HISTORY = 200;

export const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'qwen3:14b',
  temperature: 0.2,
  agentMode: 'apply', // apply | review | ask
  useProxy: false,
};

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage full or blocked */ }
}

class Store {
  constructor() {
    this.listeners = new Map();
    this.past = [];
    this.future = [];
    let doc = null;
    const saved = safeGet(AUTOSAVE_KEY);
    if (saved) {
      try { doc = normalizeDoc(JSON.parse(saved)); } catch { doc = null; }
    }
    this.state = {
      doc: doc || createDoc(),
      selection: null, // object / camera / light id
      selectedKey: null, // { id, channel, t }
      time: 0,
      playing: false,
      view: 'shot', // shot | free
      pass: 'shaded', // shaded | depth | pose | ids
      autoKey: true,
      tool: 'translate',
    };
    this.settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(safeGet(SETTINGS_KEY) || '{}')) };
    this.saveTimer = null;
  }

  get doc() { return this.state.doc; }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) fn(payload);
  }

  // Replace the document, recording an undo step. `live` updates skip history (drag in progress).
  commit(doc, label = 'Edit', { live = false } = {}) {
    if (!live) {
      if (this.liveBase) {
        this.past.push(this.liveBase);
        this.liveBase = null;
      } else {
        this.past.push(JSON.stringify(this.state.doc));
      }
      if (this.past.length > MAX_HISTORY) this.past.shift();
      this.future = [];
      this.lastLabel = label;
    } else if (!this.liveBase) {
      this.liveBase = JSON.stringify(this.state.doc);
    }
    this.state.doc = doc;
    if (this.state.selection && !findAny(doc, this.state.selection)) this.state.selection = null;
    if (this.state.time > doc.meta.duration) this.state.time = doc.meta.duration;
    this.emit('doc', { label, live });
    this.scheduleSave();
  }

  // Clone, mutate, commit.
  update(mutator, label, opts) {
    const doc = clone(this.state.doc);
    mutator(doc);
    this.commit(doc, label, opts);
  }

  // Apply command-language text as one undo step. Returns { errors, results }.
  run(text, label = 'Commands') {
    const r = applyCommands(this.state.doc, text);
    if (!r.errors.length) this.commit(r.doc, label);
    return r;
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push(JSON.stringify(this.state.doc));
    this.state.doc = JSON.parse(this.past.pop());
    this.emit('doc', { label: 'Undo' });
    this.scheduleSave();
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(JSON.stringify(this.state.doc));
    this.state.doc = JSON.parse(this.future.pop());
    this.emit('doc', { label: 'Redo' });
    this.scheduleSave();
    return true;
  }

  load(doc) {
    this.past.push(JSON.stringify(this.state.doc));
    this.future = [];
    this.state.doc = normalizeDoc(doc);
    this.state.selection = null;
    this.state.time = 0;
    this.emit('doc', { label: 'Open' });
    this.emit('ui');
    this.emit('time');
    this.scheduleSave();
  }

  set(partial) {
    Object.assign(this.state, partial);
    if ('time' in partial) this.emit('time');
    if (Object.keys(partial).some((k) => k !== 'time')) this.emit('ui');
  }

  setTime(t) {
    const d = this.state.doc.meta.duration;
    this.set({ time: Math.min(d, Math.max(0, t)) });
  }

  // Snap a time to the nearest frame.
  snap(t) {
    const fps = this.state.doc.meta.fps;
    return Math.round(t * fps) / fps;
  }

  saveSettings(partial) {
    this.settings = { ...this.settings, ...partial };
    safeSet(SETTINGS_KEY, JSON.stringify(this.settings));
    this.emit('settings');
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => safeSet(AUTOSAVE_KEY, JSON.stringify(this.state.doc)), 400);
  }
}

export const store = new Store();
