# comfyui-greybox

ComfyUI nodes for render packs exported by the [Greybox editor](../../README.md): exact depth, pose
and object masks from a 3D blockout, resampled to the frame rate and frame-count grid each video
model expects.

## Install

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI. No extra Python dependencies.

## Nodes

**Greybox Render Pack.** Opens a `.greybox.zip` from `ComfyUI/input` (or `input/greybox`), or from
a full path.

| Input | |
| --- | --- |
| `model` | MiniMax H3 (24 fps, 17n+5), LTX-2 (25 fps, 8n+1), Wan VACE (16 fps, 4n+1), or the pack's own timing. |
| `long_side` | Output size. `0` uses a default sized for 24 GB GPUs. |
| `max_frames`, `max_seconds` | Trim long shots. |
| `prompt_override` | Replaces the prompt written in the editor. |

Outputs: `pack`, `prompt` (written for the chosen model), `frames`, `fps`, `width`, `height`, and
`info`, which includes the order of reference images the prompt expects.

Frame counts are rounded down onto the model's grid, so the clip never runs past the blocked action.
For MiniMax H3, shots shorter than its trained range (about 5 s) hold their last frame.

**Greybox Pass.** One pass as an IMAGE batch: `depth`, `pose`, `rgb` or `ids`. Also outputs a
`character_mask` covering every character, and the `first_frame`.

**Greybox Object Mask.** A MASK for chosen object ids, for example `hero,car1`, or a role such as
`role:character`, with optional growth in pixels. Use it for VACE or Fun ControlNet inpainting, or
for regional prompts.

## Example workflows

`example_workflows/` holds three workflows, built from the official Comfy Org templates with the
video-loading and depth/pose estimation stages replaced by Greybox nodes:

- `greybox_minimax_h3_control.json`: MiniMax H3 Ref2VA with the Fun ControlNet Union. Depth (or
  pose) control plus two reference images.
- `greybox_ltx23_depth.json`: LTX-2.3 IC-LoRA union control from the depth pass, plus a first
  frame you supply.
- `greybox_wan_vace_depth.json`: Wan 2.1 VACE 14B (fp8) from the depth pass, plus one reference
  image.

Each workflow has a note with model download links, memory advice and the weights licence. Wan is
Apache 2.0. LTX-2 is free under $10M revenue. MiniMax H3's licence excludes the US, EU, UK and
South Korea.
