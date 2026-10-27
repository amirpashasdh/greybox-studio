import { findAny, round } from '../core/index.js';
import { store } from './store.js';
import { h, mount, timecode, toast } from './dom.js';
import { moveKey, deleteKey } from './edit.js';

const CH_LABEL = { pos: 'Position', rot: 'Rotation', scale: 'Scale', pose: 'Pose', look: 'Looks at', target: 'Aim', fov: 'Lens', roll: 'Roll' };

export function createTimeline(el) {
  const playBtn = h('button.btn.transport', { type: 'button', 'aria-label': 'Play', title: 'Play / pause (Space)', on: { click: togglePlay } });
  const tc = h('output.timecode', { 'aria-live': 'off' });
  const lanes = h('div.lanes');
  const ruler = h('div.ruler', { 'aria-hidden': 'true' });
  const playhead = h('div.playhead', { 'aria-hidden': 'true' });
  const track = h('div.track', ruler, lanes, playhead);
  const labels = h('div.lane-labels');
  const scrubber = h('input.sr-only', {
    type: 'range', min: 0, step: 0.001, 'aria-label': 'Playhead time in seconds',
    on: { input: (e) => store.setTime(+e.target.value) },
  });

  mount(el,
    h('div.timeline-bar',
      h('button.btn.transport', { type: 'button', 'aria-label': 'Go to start', title: 'Go to start (Home)', on: { click: () => store.setTime(0) } }, '⏮'),
      h('button.btn.transport', { type: 'button', 'aria-label': 'Previous frame', title: 'Previous frame (,)', on: { click: () => step(-1) } }, '‹'),
      playBtn,
      h('button.btn.transport', { type: 'button', 'aria-label': 'Next frame', title: 'Next frame (.)', on: { click: () => step(1) } }, '›'),
      tc,
      h('div.spacer'),
      h('button.btn.ghost', { type: 'button', title: 'Start the next camera here (cut)', on: { click: cutHere } }, 'Cut here'),
      scrubber,
    ),
    h('div.timeline-body', labels, track),
  );

  function togglePlay() {
    store.set({ playing: !store.state.playing });
  }
  function step(n) {
    store.set({ playing: false });
    store.setTime(store.snap(store.state.time) + n / store.doc.meta.fps);
  }

  function cutHere() {
    const t = store.snap(store.state.time);
    const doc = store.doc;
    const sel = store.state.selection;
    let cam = doc.cameras.find((c) => c.id === sel);
    if (!cam) {
      // Default to the next camera after the one live at the playhead.
      const live = [...doc.cuts].reverse().find((c) => c.t <= t + 1e-6)?.camera;
      const i = doc.cameras.findIndex((c) => c.id === live);
      cam = doc.cameras[(i + 1) % doc.cameras.length];
    }
    if (doc.cameras.length < 2) { toast('Add a second camera first, then cut to it.', 'info'); return; }
    const r = store.run(`cut t=${round(t, 4)} ${cam.id}`, 'Cut');
    if (r.errors.length) toast(r.errors[0].msg, 'error');
  }

  const x = (t) => `${(t / store.doc.meta.duration) * 100}%`;
  const timeAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return Math.min(store.doc.meta.duration, Math.max(0, ((clientX - r.left) / r.width) * store.doc.meta.duration));
  };

  // Scrub on the ruler or empty lane space.
  let scrubbing = false;
  track.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.key, .cut-handle, .segment')) return;
    scrubbing = true;
    track.setPointerCapture(e.pointerId);
    store.set({ playing: false, selectedKey: null });
    store.setTime(store.snap(timeAt(e.clientX)));
  });
  track.addEventListener('pointermove', (e) => { if (scrubbing) store.setTime(store.snap(timeAt(e.clientX))); });
  track.addEventListener('pointerup', () => { scrubbing = false; });

  function draggable(node, { onMove, onEnd }) {
    node.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      node.setPointerCapture(e.pointerId);
      let moved = false;
      const move = (ev) => { moved = true; onMove(store.snap(timeAt(ev.clientX)), ev); };
      const up = (ev) => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        onEnd(moved, store.snap(timeAt(ev.clientX)));
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
    });
  }

  function renderRuler() {
    const d = store.doc.meta.duration;
    const width = track.clientWidth || 600;
    const stepS = [0.25, 0.5, 1, 2, 5, 10].find((s) => (width / d) * s >= 48) || 10;
    const ticks = [];
    for (let t = 0; t <= d + 1e-6; t += stepS) {
      ticks.push(h('span.tick', { style: { left: x(t) } }, h('span.tick-label', `${round(t, 2)}s`)));
    }
    mount(ruler, ...ticks);
  }

  function keyNode(ent, channel, k, color) {
    const sel = store.state.selectedKey;
    const isSel = sel && sel.id === ent.id && sel.channel === channel && Math.abs(sel.t - k.t) < 1e-4;
    const node = h('button.key', {
      type: 'button',
      style: { left: x(k.t), '--key': color },
      'aria-label': `${CH_LABEL[channel] || channel} key at ${round(k.t, 2)} seconds`,
      'aria-pressed': String(!!isSel),
      title: `${round(k.t, 3)} s${k.e ? `, ${k.e}` : ''}${typeof k.v === 'string' ? `: ${k.v}` : ''}`,
      on: {
        keydown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); store.update((d) => deleteKey(d, ent.id, channel, k.t), 'Delete key'); store.set({ selectedKey: null }); }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const to = store.snap(k.t + (e.key === 'ArrowRight' ? 1 : -1) / store.doc.meta.fps);
            store.update((d) => moveKey(d, ent.id, channel, k.t, to), 'Move key');
            store.set({ selectedKey: { id: ent.id, channel, t: to } });
          }
        },
      },
    });
    let preview = k.t;
    draggable(node, {
      onMove: (t) => { preview = t; node.style.left = x(t); },
      onEnd: (moved) => {
        if (moved && Math.abs(preview - k.t) > 1e-4) {
          store.update((d) => moveKey(d, ent.id, channel, k.t, preview), 'Move key');
          store.set({ selectedKey: { id: ent.id, channel, t: preview } });
        } else {
          store.set({ selectedKey: { id: ent.id, channel, t: k.t } });
          store.setTime(k.t);
        }
        node.focus();
      },
    });
    return node;
  }

  function render() {
    const doc = store.doc;
    scrubber.max = doc.meta.duration;
    renderRuler();
    const laneEls = [];
    const labelEls = [h('div.lane-label.ruler-label', '')];

    // Cuts lane.
    const cuts = [...doc.cuts].sort((a, b) => a.t - b.t);
    const segs = cuts.map((c, i) => {
      const t1 = i + 1 < cuts.length ? cuts[i + 1].t : doc.meta.duration;
      const cam = doc.cameras.find((cc) => cc.id === c.camera);
      return h('button.segment', {
        type: 'button',
        style: { left: x(c.t), width: `calc(${x(t1 - c.t)} - 2px)` },
        'aria-label': `${cam?.name || c.camera} from ${round(c.t, 2)} to ${round(t1, 2)} seconds`,
        dataset: { selected: String(store.state.selection === c.camera) },
        on: { click: () => store.set({ selection: c.camera }) },
      }, cam?.name || c.camera);
    });
    const handles = cuts.slice(1).map((c) => {
      const handle = h('button.cut-handle', {
        type: 'button', style: { left: x(c.t) }, 'aria-label': `Cut at ${round(c.t, 2)} seconds. Delete to remove.`, title: 'Drag to move the cut. Delete removes it.',
        on: { keydown: (e) => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); store.update((d) => { d.cuts = d.cuts.filter((x2) => Math.abs(x2.t - c.t) > 1e-4); }, 'Remove cut'); } } },
      });
      let preview = c.t;
      draggable(handle, {
        onMove: (t) => { preview = Math.max(1 / doc.meta.fps, t); handle.style.left = x(preview); },
        onEnd: (moved) => {
          if (!moved) { handle.focus(); return; }
          store.update((d) => { const cut = d.cuts.find((x2) => Math.abs(x2.t - c.t) < 1e-4); if (cut) cut.t = round(preview, 4); d.cuts.sort((a, b) => a.t - b.t); }, 'Move cut');
        },
      });
      return handle;
    });
    laneEls.push(h('div.lane.cuts-lane', ...segs, ...handles));
    labelEls.push(h('div.lane-label', 'Cuts'));

    // Selected entity: one lane per animated channel.
    const selId = store.state.selection?.split(':')[0];
    const ent = selId && findAny(doc, selId);
    const roleColor = (e) => (doc.cameras.includes(e) ? 'var(--tape-camera)' : `var(--tape-${e.role || 'set'})`);
    if (ent && !doc.lights.includes(ent)) {
      const chans = Object.entries(ent.keys || {}).filter(([, ks]) => ks?.length);
      if (!chans.length) {
        laneEls.push(h('div.lane.hint-lane', h('span', 'Not animated. Press K or use Key at playhead to start.')));
        labelEls.push(h('div.lane-label', ent.name || ent.id));
      }
      for (const [ch, ks] of chans) {
        const nodes = [];
        if (ch === 'pose') {
          ks.forEach((k, i) => {
            const t1 = i + 1 < ks.length ? ks[i + 1].t : doc.meta.duration;
            nodes.push(h('span.pose-span', { style: { left: x(k.t), width: x(Math.max(0, t1 - k.t)) } }, k.v));
          });
        }
        nodes.push(...ks.map((k) => keyNode(ent, ch, k, roleColor(ent))));
        laneEls.push(h('div.lane', ...nodes));
        labelEls.push(h('div.lane-label', CH_LABEL[ch] || ch));
      }
    }

    // Everything else that moves, one summary lane each.
    const others = [...doc.cameras, ...doc.objects].filter((e) => e !== ent && Object.values(e.keys || {}).some((k) => k?.length));
    for (const o of others.slice(0, 12)) {
      const times = [...new Set(Object.values(o.keys).flat().map((k) => round(k.t, 4)))];
      laneEls.push(h('div.lane.summary', { on: { click: () => store.set({ selection: o.id }) } },
        ...times.map((t) => h('span.key-dot', { style: { left: x(t), '--key': roleColor(o) } }))));
      labelEls.push(h('button.lane-label.link', { type: 'button', on: { click: () => store.set({ selection: o.id }) } }, o.name || o.id));
    }

    mount(lanes, ...laneEls);
    mount(labels, ...labelEls);
    updatePlayhead();
  }

  function updatePlayhead() {
    playhead.style.left = x(store.state.time);
    tc.textContent = timecode(store.state.time, store.doc.meta.fps);
    scrubber.value = store.state.time;
    playBtn.textContent = store.state.playing ? '⏸' : '▶';
    playBtn.setAttribute('aria-label', store.state.playing ? 'Pause' : 'Play');
  }

  store.on('doc', render);
  store.on('ui', render);
  store.on('time', updatePlayhead);
  new ResizeObserver(renderRuler).observe(track);
  render();

  return { togglePlay, step, cutHere };
}
