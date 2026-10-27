# Render pack format (version 1)

A render pack is a zip produced by **Export pack** in the editor. It is meant to be easy to read from
any tool, not only the ComfyUI nodes in this repository.

```
shot.greybox.zip
├── manifest.json
├── scene.greybox.txt        the scene as Greybox commands
├── previz.mp4               clay pass as H.264, when the browser could encode it
├── rgb/00000.png ...        clay previz
├── depth/00000.png ...      inverse depth
├── pose/00000.png ...       OpenPose BODY_18
└── ids/00000.png ...        per-object flat colours
```

Frames are numbered from `00000`. Frame `i` shows the scene at `t = i / fps`. Every pass has the same
number of frames, the same size and the same timing.

## manifest.json

| Field | Meaning |
| --- | --- |
| `generator` | Always `"greybox-studio"`. |
| `format` | Pack format version, currently `1`. |
| `name` | Shot name. |
| `width`, `height`, `fps`, `frames`, `duration` | Frame size, rate and count. `frames = round(duration * fps)`. |
| `passes` | Map of pass name to path pattern, e.g. `"depth": "depth/{frame:05d}.png"`. Only exported passes are listed. |
| `depth` | `{ encoding: "inverse", ranges: [{ t0, t1, near, far }], note }`, one range per cut. |
| `objects` | `[{ id, name, desc, role, type, id_color: [r, g, b] }]`. `role` is `set`, `prop` or `character`. |
| `cuts` | `[{ t, camera }]`, sorted by time. |
| `refs` | Reference image slots: `[{ slot, id, label }]`. `id` is an object id, `location` or `style`. |
| `look`, `audio` | Shot-level text from the editor. |
| `shots` | Per-cut analysis: framing, angle, lens, camera moves, subject and actions. |
| `prompts` | `{ generic, h3, ltx, wan }`. A prompt you edited in the editor replaces the generated one. |
| `scene` | The full scene document, so the pack can be reopened in the editor. |

## Passes

**rgb.** Clay-grey render with a sun and ambient light, supersampled 2x. Use it as a reference
video, for review, or as the base for a painted first frame.

**depth.** Single-channel greyscale stored as RGB. Per pixel:

```
value = (1/z - 1/far) / (1/near - 1/far)      clamped to 0..1, then x255
```

Here `z` is the view-space distance in metres, and `near`/`far` come from the range of the cut the
frame belongs to. White is near, black is far, and empty background is black. This matches the
relative inverse depth that depth estimators such as Depth Anything produce, which is what depth
ControlNets and IC-LoRAs are trained on. The range is fixed within a cut, so the pass does not
flicker. Recover metric depth with `z = 1 / (value/255 * (1/near - 1/far) + 1/far)`.

**pose.** OpenPose BODY_18 on black, drawn from exact joint positions. It uses the limb order and
colours of the reference implementation (controlnet_aux `draw_bodypose`). Joints hidden behind
geometry are dropped using the depth buffer. Eyes, ears and nose show only when their side of the
head faces the camera.

**ids.** Each object has one flat colour (`objects[].id_color`), written without colour-space
conversion, so values match exactly. Background is `0,0,0`. Groups have a colour but are never
drawn; their children are. Build masks by matching colours, for example every object with
`role == "character"`.
