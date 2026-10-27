"""Tests for the Greybox nodes. Run from this folder:

    python test_nodes.py path/to/shot.greybox.zip

Uses real torch when installed; otherwise a tiny numpy stand-in, since the nodes only need
torch.from_numpy, torch.zeros and max_pool2d.
"""

import sys
import types

import numpy as np

try:
    import torch  # noqa: F401
except ImportError:
    class _T(np.ndarray):
        def unsqueeze(self, d):
            return np.expand_dims(np.asarray(self), d).view(_T)

        def squeeze(self, d=None, axis=None):
            return np.asarray(self).squeeze(axis if d is None else d).view(_T)

    def _max_pool2d(x, k, stride=1, padding=0):
        x = np.asarray(x)
        p = np.pad(x, ((0, 0), (0, 0), (padding, padding), (padding, padding)), constant_values=-np.inf)
        out = np.full_like(x, -np.inf)
        for dy in range(k):
            for dx in range(k):
                out = np.maximum(out, p[:, :, dy:dy + x.shape[2], dx:dx + x.shape[3]])
        return out.view(_T)

    torch = types.ModuleType("torch")
    torch.from_numpy = lambda a: np.asarray(a).view(_T)
    torch.zeros = lambda shape: np.zeros(shape, dtype=np.float32).view(_T)
    torch.Tensor = np.ndarray
    torch.nn = types.SimpleNamespace(functional=types.SimpleNamespace(max_pool2d=_max_pool2d))
    sys.modules["torch"] = torch

from nodes import BACKENDS, GreyboxObjectMask, GreyboxPass, GreyboxRenderPack, fit_size, plan_frames  # noqa: E402


def test_plan_frames():
    h3 = BACKENDS["MiniMax H3 (24 fps, 17n+5)"]
    idx, fps = plan_frames(192, 24, h3)  # 8 s at 24 fps
    assert fps == 24 and len(idx) == 192 and (len(idx) - 5) % 17 == 0, len(idx)  # 192 = 17*11 + 5
    idx, _ = plan_frames(200, 24, h3)
    assert len(idx) == 192, len(idx)  # rounds down onto the grid
    ltx = BACKENDS["LTX-2 (25 fps, 8n+1)"]
    idx, fps = plan_frames(192, 24, ltx)
    assert len(idx) % 8 == 1 and len(idx) <= 200 and idx[-1] <= 191
    wan = BACKENDS["Wan VACE (16 fps, 4n+1)"]
    idx, _ = plan_frames(192, 24, wan)
    assert len(idx) == 81 and idx[1] == 2  # 24 -> 16 fps takes every 1.5th frame
    idx, _ = plan_frames(10, 24, h3)  # shorter than H3's trained range: hold the last frame
    assert len(idx) == 124 and idx[-1] == 9, len(idx)
    assert fit_size(1280, 720, 960, 32) == (960, 544)


def test_pack(path):
    rp = GreyboxRenderPack()
    for model in BACKENDS:
        pack, prompt, frames, fps, w, h, info = rp.load("", model, 0, 0, 0.0, path=path)
        assert frames == len(pack.indices) and w % 8 == 0 and h % 8 == 0
        assert prompt, f"no prompt for {model}"
        print(f"{model}: {frames} frames @ {fps} fps, {w}x{h}")
    pack, *_ = rp.load("", "Wan VACE (16 fps, 4n+1)", 0, 0, 0.0, path=path)
    for name in ["depth", "pose", "rgb", "ids"]:
        img, mask, first = GreyboxPass().load(pack, name)
        assert img.shape == (pack.frames, pack.height, pack.width, 3), img.shape
        assert float(img.max()) <= 1.0 and first.shape[0] == 1
    assert float(mask.max()) == 1.0, "character mask should cover the characters"
    chars = [o["id"] for o in pack.manifest["objects"] if o["role"] == "character"]
    (m,) = GreyboxObjectMask().mask(pack, chars[0], 2)
    assert m.shape == mask.shape and float(m.sum()) > 0
    (m2,) = GreyboxObjectMask().mask(pack, "role:character", 0)
    assert float(np.asarray(m2).sum()) == float(np.asarray(mask).sum())
    print("pass loading ok:", pack.frames, "frames,", pack.width, "x", pack.height)


if __name__ == "__main__":
    test_plan_frames()
    print("timing ok")
    if len(sys.argv) > 1:
        test_pack(sys.argv[1])
