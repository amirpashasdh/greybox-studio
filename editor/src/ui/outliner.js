import { KITS, uniqueId } from '../core/index.js';
import { store } from './store.js';
import { h, mount, toast } from './dom.js';
import { putAsset } from './assets.js';

const TYPE_LABEL = { mannequin: 'person', glb: 'model' };

export function createOutliner(el, { onFrame }) {
  const list = h('div.outline', { role: 'tree', 'aria-label': 'Scene' });
  const addBtn = h('button.btn.add', { type: 'button', 'aria-haspopup': 'menu', on: { click: (e) => toggleMenu(e) } }, 'Add');
  const menu = buildMenu();
  const fileInput = h('input', { type: 'file', accept: '.glb,.gltf,model/gltf-binary', hidden: true, on: { change: importModel } });
  mount(el, h('div.panel-head', h('h2', 'Scene'), addBtn), menu, list, fileInput);

  function toggleMenu(e) {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) menu.querySelector('button')?.focus();
  }
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menu.hidden = true; addBtn.focus(); } });

  function buildMenu() {
    const item = (label, fn) => h('button.menu-item', { type: 'button', role: 'menuitem', on: { click: () => { menu.hidden = true; fn(); } } }, label);
    const group = (title, ...items) => h('div.menu-group', h('div.menu-title', title), ...items);
    return h('div.menu', { role: 'menu', hidden: true },
      group('People', item('Person', () => add('mannequin', 'person')), item('Crowd of 8', () => run(`macro crowd id=${uniqueId(store.doc, 'crowd')} count=8 at=0,0,-6`, 'Add crowd'))),
      group('Shapes', ...['box', 'sphere', 'cylinder', 'cone', 'capsule', 'plane'].map((t) => item(cap(t), () => add(t, t)))),
      group('Set pieces', ...Object.keys(KITS).map((t) => item(cap(t), () => add(t, t)))),
      group('Sets', item('Room', () => run(`macro room id=${uniqueId(store.doc, 'room')}`, 'Add room')), item('Street', () => run(`macro street id=${uniqueId(store.doc, 'street')}`, 'Add street'))),
      group('Staging', item('Camera', addCamera), item('Point light', () => run(`light point ${uniqueId(store.doc, 'lamp')} at=0,3,0`, 'Add light')), item('Import model (.glb)', () => fileInput.click())),
    );
  }

  function run(cmd, label) {
    const r = store.run(cmd, label);
    if (r.errors.length) toast(r.errors[0].msg, 'error');
    else {
      const last = r.results.at(-1);
      if (last?.id) store.set({ selection: last.id });
    }
  }

  function add(type, base) {
    const id = uniqueId(store.doc, base);
    const extra = type === 'plane' ? ' size=4,0.01,4' : '';
    run(`add ${type} ${id}${extra}`, `Add ${type}`);
  }

  function addCamera() {
    const id = uniqueId(store.doc, 'cam');
    run(`cam ${id} at=4,1.6,4 look=0,1.2,0`, 'Add camera');
  }

  async function importModel() {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const src = await putAsset(file);
      const id = uniqueId(store.doc, file.name.replace(/\.[^.]+$/, '').toLowerCase());
      store.update((d) => {
        d.objects.push({
          id, type: 'glb', name: file.name, desc: '', role: 'prop', parent: null, src,
          pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1], color: null, keys: {},
        });
      }, 'Import model');
      store.set({ selection: id });
      toast('Model imported. Set its role to "character" if it is a rigged person, so it appears in the pose pass.');
    } catch (err) {
      toast(`Could not import ${file.name}: ${err.message}`, 'error');
    }
  }

  function row(ent, kind, depth = 0) {
    const id = ent.id;
    const sel = store.state.selection?.split(':')[0] === id;
    const role = kind === 'camera' ? 'camera' : kind === 'light' ? 'light' : ent.role;
    const animated = Object.values(ent.keys || {}).some((k) => k?.length);
    return h('div.row', {
      role: 'treeitem', tabIndex: 0, 'aria-selected': String(sel), dataset: { role },
      style: { paddingLeft: `${10 + depth * 14}px` },
      on: {
        click: () => store.set({ selection: id }),
        dblclick: () => { store.set({ selection: id }); onFrame(); },
        keydown: (e) => { if (e.key === 'Enter') store.set({ selection: id }); },
      },
    },
    h('span.tape'),
    h('span.row-name', ent.name || id),
    animated ? h('span.row-anim', { title: 'Animated' }, '◆') : null,
    h('span.row-type', kind === 'object' ? TYPE_LABEL[ent.type] || ent.type : kind));
  }

  function render() {
    const doc = store.doc;
    const kids = new Map();
    for (const o of doc.objects) {
      const p = o.parent || '';
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(o);
    }
    const rows = [];
    const walk = (parent, depth) => {
      for (const o of kids.get(parent) || []) {
        rows.push(row(o, 'object', depth));
        walk(o.id, depth + 1);
      }
    };
    walk('', 0);
    mount(list,
      h('div.outline-section', h('div.section-title', 'Cameras'), ...doc.cameras.map((c) => row(c, 'camera'))),
      h('div.outline-section', h('div.section-title', 'Objects'), ...(rows.length ? rows : [h('p.empty', 'Nothing here yet. Use Add, or describe the scene to the agent.')])),
      h('div.outline-section', h('div.section-title', 'Lights'), ...doc.lights.map((l) => row({ ...l, name: l.id }, 'light'))),
    );
  }
  store.on('doc', render);
  store.on('ui', render);
  render();
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
