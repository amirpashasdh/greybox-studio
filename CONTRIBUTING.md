# Contributing

Thanks for helping. A few things keep the project coherent.

## Ground rules

- **The scene core stays pure.** `editor/src/core/` must not import three.js or touch the DOM.
  The viewport, exporter, linter and agent all depend on `evaluateScene()` giving the same answer
  everywhere. New behaviour there needs a test in `editor/test/`.
- **The model never does geometry.** If the agent keeps getting something spatial wrong, add or
  extend a macro and document it in `macroHelp()`. Do not add more prose to the system prompt.
- **Passes must stay exact and stable.** No per-frame normalisation, no antialiasing on depth or ids,
  and no colour-space conversion on ids.
- **Workflows are generated.** Change `comfyui/tools/build_workflows.py`, not the JSON in
  `example_workflows/`. To update to newer official templates, replace the files in
  `comfyui/tools/official/` and record the new commit in `SOURCE_COMMIT`.

## Running things

```bash
cd editor
npm install
npm test          # scene engine and agent loop (Node 20+)
npm run dev
npm run build

cd comfyui/comfyui-greybox
python test_nodes.py path/to/exported.greybox.zip
```

## Good first contributions

- Run the example workflows on real GPUs and report working ControlNet strengths per backend.
- A first-frame workflow for LTX: style the clay frame 0 with a depth-controlled image model.
- More poses for the mannequin (jump, kneel, reach) and a proper turn-in-place.
- A normal-map pass, for models trained on normals.
- Recorded agent sessions, good and bad, against small local models, to improve macros and lint.

## Code style

Plain modern JavaScript (ES2022 modules), no framework. Prefer clear names to comments. User-facing
text uses sentence case and says what will happen ("Export render pack", not "Submit").
