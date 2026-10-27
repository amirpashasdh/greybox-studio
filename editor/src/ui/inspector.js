import {
  findAny, ROLES, POSES, focalFromFov, fovFromFocal, round, evaluateScene, TYPES,
} from '../core/index.js';
import { store } from './store.js';
import { h, mount, numberField, toast } from './dom.js';
import { writeChannel, keyAll, isAnimated } from './edit.js';

const RES_PRESETS = [
  ['1280x720', 'Landscape 16:9 (1280 x 720)'],
  ['1344x768', 'Landscape 16:9, MiniMax H3 (1344 x 768)'],
  ['832x480', 'Landscape 16:9, light (832 x 480)'],
  ['720x1280', 'Vertical 9:16 (720 x 1280)'],
  ['960x960', 'Square 1:1 (960 x 960)'],
  ['1680x720', 'Scope 21:9 (1680 x 720)'],
  ['1024x768', 'Classic 4:3 (1024 x 768)'],
];

export function createInspector(el, { getFreeView }) {
  const body = h('div.inspector-body');
  mount(el, h('div.panel-head', h('h2.inspector-title', 'Shot')), body);
  const title = el.querySelector('.inspector-title');

  let lastKey = '';
  function render(force = false) {
    if (!force && document.body.classList.contains('is-scrubbing')) return;
    const sel = store.state.selection?.split(':')[0] || null;
    // Avoid rebuilding while the user types in a field of the same entity.
    const key = `${sel}|${JSON.stringify(sel ? findAny(store.doc, sel) : store.doc.meta)}|${store.doc.cameras.length}|${store.doc.objects.length}|${round(store.state.time, 3)}`;
    if (!force && key === lastKey) return;
    if (!force && el.contains(document.activeElement) && document.activeElement.matches('input[type=text]:not(.num), textarea') && lastKey.split('|')[0] === `${sel}`) return;
    lastKey = key;
    const ent = sel && findAny(store.doc, sel);
    if (!ent) { title.textContent = 'Shot'; mount(body, shotPanel()); return; }
    if (store.doc.cameras.includes(ent)) { title.textContent = ent.name || ent.id; mount(body, cameraPanel(ent)); return; }
    if (store.doc.lights.includes(ent)) { title.textContent = ent.id; mount(body, lightPanel(ent)); return; }
    title.textContent = ent.name || ent.id;
    mount(body, objectPanel(ent));
  }
  store.on('doc', () => render());
  store.on('ui', () => render());
  store.on('time', () => {
    // Only animated values change with time.
    const sel = store.state.selection?.split(':')[0];
    const ent = sel && findAny(store.doc, sel);
    if (ent && Object.values(ent.keys || {}).some((k) => k?.length)) render();
  });
  render(true);

  const t = () => store.snap(store.state.time);
  const edit = (label, fn, live = false) => store.update(fn, label, { live });

  // ---------- shared field builders ----------
  function vecRow(label, values, onSet, { step = 0.05, digits = 3, animated = false } = {}) {
    const names = ['X', 'Y', 'Z'];
    const cur = [...values];
    return h('div.vec', { class: animated ? 'is-animated' : '' },
      h('div.vec-label', label, animated ? h('span.anim-dot', { title: 'Animated: edits write a key at the playhead' }) : null),
      h('div.vec-fields', ...names.map((n, i) => numberField({
        label: n, value: values[i], step, digits,
        onChange: (v) => { cur[i] = v; onSet([...cur], true); },
        onCommit: (v) => { cur[i] = v; onSet([...cur], false); },
      }))));
  }

  function textField(label, value, onCommit, { multiline = false, placeholder = '', hint } = {}) {
    const input = multiline
      ? h('textarea', { rows: 3, placeholder, 'aria-label': label }, value || '')
      : h('input', { type: 'text', value: value || '', placeholder, 'aria-label': label });
    input.addEventListener('change', () => onCommit(input.value));
    return h('label.field.stack', h('span.label', label), input, hint ? h('span.hint', hint) : null);
  }

  function selectField(label, value, options, onCommit) {
    const sel = h('select', { 'aria-label': label, on: { change: () => onCommit(sel.value) } },
      ...options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
    return h('label.field', h('span.label', label), sel);
  }

  function section(title, ...children) {
    return h('section.insp-section', h('h3', title), ...children);
  }

  // ---------- shot (nothing selected) ----------
  function shotPanel() {
    const m = store.doc.meta;
    const res = `${m.width}x${m.height}`;
    const frames = Math.round(m.duration * m.fps);
    return [
      section('Timing and frame',
        textField('Name', m.name, (v) => edit('Rename shot', (d) => { d.meta.name = v || 'Untitled shot'; })),
        h('div.grid2',
          numberField({ label: 'Seconds', value: m.duration, step: 0.5, min: 1, max: 60, digits: 2, onCommit: (v) => edit('Duration', (d) => { d.meta.duration = v; }) }),
          numberField({ label: 'FPS', value: m.fps, step: 1, min: 8, max: 60, digits: 0, onCommit: (v) => edit('Frame rate', (d) => { d.meta.fps = Math.round(v); }) })),
        selectField('Frame', RES_PRESETS.some(([v]) => v === res) ? res : 'custom',
          [...RES_PRESETS, ...(RES_PRESETS.some(([v]) => v === res) ? [] : [['custom', `Custom (${m.width} x ${m.height})`]])],
          (v) => { if (v !== 'custom') { const [w, hh] = v.split('x').map(Number); edit('Frame size', (d) => { d.meta.width = w; d.meta.height = hh; }); } }),
        h('p.hint', `${frames} frames. Exports are resampled to each model's frame grid in ComfyUI.`),
      ),
      section('Look and sound',
        textField('Look', m.look, (v) => edit('Look', (d) => { d.meta.look = v; }), { multiline: true, placeholder: 'Night, wet street, sodium lights, photoreal, 35mm film' }),
        textField('Sound', m.audio, (v) => edit('Sound', (d) => { d.meta.audio = v; }), { multiline: true, placeholder: 'Rain on tin roofs, distant traffic, no music' }),
        h('label.field', h('span.label', 'Clay background'), h('input', { type: 'color', value: m.background, on: { change: (e) => edit('Background', (d) => { d.meta.background = e.target.value; }) } })),
      ),
      refsSection(),
    ];
  }

  function refsSection() {
    const refs = store.doc.meta.refs;
    const options = [['location', 'The location'], ['style', 'The visual style'], ...store.doc.objects.filter((o) => o.role !== 'set' || o.desc).map((o) => [o.id, o.name || o.id])];
    const rows = refs.map((r, i) => h('div.ref-row',
      h('span.ref-slot', `${i + 1}`),
      h('select', { 'aria-label': `Reference ${i + 1} shows`, on: { change: (e) => edit('Reference', (d) => { d.meta.refs[i].id = e.target.value; }) } },
        ...options.map(([v, text]) => h('option', { value: v, selected: v === r.id }, text))),
      h('input', { type: 'text', value: r.label || '', placeholder: 'What it shows', 'aria-label': 'Reference note', on: { change: (e) => edit('Reference', (d) => { d.meta.refs[i].label = e.target.value; }) } }),
      h('button.icon-btn', { type: 'button', title: 'Remove reference', 'aria-label': 'Remove reference', on: { click: () => edit('Remove reference', (d) => { d.meta.refs.splice(i, 1); d.meta.refs.forEach((x, j) => { x.slot = j + 1; }); }) } }, '×'),
    ));
    return section('Reference images',
      h('p.hint', 'The order of the images you load in ComfyUI. Prompts call them by number, for example Picture 1.'),
      ...rows,
      h('button.btn.ghost', { type: 'button', on: { click: () => edit('Add reference', (d) => { d.meta.refs.push({ slot: d.meta.refs.length + 1, id: d.objects.find((o) => o.role === 'character')?.id || 'location', label: '' }); }) } }, 'Add reference image'),
    );
  }

  // ---------- object ----------
  function objectPanel(o) {
    const ev = evaluateScene(store.doc, store.state.time);
    const st = ev.objects.get(o.id);
    const time = t();
    const setVec = (channel, label) => (v, live) => edit(label, (d) => writeChannel(d, o.id, channel, v, time), live);
    const out = [
      section('Stands for',
        textField('Description', o.desc, (v) => edit('Describe', (d) => { findAny(d, o.id).desc = v; }), {
          multiline: true,
          placeholder: o.type === 'mannequin' ? 'A woman in her 30s in a yellow raincoat' : 'A rusted shipping container',
          hint: 'What this grey shape becomes in the final video. It goes into the prompt.',
        }),
        h('div.grid2',
          textField('Name', o.name, (v) => edit('Rename', (d) => { findAny(d, o.id).name = v || o.id; })),
          selectField('Role', o.role, ROLES.map((r) => [r, r === 'set' ? 'Set' : r === 'prop' ? 'Prop' : 'Character']), (v) => edit('Role', (d) => { findAny(d, o.id).role = v; }))),
        h('p.hint.mono', `${o.id}  ${TYPES.includes(o.type) ? o.type : ''}`),
      ),
      section('Placement',
        vecRow('Position', st ? st.localPos : o.pos, setVec('pos', 'Move'), { animated: isAnimated(o, 'pos') }),
        vecRow('Rotation', st ? st.rot : o.rot, setVec('rot', 'Rotate'), { step: 1, digits: 1, animated: isAnimated(o, 'rot') }),
        o.type === 'mannequin' ? null : vecRow('Size', o.size, (v, live) => edit('Resize', (d) => { findAny(d, o.id).size = v.map((x) => Math.max(0.01, x)); }, live), { step: 0.05 }),
        o.type === 'glb' ? vecRow('Scale', st ? st.scale : o.scale, setVec('scale', 'Scale'), { animated: isAnimated(o, 'scale') }) : null,
        selectField('Parent', o.parent || '', [['', 'None'], ...store.doc.objects.filter((x) => x.id !== o.id && x.type === 'group').map((x) => [x.id, x.name || x.id])],
          (v) => edit('Parent', (d) => { findAny(d, o.id).parent = v || null; })),
      ),
    ];
    if (o.type === 'mannequin') {
      const look = o.look === null || o.look === undefined ? 'none' : Array.isArray(o.look) ? 'none' : o.look;
      out.push(section('Performance',
        numberField({ label: 'Height (m)', value: o.height || 1.75, step: 0.01, min: 0.5, max: 2.5, digits: 2, onCommit: (v) => edit('Height', (d) => { findAny(d, o.id).height = v; }) }),
        selectField(isAnimated(o, 'pose') ? 'Pose at playhead' : 'Pose', st?.poseName || o.pose, POSES.map((p) => [p, p[0].toUpperCase() + p.slice(1)]),
          (v) => edit('Pose', (d) => writeChannel(d, o.id, 'pose', v, time))),
        h('button.btn.ghost', { type: 'button', title: 'Change pose from this moment on', on: { click: () => {
          const pose = body.querySelector('select[aria-label^="Pose"]').value;
          edit('Key pose', (d) => writeChannel(d, o.id, 'pose', pose, time, { forceKey: true }));
          toast(`Pose key at ${round(time, 2)} s`);
        } } }, 'Key this pose at the playhead'),
        selectField('Looks at', look, [['none', 'Where they face'], ['cam', 'The camera'], ...store.doc.objects.filter((x) => x.id !== o.id && x.type !== 'group').map((x) => [x.id, x.name || x.id]), ...store.doc.cameras.map((c) => [c.id, `${c.name || c.id} (camera)`])],
          (v) => edit('Look at', (d) => { findAny(d, o.id).look = v === 'none' ? null : v; })),
      ));
    } else {
      out.push(section('Clay',
        h('label.field', h('span.label', 'Tint'), h('input', { type: 'color', value: o.color || '#b9b4ad', on: { change: (e) => edit('Tint', (d) => { findAny(d, o.id).color = e.target.value; }) } })),
        h('p.hint', 'Only the clay pass uses colour. Depth, pose and masks ignore it.'),
      ));
    }
    out.push(actions(o.id, ev));
    return out;
  }

  // ---------- camera ----------
  function cameraPanel(c) {
    const ev = evaluateScene(store.doc, store.state.time);
    const st = ev.cameras.get(c.id);
    const time = t();
    const targetIsId = typeof c.target === 'string';
    const isActive = ev.active === c.id;
    return [
      section('Lens',
        numberField({ label: 'Focal length (mm)', value: focalFromFov(st.fov), step: 1, min: 8, max: 300, digits: 1,
          onChange: (v) => edit('Lens', (d) => writeChannel(d, c.id, 'fov', round(fovFromFocal(v), 3), time), true),
          onCommit: (v) => edit('Lens', (d) => writeChannel(d, c.id, 'fov', round(fovFromFocal(v), 3), time)) }),
        h('div.grid2',
          numberField({ label: 'Roll', value: st.roll || 0, step: 1, digits: 1, onCommit: (v) => edit('Roll', (d) => writeChannel(d, c.id, 'roll', v, time)) }),
          numberField({ label: 'Handheld', value: c.shake || 0, step: 0.05, min: 0, max: 2, digits: 2, title: 'Handheld sway, 0 for a locked-off or rig-mounted camera', onCommit: (v) => edit('Handheld', (d) => { findAny(d, c.id).shake = v; }) })),
      ),
      section('Position',
        vecRow('Camera', st.pos, (v, live) => edit('Move camera', (d) => writeChannel(d, c.id, 'pos', v, time), live), { animated: isAnimated(c, 'pos') }),
        selectField('Aims at', targetIsId ? c.target : '__point', [['__point', 'A fixed point'], ...store.doc.objects.filter((o) => o.type !== 'group' && o.type !== 'plane').map((o) => [o.id, o.name || o.id])],
          (v) => edit('Aim', (d) => { const cam = findAny(d, c.id); cam.target = v === '__point' ? st.target.map((x) => round(x, 3)) : v; if (cam.keys?.target) delete cam.keys.target; })),
        targetIsId ? null : vecRow('Aim point', st.target, (v, live) => edit('Aim', (d) => writeChannel(d, c.id, 'target', v, time), live), { animated: isAnimated(c, 'target') }),
        h('button.btn', { type: 'button', title: 'Copy the free camera (Set view) into this camera', on: { click: () => {
          const fv = getFreeView();
          edit('Camera from view', (d) => {
            writeChannel(d, c.id, 'pos', fv.pos, time);
            const cam = findAny(d, c.id);
            if (typeof cam.target === 'string' && !isAnimated(cam, 'target')) cam.target = fv.target;
            else writeChannel(d, c.id, 'target', fv.target, time);
          });
          toast('Camera matched to the set view');
        } } }, 'Match the set view'),
      ),
      section('Edit',
        isActive ? h('p.hint', 'This camera is live at the playhead.') : h('button.btn', { type: 'button', on: { click: () => edit('Cut', (d) => {
          d.cuts = d.cuts.filter((x) => Math.abs(x.t - time) > 1e-4);
          d.cuts.push({ t: time, camera: c.id });
          d.cuts.sort((a, b) => a.t - b.t);
        }) } }, `Cut to this camera at ${round(time, 2)} s`),
      ),
      actions(c.id, ev),
    ];
  }

  function lightPanel(l) {
    return [
      section('Light',
        selectField('Type', l.type, [['sun', 'Sun'], ['point', 'Point'], ['spot', 'Spot']], (v) => edit('Light type', (d) => { findAny(d, l.id).type = v; })),
        vecRow('Position', l.pos, (v, live) => edit('Move light', (d) => { findAny(d, l.id).pos = v; }, live)),
        numberField({ label: 'Intensity', value: l.intensity, step: 0.1, min: 0, digits: 2, onCommit: (v) => edit('Intensity', (d) => { findAny(d, l.id).intensity = v; }) }),
        h('p.hint', 'Lights only shape the clay preview. Describe the real lighting under Look.'),
      ),
      h('div.insp-actions', h('button.btn.danger', { type: 'button', on: { click: () => { store.run(`del ${l.id}`, 'Delete'); } } }, 'Delete light')),
    ];
  }

  function actions(id, ev) {
    return h('div.insp-actions',
      h('button.btn', { type: 'button', title: 'Key position and rotation at the playhead (K)', on: { click: () => { edit('Key', (d) => keyAll(d, id, ev, t())); toast(`Keyed at ${round(t(), 2)} s`); } } }, 'Key at playhead'),
      h('button.btn.ghost', { type: 'button', on: { click: () => edit('Clear keys', (d) => { findAny(d, id).keys = {}; }) } }, 'Clear animation'),
      h('button.btn.danger', { type: 'button', on: { click: () => {
        const r = store.run(`del ${id}`, 'Delete');
        if (r.errors.length) toast(r.errors[0].msg, 'error');
      } } }, 'Delete'),
    );
  }

  return { render: () => render(true) };
}
