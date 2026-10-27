"""Build the Greybox example workflows from the official ComfyUI templates.

The official templates (MIT, Comfy Org; vendored in ./official with the commit they came from) each
start by loading a video and estimating depth or pose from it. Greybox already has exact depth and
pose, so this script removes those stages and wires in the Greybox nodes instead:

    MiniMax H3  Ref2VA + Fun ControlNet Union  <- depth pass, two reference images, Greybox prompt
    LTX-2.3     IC-LoRA union control          <- depth pass, a first frame you provide, Greybox prompt
    Wan 2.1     VACE 14B                       <- depth pass, one reference image, Greybox prompt

Run:  python build_workflows.py      (writes ../comfyui-greybox/example_workflows/*.json)
"""

from __future__ import annotations

import copy
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "comfyui-greybox", "example_workflows")


class Graph:
    """Minimal editor for ComfyUI 'save format' (LiteGraph) workflows."""

    def __init__(self, data: dict):
        self.d = copy.deepcopy(data)

    @property
    def nodes(self):
        return self.d["nodes"]

    def node(self, nid):
        for n in self.nodes:
            if n["id"] == nid:
                return n
        raise KeyError(nid)

    def _next_node_id(self):
        self.d["last_node_id"] = max([self.d.get("last_node_id", 0)] + [n["id"] for n in self.nodes]) + 1
        return self.d["last_node_id"]

    def _next_link_id(self):
        self.d["last_link_id"] = max([self.d.get("last_link_id", 0)] + [l[0] for l in self.d["links"]]) + 1
        return self.d["last_link_id"]

    def remove(self, *ids):
        ids = set(ids)
        doomed = [l for l in self.d["links"] if l[1] in ids or l[3] in ids]
        for l in doomed:
            self.unlink(l[0])
        removed_types = {n["type"] for n in self.nodes if n["id"] in ids}
        self.d["nodes"] = [n for n in self.nodes if n["id"] not in ids]
        # Drop subgraph definitions that are no longer used by any node.
        used = {n["type"] for n in self.nodes}
        subs = self.d.get("definitions", {}).get("subgraphs")
        if subs is not None:
            self.d["definitions"]["subgraphs"] = [s for s in subs if s["id"] in used or s["id"] not in removed_types]

    def unlink(self, link_id):
        link = next((l for l in self.d["links"] if l[0] == link_id), None)
        if not link:
            return
        _, src, _, dst, _, _ = link
        for n in self.nodes:
            if n["id"] == dst:
                for i in n.get("inputs", []):
                    if i.get("link") == link_id:
                        i["link"] = None
            if n["id"] == src:
                for o in n.get("outputs", []):
                    if o.get("links") and link_id in o["links"]:
                        o["links"] = [x for x in o["links"] if x != link_id]
        self.d["links"] = [l for l in self.d["links"] if l[0] != link_id]

    def add(self, type_, pos, size, widgets=None, inputs=None, outputs=None, title=None, color=None, props=None):
        nid = self._next_node_id()
        n = {
            "id": nid,
            "type": type_,
            "pos": list(pos),
            "size": list(size),
            "flags": {},
            "order": 0,
            "mode": 0,
            "inputs": inputs or [],
            "outputs": [{"name": name, "type": t, "links": []} for name, t in (outputs or [])],
            "properties": {"Node name for S&R": type_, **(props or {})},
            "widgets_values": widgets if widgets is not None else [],
        }
        if title:
            n["title"] = title
        if color:
            n["color"], n["bgcolor"] = color
        self.nodes.append(n)
        return nid

    def ensure_input(self, nid, name, type_, widget=False, label=None, shape=None):
        n = self.node(nid)
        for i in n.setdefault("inputs", []):
            if i["name"] == name:
                return i
        entry = {"name": name, "type": type_, "link": None}
        if label:
            entry["label"] = label
        if shape is not None:
            entry["shape"] = shape
        if widget:
            entry["widget"] = {"name": name}
        n["inputs"].append(entry)
        return entry

    def connect(self, src, src_slot, dst, dst_input):
        sn, dn = self.node(src), self.node(dst)
        out = sn["outputs"][src_slot]
        inp = next((i for i in dn["inputs"] if i["name"] == dst_input), None)
        if inp is None:
            raise KeyError(f"node {dst} ({dn['type']}) has no input {dst_input}")
        if inp.get("link") is not None:
            self.unlink(inp["link"])
        lid = self._next_link_id()
        self.d["links"].append([lid, src, src_slot, dst, dn["inputs"].index(inp), out["type"]])
        inp["link"] = lid
        out.setdefault("links", []).append(lid)
        return lid

    def note(self, pos, size, text, title="Greybox"):
        return self.add("MarkdownNote", pos, size, widgets=[text], title=title)

    def validate(self):
        ids = {n["id"] for n in self.nodes}
        by_id = {n["id"]: n for n in self.nodes}
        for lid, src, ss, dst, ds, _t in self.d["links"]:
            assert src in ids and dst in ids, f"link {lid} points at a missing node"
            assert lid in (by_id[src]["outputs"][ss].get("links") or []), f"link {lid} missing on source output"
            assert by_id[dst]["inputs"][ds].get("link") == lid, f"link {lid} missing on target input"
        link_ids = {l[0] for l in self.d["links"]}
        for n in self.nodes:
            for i in n.get("inputs", []):
                assert i.get("link") is None or i["link"] in link_ids, f"node {n['id']} input {i['name']} has dangling link"
            for o in n.get("outputs", []):
                for l in o.get("links") or []:
                    assert l in link_ids, f"node {n['id']} output {o['name']} has dangling link {l}"
        return True

    def save(self, path, title):
        self.d.setdefault("extra", {})["greybox"] = {"title": title, "built_from": "Comfy-Org/workflow_templates (MIT)"}
        self.validate()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.d, f, indent=1, ensure_ascii=False)


GB_COLOR = ("#3d2a33", "#5c3a4a")  # spike-tape pink, darkened


def add_greybox(g: Graph, pos, model, pass_name="depth"):
    """Render Pack + Pass + an info preview. Returns (pack_id, pass_id)."""
    x, y = pos
    pack = g.add(
        "GreyboxRenderPack", (x, y), (380, 330),
        widgets=["shot.greybox.zip", model, 0, 0, 0.0, "", ""],
        inputs=[],
        outputs=[("pack", "GREYBOX_PACK"), ("prompt", "STRING"), ("frames", "INT"), ("fps", "FLOAT"), ("width", "INT"), ("height", "INT"), ("info", "STRING")],
        title="Greybox Render Pack", color=GB_COLOR,
    )
    pas = g.add(
        "GreyboxPass", (x + 420, y), (300, 110), widgets=[pass_name],
        inputs=[{"name": "pack", "type": "GREYBOX_PACK", "link": None}],
        outputs=[("frames", "IMAGE"), ("character_mask", "MASK"), ("first_frame", "IMAGE")],
        title=f"Greybox Pass ({pass_name})", color=GB_COLOR,
    )
    g.connect(pack, 0, pas, "pack")
    info = g.add("PreviewAny", (x, y + 370), (380, 180), widgets=[], inputs=[{"name": "source", "type": "*", "link": None}], outputs=[("STRING", "STRING")], title="Pack info")
    g.connect(pack, 6, info, "source")
    prev = g.add("PreviewImage", (x + 420, y + 150), (300, 260), widgets=[], inputs=[{"name": "images", "type": "IMAGE", "link": None}], outputs=[], title="Control video")
    g.connect(pas, 0, prev, "images")
    return pack, pas


def build_h3():
    src = json.load(open(os.path.join(HERE, "official", "video_minimax_h3_fun_controlnet_union.json"), encoding="utf-8"))
    g = Graph(src)
    loader = g.node(174)
    x, y = loader["pos"]
    # Video loading, pose estimation, the hand-set duration/size and the demo prompt are replaced.
    g.remove(174, 705, 700, 704, 709, 710, 713, 714, 131, 132, 115, 140, 138, 712)
    pack, pas = add_greybox(g, (x - 60, y), "MiniMax H3 (24 fps, 17n+5)", "depth")
    g.connect(pas, 0, 172, "control_video")
    g.connect(pack, 1, 136, "prompt")
    g.connect(pack, 2, 136, "length")
    g.connect(pack, 4, 136, "width")
    g.connect(pack, 5, 136, "height")
    # Two reference images: Picture 1 and Picture 2 in the Greybox prompt.
    rx, ry = g.node(136)["pos"]
    for k, (name, label) in enumerate([("ref_images.ref_image_0", "Picture 1"), ("ref_images.ref_image_1", "Picture 2")]):
        g.ensure_input(136, name, "IMAGE", label=name.split(".")[1], shape=7)
        img = g.add("LoadImage", (rx - 760 + k * 330, ry - 470), (310, 340), widgets=["example.png", "image"],
                    outputs=[("IMAGE", "IMAGE"), ("MASK", "MASK")], title=f"{label} (reference image {k + 1})")
        g.connect(img, 0, 136, name)
    g.note((x - 60, y - 420), (720, 380), H3_NOTE)
    return g


def build_ltx():
    src = json.load(open(os.path.join(HERE, "official", "video_ltx2_3_ic_lora.json"), encoding="utf-8"))
    g = Graph(src)
    x, y = g.node(199)["pos"]
    g.remove(199, 692, 697, 693)
    pack, pas = add_greybox(g, (x - 80, y + 260), "LTX-2 (25 fps, 8n+1)", "depth")
    g.connect(pas, 0, 129, "input_1")
    g.connect(pack, 1, 129, "text")
    g.connect(pack, 4, 129, "value")
    g.connect(pack, 5, 129, "value_1")
    g.node(200)["title"] = "First frame (styled version of the clay frame 0)"
    g.note((x - 80, y - 200), (720, 420), LTX_NOTE)
    return g


def build_wan():
    src = json.load(open(os.path.join(HERE, "official", "video_wan_vace_14B_v2v.json"), encoding="utf-8"))
    g = Graph(src)
    x, y = g.node(145)["pos"]
    g.remove(145, 144, 147, 146)
    pack, pas = add_greybox(g, (x - 60, y), "Wan VACE (16 fps, 4n+1)", "depth")
    g.connect(pas, 0, 49, "control_video")
    for name in ["width", "height", "length"]:
        g.ensure_input(49, name, "INT", widget=True)
    g.connect(pack, 4, 49, "width")
    g.connect(pack, 5, 49, "height")
    g.connect(pack, 2, 49, "length")
    g.ensure_input(6, "text", "STRING", widget=True)
    g.connect(pack, 1, 6, "text")
    # 14B in fp16 is 32 GB of weights: cast to fp8 at load so it fits a 24 GB card.
    unet = g.node(106)
    unet["widgets_values"] = [unet["widgets_values"][0], "fp8_e4m3fn"]
    g.node(134)["title"] = "Reference image (the main character)"
    g.note((x - 60, y - 430), (720, 400), WAN_NOTE)
    return g


H3_NOTE = """## Greybox -> MiniMax H3

1. Export a render pack from the Greybox editor and put the zip in `ComfyUI/input` (or `input/greybox`). Pick it in **Greybox Render Pack**.
2. Load your reference images in the order you declared them in the editor (they are `<Picture 1>`, `<Picture 2>` in the prompt). **Pack info** lists that order.
3. **Greybox Pass** feeds the Fun ControlNet. `depth` holds camera, layout and silhouettes; switch it to `pose` when the performance matters more than the set.
4. Duration, size and prompt come from the pack. Type into `prompt_override` on the Render Pack to replace the prompt.

Memory: defaults are sized for a 24 GB GPU (960 px long side). Raise `long_side` toward 1344 on larger cards.

License: MiniMax H3 open weights are under the MiniMax H3 Community License, whose territory clause excludes the US, EU, UK and South Korea. Check it before you use the weights."""

LTX_NOTE = """## Greybox -> LTX-2.3 (IC-LoRA depth)

1. Export a render pack and pick it in **Greybox Render Pack**. The depth pass becomes the IC-LoRA control video; length follows the pack.
2. LTX starts from a **first frame**. Make it match the clay frame 0 (same framing and layout): render the depth `first_frame` through any depth-controlled image model, or paint over the clay frame. A mismatched first frame fights the control video.
3. Prompt and size come from the pack. LTX also generates sound; the pack's Sound line goes into the prompt.

Memory: 960 px long side by default for 24 GB GPUs; the template's own default is 1280 x 704.

License: LTX-2 weights are free for organisations under $10M annual revenue; larger ones need a commercial agreement with Lightricks."""

WAN_NOTE = """## Greybox -> Wan 2.1 VACE (Apache 2.0)

1. Export a render pack and pick it in **Greybox Render Pack**. The depth pass is VACE's control video; width, height and length follow the pack (81 frames at 16 fps by default).
2. **Reference image**: one image of the main character, ideally on a plain background.
3. The prompt comes from the pack (Wan VACE tab in the editor).

Memory: the 14B model is loaded as fp8 so it fits a 24 GB GPU; for 16 GB use the 1.3B model (480p only). The CausVid LoRA in this template trades some quality for about 10x speed.

License: Wan 2.1 VACE weights are Apache 2.0, the most permissive of the three backends."""


if __name__ == "__main__":
    for name, fn, title in [
        ("greybox_minimax_h3_control.json", build_h3, "Greybox -> MiniMax H3 (depth control + references)"),
        ("greybox_ltx23_depth.json", build_ltx, "Greybox -> LTX-2.3 (depth IC-LoRA)"),
        ("greybox_wan_vace_depth.json", build_wan, "Greybox -> Wan 2.1 VACE (depth)"),
    ]:
        g = fn()
        g.save(os.path.join(OUT, name), title)
        print(f"wrote {name}: {len(g.nodes)} nodes, {len(g.d['links'])} links")
