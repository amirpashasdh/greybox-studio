import { buildPrompts, analyzeShot } from '../core/index.js';
import { chat } from '../agent/llm.js';
import { store } from './store.js';
import { h, mount, toast } from './dom.js';

export const BACKENDS = [
  ['h3', 'MiniMax H3', 'Reference images are called <Picture 1>, <Picture 2> in the order you connect them. Works best on 5-15 s shots.'],
  ['ltx', 'LTX-2', 'One chronological paragraph: action first, then camera, then sound. Pair it with a first frame that matches the clay frame 0.'],
  ['wan', 'Wan VACE', 'One plain paragraph. Identity comes from the single reference image; keep it under about 120 words.'],
  ['generic', 'Generic', 'Readable by any model; the base for your own templates.'],
];

const POLISH_GUIDE = {
  h3: 'Target: MiniMax H3 reference-to-video with a depth/pose control video. Keep <Picture N> tags exactly. Keep the [start-end] timestamped beat lines and the Camera:, Audio:, Negative: lines.',
  ltx: 'Target: LTX-2 image-to-video with a depth IC-LoRA. Write one flowing paragraph in present tense, chronological, leading with the main action, then camera movement, then sound. 120-200 words.',
  wan: 'Target: Wan 2.1 VACE with a depth control video and one reference image. One paragraph, present tense, concrete visual nouns, under 120 words.',
  generic: 'Target: any text-to-video model. Clear, concrete, chronological.',
};

export function createPromptPanel(el) {
  let backend = 'h3';
  const tabs = h('div.segmented', { role: 'tablist', 'aria-label': 'Video model' },
    ...BACKENDS.map(([id, label]) => h('button', { type: 'button', role: 'tab', dataset: { id }, on: { click: () => { backend = id; render(); } } }, label)));
  const note = h('p.hint');
  const area = h('textarea.prompt-text', { rows: 12, 'aria-label': 'Shot prompt', spellcheck: true });
  const status = h('span.hint');
  const copyBtn = h('button.btn', { type: 'button', on: { click: copy } }, 'Copy');
  const resetBtn = h('button.btn.ghost', { type: 'button', on: { click: reset } }, 'Use generated');
  const polishBtn = h('button.btn', { type: 'button', title: 'Rewrite with your language model, keeping every camera and timing fact', on: { click: polish } }, 'Polish with agent');
  const shotsEl = h('div.shot-facts');

  area.addEventListener('change', () => {
    store.update((d) => { d.meta.prompts = { ...(d.meta.prompts || {}), [backend]: area.value }; }, 'Edit prompt');
  });

  mount(el, tabs, note, area, h('div.prompt-actions', status, h('div.spacer'), resetBtn, polishBtn, copyBtn), h('h3.subhead', 'What the camera does'), shotsEl);

  function render() {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.id === backend));
    note.textContent = BACKENDS.find(([id]) => id === backend)[2];
    const custom = store.doc.meta.prompts?.[backend];
    const generated = buildPrompts(store.doc)[backend];
    if (document.activeElement !== area) area.value = custom ?? generated;
    status.textContent = custom !== undefined ? 'Edited by you. Scene changes no longer update it.' : 'Updates as the scene changes.';
    resetBtn.hidden = custom === undefined;
    const shots = analyzeShot(store.doc);
    mount(shotsEl, ...shots.map((s) => h('div.shot-fact',
      h('div.shot-fact-head', `${s.t0.toFixed(1)}-${s.t1.toFixed(1)} s`, h('span', store.doc.cameras.find((c) => c.id === s.camera)?.name || s.camera)),
      h('div', [s.framing, s.angle, `${s.lens} mm`].filter(Boolean).join(', ')),
      h('div', s.moves.length ? s.moves.join('; ') : 'Static camera'),
      s.subject ? h('div', `${s.subject.label}: ${s.actions.join(', ') || 'holds position'}`) : h('div', 'No subject in frame'),
    )));
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(area.value);
      toast('Prompt copied');
    } catch {
      area.select();
      toast('Press Ctrl+C to copy the selected prompt');
    }
  }

  function reset() {
    store.update((d) => { if (d.meta.prompts) delete d.meta.prompts[backend]; }, 'Reset prompt');
  }

  async function polish() {
    polishBtn.disabled = true;
    const original = area.value;
    status.textContent = 'Polishing...';
    try {
      const text = await chat({
        settings: store.settings,
        temperature: 0.4,
        messages: [
          { role: 'system', content: `You rewrite shot descriptions into strong video-generation prompts. ${POLISH_GUIDE[backend]} Keep every fact about camera movement, lens, framing, timing, blocking and who is where. Never add camera moves, cuts or people that are not in the input. Return only the prompt.` },
          { role: 'user', content: original },
        ],
        onDelta: (_, full) => { area.value = full; },
      });
      area.value = text;
      store.update((d) => { d.meta.prompts = { ...(d.meta.prompts || {}), [backend]: text }; }, 'Polish prompt');
    } catch (err) {
      area.value = original;
      toast(err.message, 'error', 6000);
    } finally {
      polishBtn.disabled = false;
      render();
    }
  }

  store.on('doc', render);
  render();
  return { render };
}
