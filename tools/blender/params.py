"""Every number of the hand pipeline (hand-plan.md sections 3 and 6)."""

# ---- caps (checked in report.json) ------------------------------------------
CAP_TOTAL_VERTS = 12000          # skin + nails, after export splits
CAP_GLB_BYTES = 1150 * 1024      # public/models total (no detail map yet)
CAP_NAIL_VERTS = 420             # per plate

# Vertex colour masks (masks.py): one FLOAT_COLOR attribute on the points.
MASK_ATTR = 'Col'
