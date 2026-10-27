import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, applyCommands, extractCommands, lintScene } from '../src/core/index.js';
import { systemPrompt, runAgent } from '../src/agent/agent.js';
import { stripThinking } from '../src/agent/llm.js';

const settings = { baseUrl: 'http://model.test/v1', model: 'm', apiKey: '', temperature: 0.2, agentMode: 'apply' };

// Fake OpenAI-compatible server: returns queued replies in order, non-streaming JSON.
function mockFetch(replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const content = replies.shift() ?? 'ok';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

test('the example in the system prompt is valid and lint-clean', () => {
  const sp = systemPrompt(createDoc());
  const example = extractCommands(sp.slice(sp.indexOf('EXAMPLE'), sp.indexOf('CURRENT SCENE')));
  assert.ok(example.split('\n').length >= 8);
  const r = applyCommands(createDoc(), example);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(lintScene(r.doc).filter((i) => i.level === 'error'), []);
});

test('agent applies a valid reply in one call', async () => {
  const calls = mockFetch(['Adding a crate.\n```greybox\nadd box crate at=1,0,0 desc="a crate"\n```']);
  const out = await runAgent({ doc: createDoc(), history: [], userText: 'add a crate', settings, time: 0 });
  assert.equal(out.applied, true);
  assert.ok(out.doc.objects.some((o) => o.id === 'crate'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://model.test/v1/chat/completions');
  assert.match(calls[0].body.messages[0].content, /CURRENT SCENE/);
});

test('agent repairs failing lines', async () => {
  const calls = mockFetch([
    '```greybox\nadd blob x\n```',
    '```greybox\nadd box x\n```',
  ]);
  const out = await runAgent({ doc: createDoc(), history: [], userText: 'add x', settings, time: 0 });
  assert.equal(out.applied, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages.at(-1).content, /unknown type/);
});

test('agent asks the model to fix new lint errors', async () => {
  const calls = mockFetch([
    '```greybox\nadd wall w at=0,0,6\n```',
    '```greybox\nset cam1 at=0,1.6,9\n```',
  ]);
  const out = await runAgent({ doc: createDoc(), history: [], userText: 'wall behind camera', settings, time: 0 });
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages.at(-1).content, /inside w/);
  assert.equal(out.doc.cameras[0].pos[2], 9);
});

test('ask mode never applies', async () => {
  mockFetch(['A dolly moves the camera; a zoom changes the lens.']);
  const out = await runAgent({ doc: createDoc(), history: [], userText: 'difference?', settings: { ...settings, agentMode: 'ask' }, time: 0 });
  assert.equal(out.applied, false);
});

test('thinking blocks are stripped', () => {
  assert.equal(stripThinking('<think>hmm</think>\nHello'), 'Hello');
});
