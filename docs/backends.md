# Model backends

Greybox's code is Apache 2.0. The video models it feeds are not part of this project, and their
licences differ a lot. Check the one you use before you ship anything made with it. This page
summarises those licences as of October 2026; it is not legal advice.

| | Wan 2.1 VACE | LTX-2.3 IC-LoRA | MiniMax H3 + Fun ControlNet Union |
| --- | --- | --- | --- |
| Weights licence | Apache 2.0 | LTX-2 Community License | MiniMax H3 Community License |
| Commercial use | Yes | Free under $10M annual revenue (whole group); above that, a paid agreement with Lightricks | Free with conditions, including showing "MiniMax H3" in your UI; separate authorisation above $20M revenue |
| Territory | Worldwide | Worldwide | Excludes the US, EU, UK and South Korea |
| Derivatives | Your choice | Must stay under the same licence | See the licence |
| Control from Greybox | depth video | depth video (IC-LoRA union) | depth or pose video (Fun ControlNet union) |
| Identity from | 1 reference image | first frame | up to 9 reference images (`<Picture N>` in the prompt) |
| Frame grid | 16 fps, 4n+1 | 25 fps, 8n+1 | 24 fps, 17n+5, trained on 124-362 frames |
| Sound | No | Yes | Yes |

## Which one to start with

- **You need it to be open, or you are in the US, EU, UK or Korea:** Wan VACE. It is the oldest and
  lowest-quality of the three, but nothing in its licence will surprise you later.
- **Best camera adherence with real people and places:** MiniMax H3, if its territory clause
  covers you. It is the only one that takes several reference images and a control video at once,
  which is the closest match to what closed reference-to-video models do.
- **Speed, sound, and you are under $10M revenue:** LTX-2.3. It needs a first frame that already
  looks like the final shot.

## 24 GB GPU notes

- **Wan 2.1 VACE 14B.** The workflow loads it in fp8 (`weight_dtype: fp8_e4m3fn`). At 832 x 480 and
  81 frames it fits with ComfyUI's offloading. The CausVid LoRA cuts sampling to a few steps at some
  cost in quality. On 16 GB use VACE 1.3B (480p only).
- **LTX-2.3 22B distilled fp8.** Weights alone are close to 24 GB, so ComfyUI offloads. Keep the long
  side at 960 or below to start.
- **MiniMax H3.** Ref2VA pruned int8 (about 21 GB) plus the 32B text encoder in nvfp4 (about 15 GB);
  they are loaded in turn. Start at 960 x 544. The 4-step Lightning LoRA in the workflow trades
  quality for speed.

## Hosted models

The pack's `previz.mp4` and generic prompt also work with closed reference-to-video services that
accept a video reference for camera motion (for example Seedance 2.5 in ComfyUI's partner nodes).
Tell the model the video only sets camera, timing and blocking, never the look. The generated prompt
does this. These services are outside the scope of this project.
