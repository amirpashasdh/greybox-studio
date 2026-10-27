import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, applyCommands, lintScene, buildPrompts } from '../src/core/index.js';
import { EXAMPLES } from '../src/examples.js';

for (const ex of EXAMPLES) {
  test(`example "${ex.name}" builds without errors`, () => {
    const r = applyCommands(createDoc(), ex.script);
    assert.deepEqual(r.errors, []);
    const issues = lintScene(r.doc);
    assert.deepEqual(issues.filter((i) => i.level === 'error'), [], JSON.stringify(issues));
    const p = buildPrompts(r.doc);
    for (const k of ['generic', 'h3', 'wan', 'ltx']) assert.ok(p[k].length > 40);
  });
}
