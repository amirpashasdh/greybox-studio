"""Greybox for ComfyUI: load render packs exported by the Greybox editor.

Example workflows for MiniMax H3, LTX-2 and Wan VACE are in example_workflows/ and show up in
ComfyUI's template browser under this node pack.
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
