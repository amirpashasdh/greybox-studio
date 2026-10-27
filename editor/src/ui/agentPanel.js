import { applyCommands } from '../core/index.js';
import { runAgent } from '../agent/agent.js';
import { store } from './store.js';
import { h, mount } from './dom.js';

const MODES = [
  ['apply', 'Build', 'Changes go straight into the scene (undo with Ctrl+Z)'],
  ['review', 'Review', 'Shows the commands first; nothing changes until you apply'],
  ['ask', 'Ask', 'Answers questions without touching the scene'],
];

const STARTERS = [
  'A man paces in a small office, talking on the phone. Slow push in from a wide to a close-up.',
  'Two people meet in the middle of an empty street at dusk. Wide shot, then a 180-degree orbit around them.',
  'A woman runs toward camera down a corridor, the camera tracking backwards ahead of her.',
];

export function createAgentPanel(el, { openSettings }) {
  const log = h('div.chat-log', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with the scene agent' });
  const input = h('textarea.chat-input', {
    rows: 3,
    placeholder: 'Describe the shot, or ask for a change: "add a second camera low on her left and cut to it at 4 s"',
    'aria-label': 'Message the scene agent',
  });
  const sendBtn = h('button.btn.primary', { type: 'button', on: { click: send } }, 'Send');
  const stopBtn = h('button.btn', { type: 'button', hidden: true, on: { click: () => controller?.abort() } }, 'Stop');
  const modeGroup = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Agent mode' },
    ...MODES.map(([v, label, title]) => h('button', {
      type: 'button', role: 'radio', title, dataset: { mode: v },
      on: { click: () => { store.saveSettings({ agentMode: v }); syncMode(); } },
    }, label)));
  const modelBadge = h('button.model-badge', { type: 'button', title: 'Model settings', on: { click: openSettings } });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });

  mount(el,
    h('div.chat-tools', modeGroup, modelBadge),
    log,
    h('div.chat-compose', input, h('div.chat-actions', h('span.hint', 'Ctrl+Enter to send'), stopBtn, sendBtn)),
  );

  const history = [];
  let controller = null;

  function syncMode() {
    for (const b of modeGroup.children) b.setAttribute('aria-checked', String(b.dataset.mode === store.settings.agentMode));
    modelBadge.textContent = store.settings.model || 'Set a model';
  }
  store.on('settings', syncMode);
  syncMode();

  function empty() {
    mount(log, h('div.chat-empty',
      h('p', 'Describe a shot in plain words. The agent blocks it out with grey stand-ins, a camera move and timing, then you adjust by hand or by asking.'),
      ...STARTERS.map((s) => h('button.starter', { type: 'button', on: { click: () => { input.value = s; input.focus(); } } }, s)),
    ));
  }
  empty();

  function bubble(role, ...content) {
    if (log.querySelector('.chat-empty')) mount(log);
    const node = h(`div.msg.${role}`, ...content);
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function commandBlock(commands, { pending = false, onApply, onDiscard } = {}) {
    const pre = h('pre.cmd', commands);
    const details = h('details.cmd-wrap', { open: pending }, h('summary', `${commands.split('\n').filter((l) => l && !l.startsWith('#')).length} commands`), pre);
    if (!pending) return details;
    const applyBtn = h('button.btn.primary', { type: 'button', on: { click: () => { onApply(); actions.remove(); } } }, 'Apply to scene');
    const discard = h('button.btn.ghost', { type: 'button', on: { click: () => { onDiscard(); actions.remove(); } } }, 'Discard');
    const actions = h('div.msg-actions', discard, applyBtn);
    return h('div', details, actions);
  }

  function issueList(issues) {
    if (!issues.length) return null;
    return h('ul.issues', ...issues.map((i) => h(`li.${i.level}`, i.msg)));
  }

  async function send() {
    const text = input.value.trim();
    if (!text || controller) return;
    input.value = '';
    bubble('user', text);
    const live = bubble('assistant', h('span.typing', 'Thinking'));
    controller = new AbortController();
    sendBtn.hidden = true;
    stopBtn.hidden = false;
    const docAtSend = store.doc;
    try {
      const out = await runAgent({
        doc: docAtSend,
        history,
        userText: text,
        settings: store.settings,
        time: store.state.time,
        selection: store.state.selection,
        signal: controller.signal,
        onStream: (full) => { mount(live, h('div.msg-text', full.replace(/```[\s\S]*?(```|$)/g, '').trim() || 'Writing commands...')); log.scrollTop = log.scrollHeight; },
      });
      history.push({ role: 'user', content: text }, { role: 'assistant', content: out.commands ? `${out.text}\n\`\`\`greybox\n${out.commands}\n\`\`\`` : out.text });
      const parts = [h('div.msg-text', out.text || (out.applied ? 'Done.' : ''))];
      if (out.errors.length) {
        parts.push(h('p.msg-error', 'These commands could not be applied, so the scene is unchanged:'), issueList(out.errors.map((e) => ({ level: 'error', msg: `line ${e.line}: ${e.msg}` }))));
        if (out.commands) parts.push(commandBlock(out.commands));
      } else if (out.applied) {
        const review = store.settings.agentMode === 'review';
        if (review) {
          parts.push(commandBlock(out.commands, {
            pending: true,
            onApply: () => {
              // Re-apply onto the current scene in case it changed meanwhile.
              const r = store.doc === docAtSend ? { doc: out.doc, errors: [] } : applyCommands(store.doc, out.commands);
              if (r.errors.length) bubble('assistant', h('p.msg-error', `Could not apply: ${r.errors[0].msg}`));
              else store.commit(r.doc, 'Agent edit');
            },
            onDiscard: () => {},
          }));
        } else {
          if (store.doc === docAtSend) store.commit(out.doc, 'Agent edit');
          else {
            const r = applyCommands(store.doc, out.commands);
            if (r.errors.length) parts.push(h('p.msg-error', `The scene changed while the agent was working; could not apply: ${r.errors[0].msg}`));
            else store.commit(r.doc, 'Agent edit');
          }
          parts.push(commandBlock(out.commands));
        }
        parts.push(issueList(out.issues));
      }
      mount(live, ...parts);
    } catch (err) {
      mount(live, h('p.msg-error', err.name === 'AbortError' ? 'Stopped.' : err.message),
        err.name === 'AbortError' ? null : h('button.btn.ghost', { type: 'button', on: { click: openSettings } }, 'Open model settings'));
    } finally {
      controller = null;
      sendBtn.hidden = false;
      stopBtn.hidden = true;
      log.scrollTop = log.scrollHeight;
    }
  }

  return { focus: () => input.focus() };
}
