# Greybox Studio

Block out a shot with grey stand-ins, move the camera, time the action, and hand an open video model
exact control videos: depth, pose and per-object masks rendered from the scene itself.

```
 describe the shot ──▶ agent writes commands ──▶ blockout scene ──▶ render pack ──▶ ComfyUI ──▶ final video
   (or build by hand)    (any local/remote LLM)   (browser editor)   depth · pose ·   MiniMax H3
                                                                      masks · clay     LTX-2.3
                                                                      prompts          Wan VACE
```

AI previz tools from closed platforms send a grey preview clip to a closed video model and hope it
infers the camera move from the pixels. Open models need explicit control signals instead. Greybox
owns the 3D scene, so it renders those signals exactly instead of estimating them, and writes the
shot prompt from the same data.

## What is in this repository

| Part | What it does |
| --- | --- |
| `editor/` | Browser app (Vite + three.js). Viewport with shot and set views, outliner, inspector, keyframe timeline with cuts, agent chat, prompt panel, render pack export. |
| `editor/src/core/` | Dependency-free scene engine: document model, evaluator, procedural mannequin, command language, macros, linter, shot analysis and prompt writer. Runs in Node; this is what the tests cover. |
| `comfyui/comfyui-greybox/` | ComfyUI custom nodes that load a render pack and resample it to each model's frame rate and frame-count grid, plus three example workflows. |
| `comfyui/tools/` | The script that builds those workflows from the official Comfy Org templates (MIT), so they can be regenerated when the templates change. |
| `docs/` | Render pack format, command language, model backends and licences. |

## Quick start

### 1. Editor

```bash
cd editor
npm install
npm run dev        # http://localhost:5173
```

It opens on an example shot. Other examples are under **File**. `npm run build` produces a static site
in `editor/dist/` that you can host anywhere, since everything runs in the browser.

### 2. Scene agent (optional)

The agent works with any OpenAI-compatible endpoint. Local is the default:

```bash
ollama pull qwen3:14b
OLLAMA_ORIGINS="*" ollama serve
```

Then open **Model** in the editor. Presets cover Ollama, LM Studio, llama.cpp, OpenRouter and OpenAI.
If the browser is blocked by CORS, start the editor with
`GREYBOX_LLM_TARGET=http://localhost:11434/v1 npm run dev` and tick **Route through the dev server**.

The model never computes geometry. It writes short commands (`macro orbit cam=cam1 target=hero
from=0 to=180`) that code expands; failed lines and blocking errors (camera inside a wall, person
under the floor) go back to it once for repair. Models of about 14B parameters and up follow the
format reliably.

### 3. ComfyUI

```bash
cp -r comfyui/comfyui-greybox  /path/to/ComfyUI/custom_nodes/
```

Restart ComfyUI, then:

1. In the editor click **Export pack**. Put the `.greybox.zip` in `ComfyUI/input/` (or `input/greybox/`).
2. Open a workflow from the Templates browser under **comfyui-greybox**, or from
   `custom_nodes/comfyui-greybox/example_workflows/`.
3. Pick the pack in **Greybox Render Pack**, load your reference images, and queue.

Duration, frame rate, frame count, size and prompt all come from the pack.

## Model backends

| Workflow | Control used | Identity from | Weights licence | Notes for 24 GB GPUs |
| --- | --- | --- | --- | --- |
| `greybox_wan_vace_depth` | depth video | 1 reference image | **Apache 2.0** | 14B loaded as fp8; 832 x 480, 81 frames. 1.3B for 16 GB. |
| `greybox_ltx23_depth` | depth video (IC-LoRA) | a first frame you supply | LTX-2 Community: free under $10M revenue | 960 px long side by default. |
| `greybox_minimax_h3_control` | depth or pose video (Fun ControlNet) | up to 9 reference images | MiniMax H3 Community: **excludes US, EU, UK, South Korea** | 960 px default; trained on 5–15 s shots. |

Read [docs/backends.md](docs/backends.md) before choosing. Only the Wan path is open in the usual
sense. Greybox's own code is Apache 2.0 whatever model you use it with.

## How a shot gets from blockout to video

1. **Blocking.** Grey kit pieces (cars, doors, trees, buildings) instead of boxes, because depth
   control is literal: a box stays a box. People are procedural mannequins with poses (stand, walk,
   run, sit, talk, wave, point, crouch, lie) and a head that can follow the camera.
2. **Camera.** Keyframes or macros: `frame`, `orbit`, `push`, `crane`, `follow`, `pan`, `move`,
   `zoom`. Cuts switch cameras on the timeline.
3. **Passes.** Every frame is rendered deterministically. Depth uses one fixed range per cut, so it
   never flickers. Pose skeletons come from the exact joints in OpenPose BODY_18 colours, with hidden
   joints dropped using the depth buffer. Masks are flat per-object colours listed in the manifest.
4. **Prompt.** The shot is analysed from the scene data (framing, lens, orbit or push or crane, who
   moves where on screen) and written per model. You can edit it, or have the agent polish it
   without inventing camera moves.
5. **ComfyUI.** The loader resamples to 24 fps and 17n+5 frames (H3), 25 fps and 8n+1 (LTX), or
   16 fps and 4n+1 (Wan), and sizes the frames for the model.

## Status

This is a v0.1. What has been checked, and what has not:

- **Scene engine.** 32 Node tests cover the evaluator, mannequin, command language, macros, lint,
  shot analysis and prompts. The agent loop is tested against a mocked model server.
- **Editor.** Built and run in headless Chromium with software WebGL. It loads with zero console
  errors, every preview pass renders, and a full export round-trips (ID colours match the manifest
  pixel for pixel).
- **ComfyUI nodes.** Tested against a real exported pack for frame planning, sizing, pass loading
  and masks, using a NumPy stand-in for torch. **They have not yet been run inside a live ComfyUI.**
- **Workflows.** Built from the official templates; graph integrity and node types are checked
  against the current ComfyUI node catalog. **Not yet run end to end on a GPU.** Expect to tune
  ControlNet strength and the end percent; depth from coarse proxies can over-constrain detail.

## Known limitations

- **Character turns.** Depth from a mannequin pins the body shape. For loose clothing or long hair,
  pose control (H3) or a lower control strength works better.
- **LTX first frame.** LTX needs a first frame that matches the clay frame 0. Greybox does not
  generate it yet.
- **Imported models.** GLB files import with animation. A rigged humanoid appears in the pose pass
  when its bones follow Mixamo or common game-rig names.
- **Collaboration.** There is no multi-user editing. Projects are files, and autosave is per browser.

## Development

```bash
cd editor && npm test                         # scene engine and agent loop
cd comfyui/comfyui-greybox && python test_nodes.py path/to/pack.zip
cd comfyui/tools && python build_workflows.py # regenerate example workflows
```

In the browser console, `greybox.run('add car c1 at=3,0,0')` applies commands and
`greybox.exportPack(greybox.store.doc, { preferDisk: false })` exports without a dialog.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Apache 2.0. Third-party components and their licences are listed in [NOTICE](NOTICE). Model weights
are not part of this project and have their own licences ([docs/backends.md](docs/backends.md)).
