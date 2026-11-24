"""Every number of the hand pipeline (hand-plan.md sections 3 and 6)."""

# ---- caps (checked in report.json) ------------------------------------------
CAP_TOTAL_VERTS = 12000          # skin + nails, after export splits
CAP_GLB_BYTES = 1150 * 1024      # public/models total (no detail map yet)
CAP_NAIL_VERTS = 420             # per plate

# Vertex colour masks (masks.py): one FLOAT_COLOR attribute on the points.
MASK_ATTR = 'Col'

# ---- nail unit (nails.py) ------------------------------------------------------
# Grid of the rebuilt plate: NI columns (2 side skirt columns), rows = 1 cuticle
# skirt row + NV visible rows + 2 free-edge lip rows.
NAIL_NI = 15
NAIL_NV = 17
# Visible outline, in the old plate's extents (half sizes along / across).
NAIL_WIDTH_SCALE = 0.94          # visible half width / old plate half width
NAIL_CUTICLE_TRIM = 0.06         # fraction of the old length hidden at the cuticle (under the fold)
NAIL_FREE_EDGE_PAST_TIP = 0.09   # free edge overhang past the fingertip, x old nail length
NAIL_CUTICLE_ARC = 0.42          # cuticle arc sagitta, x half width (the U of the proximal fold)
NAIL_CUTICLE_ROWS = 0.36         # fraction of the visible rows the cuticle arc ramps over
NAIL_CUTICLE_ROUND = 0.16        # width pulled in at the cuticle corners
NAIL_FREE_ARC = 0.32             # free edge arc sagitta, x half width
NAIL_FREE_ROWS = 0.34
NAIL_FREE_ROUND = 0.16
# Curvature: C-curve across (radius fitted to the old plate, scaled), slight arch along.
NAIL_RADIUS_SCALE = 1.0
NAIL_LIFT = 0.10                 # plate centre above the skin it sits on, x half width
NAIL_RADIUS_MIN = 0.060          # world units; never flatter than the fit, never a tube
NAIL_RADIUS_FREE_TIGHTEN = 0.12  # the C-curve tightens this much toward the free edge
NAIL_ARCH_RADIUS = 0.45          # along the finger
# Skirt (hidden, zero UV area) and the turned-under free edge.
NAIL_SKIRT_CUTICLE = 0.10        # x visible length
NAIL_SKIRT_SIDE = 0.05           # x visible width (full)
NAIL_SKIRT_DROP = 1.2            # skirt drop in z, x its length
NAIL_SKIRT_OUT = 0.25            # ... and how far out it goes: mostly straight down, so the plate's
                                 # silhouette (and every raycast on it) is the visible plate
NAIL_THICKNESS = 0.045           # free-edge thickness, x half width
NAIL_LIP_BACK = 0.12             # the lip runs back under the plate, x half length

# ---- skin around the nail (folds, bed, hyponychium) ------------------------------
FOLD_BANDS = ((-0.16, 0.08), (-0.11, 0.04))  # cut skin edges whose signed distance to the outline (x half width) meets each band, one pass each
FOLD_WIDTH = 0.42                # fold width (outside the outline), x half width
FOLD_HEIGHT_PROX = 0.065         # proximal fold height above the plate, x half width (~3% of the width)
FOLD_HEIGHT_SIDE = 0.055         # lateral folds
FOLD_COVER = 0.08                # the skin drops through the plate's level over this, x half width
FOLD_SHIFT = 0.10                # ... so it meets the plate this far out minus FOLD_COVER (= just outside
                                 # the rim: the whole UV plate is visible, the steep skirt goes under)
FOLD_EDGE = 0.55                 # fold height right at the outline, x fold height (the plate tucks under)
FOLD_TOP_ONLY = (0.30, 0.75)     # effect fades out below the plate between these depths, x half width
BED_DEPTH = 0.06                 # nail bed below the plate, x half width
HYPO_GAP = 0.10                  # extra gap under the free edge per unit of overhang (x overhang length)
RIGID_REACH = 1.3                # skin within this many nail half lengths of the plate rides on .03 only
