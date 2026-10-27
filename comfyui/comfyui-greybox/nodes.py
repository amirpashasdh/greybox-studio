"""Greybox render pack nodes for ComfyUI.

A render pack is the zip exported by the Greybox editor:

    manifest.json            timing, depth ranges, object id colours, prompts per model
    rgb/00000.png ...        clay previz
    depth/00000.png ...      inverse depth, white = near
    pose/00000.png ...       OpenPose BODY_18 skeletons
    ids/00000.png ...        flat per-object colours

"Greybox Render Pack" reads the manifest and decides which source frames to use so the clip lands on
the frame rate and frame-count grid a model expects (MiniMax H3: 24 fps, 17n+5; LTX-2: 25 fps, 8n+1;
Wan: 16 fps, 4n+1). "Greybox Pass" then loads one pass as an IMAGE batch, so you only pay memory for
the passes you actually wire up.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import zipfile
from dataclasses import dataclass, field

import numpy as np
import torch
from PIL import Image

try:
    import folder_paths  # provided by ComfyUI
except ImportError:  # running the unit tests outside ComfyUI
    folder_paths = None


@dataclass(frozen=True)
class Backend:
    key: str  # prompt key in the manifest
    fps: float | None  # None = keep the pack's frame rate
    step: int  # frame counts must be step * k + offset
    offset: int
    max_frames: int  # 0 = no default cap
    min_frames: int  # shorter shots hold their last frame up to this (model's trained range)
    long_side: int  # default output size (long side), tuned for 24 GB GPUs
    multiple: int  # width and height are rounded to this


BACKENDS = {
    # MiniMax H3 is trained on roughly 124-362 frames (5-15 s at 24 fps).
    "MiniMax H3 (24 fps, 17n+5)": Backend("h3", 24.0, 17, 5, 362, 124, 960, 32),
    "LTX-2 (25 fps, 8n+1)": Backend("ltx", 25.0, 8, 1, 257, 9, 960, 32),
    "Wan VACE (16 fps, 4n+1)": Backend("wan", 16.0, 4, 1, 81, 5, 832, 16),
    "Pack as exported": Backend("generic", None, 1, 0, 0, 1, 0, 8),
}

PASSES = ["depth", "pose", "rgb", "ids"]


# ----------------------------------------------------------------------------- pack access


@dataclass
class Pack:
    """What flows between the Greybox nodes (as the GREYBOX_PACK type)."""

    path: str
    manifest: dict
    backend: str
    indices: list  # source frame index for each output frame
    fps: float
    width: int
    height: int
    _zip: object = field(default=None, repr=False)

    @property
    def frames(self) -> int:
        return len(self.indices)

    def _open(self):
        if os.path.isdir(self.path):
            return None
        if self._zip is None:
            self._zip = zipfile.ZipFile(self.path)
        return self._zip

    def has_pass(self, name: str) -> bool:
        return name in self.manifest.get("passes", {})

    def read(self, rel: str) -> bytes:
        z = self._open()
        if z is None:
            with open(os.path.join(self.path, rel), "rb") as f:
                return f.read()
        return z.read(rel)

    def frame_path(self, name: str, index: int) -> str:
        return f"{name}/{index:05d}.png"

    def load_frame(self, name: str, index: int, resample) -> np.ndarray:
        img = Image.open(io.BytesIO(self.read(self.frame_path(name, index)))).convert("RGB")
        if img.size != (self.width, self.height):
            img = img.resize((self.width, self.height), resample)
        return np.asarray(img, dtype=np.uint8)


def _input_dir() -> str:
    if folder_paths is not None:
        return folder_paths.get_input_directory()
    return os.path.abspath("input")


def list_packs() -> list:
    """Zips (and unzipped pack folders) in ComfyUI/input and ComfyUI/input/greybox."""
    root = _input_dir()
    found = []
    for sub in ["", "greybox"]:
        d = os.path.join(root, sub)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            full = os.path.join(d, name)
            rel = os.path.join(sub, name) if sub else name
            if name.lower().endswith(".zip"):
                found.append(rel)
            elif os.path.isdir(full) and os.path.isfile(os.path.join(full, "manifest.json")):
                found.append(rel)
    return found or ["(put a .greybox.zip in ComfyUI/input)"]


def resolve_pack_path(pack: str, path: str) -> str:
    if path and path.strip():
        p = os.path.expanduser(path.strip())
        if not os.path.exists(p):
            raise FileNotFoundError(f"Greybox: no pack at {p}")
        return p
    p = os.path.join(_input_dir(), pack)
    if not os.path.exists(p):
        raise FileNotFoundError(
            "Greybox: put the render pack exported from the editor into ComfyUI/input "
            "(or ComfyUI/input/greybox), then pick it in the node. You can also paste a full path."
        )
    return p


def read_manifest(path: str) -> dict:
    if os.path.isdir(path):
        with open(os.path.join(path, "manifest.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    with zipfile.ZipFile(path) as z:
        return json.loads(z.read("manifest.json").decode("utf-8"))


# ----------------------------------------------------------------------------- timing


def plan_frames(src_frames: int, src_fps: float, backend: Backend, max_frames: int = 0, seconds: float = 0.0):
    """Choose source frames for the target frame rate and frame-count grid.

    Returns (indices, fps). Frame counts are rounded DOWN onto the grid so the clip never runs past
    the blocked action; if the shot is shorter than one grid step, the last frame is held.
    """
    fps = backend.fps or src_fps
    duration = src_frames / src_fps
    if seconds and seconds > 0:
        duration = min(duration, seconds)
    n = int(math.floor(duration * fps + 1e-6))
    cap = max_frames if max_frames and max_frames > 0 else backend.max_frames
    if cap:
        n = min(n, cap)
    n = max(n, backend.min_frames)
    if backend.step > 1:
        k = max(1, (n - backend.offset) // backend.step)
        n = backend.step * k + backend.offset
        if n < backend.min_frames:
            n += backend.step
    n = max(1, n)
    indices = [min(src_frames - 1, int(round(i * src_fps / fps))) for i in range(n)]
    return indices, fps


def fit_size(src_w: int, src_h: int, long_side: int, multiple: int):
    if long_side and long_side > 0:
        s = long_side / max(src_w, src_h)
        w, h = src_w * s, src_h * s
    else:
        w, h = src_w, src_h
    m = max(1, multiple)
    return max(m, int(round(w / m)) * m), max(m, int(round(h / m)) * m)


def _hash_file(path: str) -> str:
    st = os.stat(path)
    return f"{path}:{st.st_mtime_ns}:{st.st_size}"


def _to_image(frames: list) -> torch.Tensor:
    arr = np.stack(frames).astype(np.float32) / 255.0
    return torch.from_numpy(arr)


def _id_mask(ids_frames: np.ndarray, colors: list) -> torch.Tensor:
    """MASK (B, H, W): 1 where the ids pass shows any of the given colours."""
    packed = (ids_frames[..., 0].astype(np.int32) << 16) | (ids_frames[..., 1].astype(np.int32) << 8) | ids_frames[..., 2].astype(np.int32)
    keys = np.array([(c[0] << 16) | (c[1] << 8) | c[2] for c in colors], dtype=np.int32) if colors else np.array([-1], dtype=np.int32)
    return torch.from_numpy(np.isin(packed, keys).astype(np.float32))


# ----------------------------------------------------------------------------- nodes


class GreyboxRenderPack:
    """Open a render pack and fit it to a video model's timing."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pack": (list_packs(), {"tooltip": "A .greybox.zip exported from the editor, placed in ComfyUI/input or ComfyUI/input/greybox."}),
                "model": (list(BACKENDS.keys()), {"tooltip": "Sets frame rate, frame-count grid, default size and which prompt to use."}),
                "long_side": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 16, "tooltip": "Output long side in pixels. 0 uses the model default (sized for 24 GB GPUs)."}),
                "max_frames": ("INT", {"default": 0, "min": 0, "max": 2000, "tooltip": "Upper limit on frames. 0 uses the model default."}),
                "max_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 120.0, "step": 0.5, "tooltip": "Use only the first N seconds of the shot. 0 uses the whole shot."}),
            },
            "optional": {
                "path": ("STRING", {"default": "", "tooltip": "Full path to a pack zip or folder. Overrides the list above."}),
                "prompt_override": ("STRING", {"default": "", "multiline": True, "tooltip": "Leave empty to use the prompt written in the editor for this model."}),
            },
        }

    RETURN_TYPES = ("GREYBOX_PACK", "STRING", "INT", "FLOAT", "INT", "INT", "STRING")
    RETURN_NAMES = ("pack", "prompt", "frames", "fps", "width", "height", "info")
    FUNCTION = "load"
    CATEGORY = "Greybox"
    DESCRIPTION = "Loads a Greybox render pack and resamples it to the model's frame rate and frame-count grid."

    @classmethod
    def IS_CHANGED(cls, pack, model, long_side, max_frames, max_seconds, path="", prompt_override=""):
        try:
            p = resolve_pack_path(pack, path)
            stamp = _hash_file(os.path.join(p, "manifest.json") if os.path.isdir(p) else p)
        except Exception:
            stamp = "missing"
        return hashlib.sha256(f"{stamp}|{model}|{long_side}|{max_frames}|{max_seconds}|{prompt_override}".encode()).hexdigest()

    def load(self, pack, model, long_side, max_frames, max_seconds, path="", prompt_override=""):
        p = resolve_pack_path(pack, path)
        manifest = read_manifest(p)
        if manifest.get("generator") != "greybox-studio":
            raise ValueError("Greybox: this zip has no Greybox manifest. Export it from the editor with Export pack.")
        backend = BACKENDS[model]
        indices, fps = plan_frames(int(manifest["frames"]), float(manifest["fps"]), backend, max_frames, max_seconds)
        w, h = fit_size(int(manifest["width"]), int(manifest["height"]), long_side or backend.long_side, backend.multiple)
        prompts = manifest.get("prompts", {})
        prompt = prompt_override.strip() if prompt_override and prompt_override.strip() else prompts.get(backend.key) or prompts.get("generic", "")
        pk = Pack(p, manifest, model, indices, fps, w, h)
        refs = manifest.get("refs") or []
        ref_lines = [f"  {i + 1}: {r.get('id')}{' - ' + r['label'] if r.get('label') else ''}" for i, r in enumerate(refs)]
        held = max(0, len(indices) - len(set(indices)))
        info = "\n".join([
            f"{manifest.get('name', 'shot')}: {len(indices)} frames at {fps:g} fps ({len(indices) / fps:.2f} s), {w} x {h}",
            *([f"note: the shot is shorter than this model's trained range; the last frame is held for {held} frames"] if backend.min_frames > 1 and int(manifest['frames']) / float(manifest['fps']) * fps < backend.min_frames else []),
            f"source: {manifest['frames']} frames at {manifest['fps']} fps, {manifest['width']} x {manifest['height']}",
            f"passes: {', '.join(manifest.get('passes', {}).keys())}",
            "reference images, in order:" if refs else "no reference images declared in the editor",
            *ref_lines,
        ])
        return (pk, prompt, len(indices), float(fps), w, h, info)


class GreyboxPass:
    """Load one pass of a render pack as an IMAGE batch (and a matching MASK)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pack": ("GREYBOX_PACK",),
                "pass_name": (PASSES, {"default": "depth", "tooltip": "depth and pose are control videos; rgb is the clay previz; ids are flat object colours."}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("frames", "character_mask", "first_frame")
    FUNCTION = "load"
    CATEGORY = "Greybox"
    DESCRIPTION = "Frames of one Greybox pass, already at the model's frame rate and size. character_mask covers every character."

    def load(self, pack: Pack, pass_name):
        if not pack.has_pass(pass_name):
            raise ValueError(f"Greybox: the pack has no {pass_name} pass. Re-export with that pass ticked.")
        resample = Image.NEAREST if pass_name == "ids" else Image.LANCZOS if pass_name == "rgb" else Image.BILINEAR
        cache = {}
        frames = []
        for i in pack.indices:
            if i not in cache:
                cache[i] = pack.load_frame(pass_name, i, resample)
            frames.append(cache[i])
        images = _to_image(frames)
        mask = self._characters(pack)
        return (images, mask, images[:1])

    def _characters(self, pack: Pack):
        if not pack.has_pass("ids"):
            return torch.zeros((pack.frames, pack.height, pack.width))
        colors = [o["id_color"] for o in pack.manifest.get("objects", []) if o.get("role") == "character" and o.get("id_color")]
        cache = {}
        ids = []
        for i in pack.indices:
            if i not in cache:
                cache[i] = pack.load_frame("ids", i, Image.NEAREST)
            ids.append(cache[i])
        return _id_mask(np.stack(ids), colors)


class GreyboxObjectMask:
    """MASK for chosen objects, from the ids pass: for inpainting or regional control."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pack": ("GREYBOX_PACK",),
                "objects": ("STRING", {"default": "", "tooltip": "Comma-separated object ids from the editor, or role:character / role:prop / role:set."}),
                "grow": ("INT", {"default": 0, "min": 0, "max": 64, "tooltip": "Dilate the mask by this many pixels."}),
            }
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "mask"
    CATEGORY = "Greybox"

    def mask(self, pack: Pack, objects, grow):
        wanted = [s.strip() for s in objects.split(",") if s.strip()]
        objs = pack.manifest.get("objects", [])
        colors = []
        for w in wanted:
            if w.startswith("role:"):
                colors += [o["id_color"] for o in objs if o.get("role") == w[5:] and o.get("id_color")]
            else:
                match = [o for o in objs if o.get("id") == w or o.get("id", "").startswith(w + ".")]
                if not match:
                    raise ValueError(f"Greybox: no object called {w}. Known ids: {', '.join(o['id'] for o in objs)}")
                colors += [o["id_color"] for o in match if o.get("id_color")]
        ids = np.stack([pack.load_frame("ids", i, Image.NEAREST) for i in pack.indices])
        m = _id_mask(ids, colors)
        if grow > 0:
            k = 2 * grow + 1
            m = torch.nn.functional.max_pool2d(m.unsqueeze(1), k, stride=1, padding=grow).squeeze(1)
        return (m,)


NODE_CLASS_MAPPINGS = {
    "GreyboxRenderPack": GreyboxRenderPack,
    "GreyboxPass": GreyboxPass,
    "GreyboxObjectMask": GreyboxObjectMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GreyboxRenderPack": "Greybox Render Pack",
    "GreyboxPass": "Greybox Pass",
    "GreyboxObjectMask": "Greybox Object Mask",
}
