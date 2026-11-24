"""Every number of the hand v2 pipeline (hand-v2-plan.md). The v1 pipeline's
own table lives in v1/params.py."""

# ---- source (base.py) ----------------------------------------------------------
CAGE = 'src/mh/hand-cage.json'
# Shape targets, applied as plain vertex deltas on the cage (plan 3.1).
TARGETS = {
    'caucasian-female-young': 1.0,      # young, slim forms (a shape target only: tone stays a uniform)
    'r-hand-fingers-diameter-decr': 0.25,  # slender fingers, softer knuckles
    'r-hand-fingers-length-incr': 0.15,    # elegant, a little more nail bed
}
MH_MM = 100.0                    # MakeHuman base mesh units are decimetres

# source weight groups -> the game's 17 bones (plan 5)
WEIGHT_MAP = {'wrist.R': 'wrist', 'lowerarm01.R': 'wrist', 'lowerarm02.R': 'wrist',
              'metacarpal1.R': 'palm', 'metacarpal2.R': 'palm', 'metacarpal3.R': 'palm', 'metacarpal4.R': 'palm'}
for _f, _n in enumerate(['thumb', 'index', 'middle', 'ring', 'pinky']):
    for _k in (1, 2, 3):
        WEIGHT_MAP[f'finger{_f + 1}-{_k}.R'] = f'{_n}.0{_k}'

# ---- anthropometry (fit.py, plan 3.1): adult female, 50th percentile, +-12% -------
ANTHRO = {'hand_length': 172.0, 'knuckle_breadth': 76.0, 'middle_finger': 75.0, 'index_dip_breadth': 15.0}
ANTHRO_BAND = 0.12

# ---- rest pose (fit.py, plan 3.2) -------------------------------------------------
# Finger joint flex at rest, degrees: [knuckle, middle joint, last joint]. The
# knuckle is solved per finger so the pad meets the desk (REST_KNUCKLE is the
# start and the clamp); the two outer joints are set.
REST_FLEX = (0.0, 6.0, 4.0)
REST_KNUCKLE_RANGE = (-6.0, 14.0)
DESK_PAD_TOL_MM = 1.5            # finger pads' lowest point vs the desk plane
WEB_RELAX_ITERS = 10             # Taubin passes on the webs and the thenar after the re-pose
WEB_RELAX_LAMBDA = 0.5
WEB_RELAX_MU = -0.53
THUMB_FIT_MM = 3.0               # (plan) thumb nail centre vs v1's: not reachable with a natural thumb on the desk
THUMB_ALONG_W = 0.5              # thumb fit weights: along the index (a longer thumb may reach further)
THUMB_OUT_W = 1.5                # ... and sideways out of the hand (what sticks out)
THUMB_OUT_MM = 8.0               # the thumb nail no further out of the hand (sideways) than v1's
THUMB_FIT_DEG = 8.0              # thumb nail normal vs v1's
THUMB_REST_FLEX = (12.0, 10.0)   # the thumb's two outer joints at rest (a relaxed thumb is never straight)
THUMB_DESK_GAP_MM = 3.0          # the resting thumb's lowest point: on the desk, at most this far above it
THUMB_BASE_RANGE = 45.0          # degrees each way the base joint may turn freely from the source's rest
THUMB_PRIOR_W = (0.03, 0.03, 0.03, 0.35, 0.35)  # mm-equivalent per degree away from that (base joint: free)

# ---- placement (fit.py, plan 3.3): v1's landmarks, Blender world (Z up) -------------
# Read once from public/models/hand.glb at 2a6c7cc (bone heads, nail frame origins
# and +Z); the build does not depend on the old file.
V1_BONE_HEAD = {
    'palm': (-0.3757, 0.2120, 1.9932),
    'index.01': (-0.8655, -0.0083, 2.0471), 'middle.01': (-0.8368, 0.1371, 2.0566),
    'ring.01': (-0.8402, 0.2645, 2.0463), 'pinky.01': (-0.8042, 0.4003, 2.0211),
}
V1_NAIL_CENTRE = {
    'thumb': (-0.7791, -0.2760, 1.8148), 'index': (-1.2681, -0.1678, 2.0556), 'middle': (-1.4072, 0.0891, 2.0575),
    'ring': (-1.2869, 0.3792, 2.0244), 'pinky': (-1.1608, 0.5371, 2.0145),
}
V1_NAIL_NORMAL = {  # nail +Z (out of the plate)
    'thumb': (-0.290, -0.453, 0.843), 'index': (-0.282, -0.090, 0.955), 'middle': (-0.109, 0.058, 0.992),
    'ring': (-0.122, 0.166, 0.979), 'pinky': (-0.148, 0.209, 0.967),
}
V1_FINGER_TIP = {  # .03 bone tails (the finger's heading on the desk)
    'index': (-1.2757, -0.1790, 2.0176), 'middle': (-1.4863, 0.0784, 2.0179),
    'ring': (-1.3323, 0.3866, 1.9788), 'pinky': (-1.1880, 0.5487, 1.9892),
}
V1_ARM_END_X = 1.1543            # the forearm's open end (world x) in v1
V1_WRIST_HEAD = (0.8960, 0.4829, 1.2290)   # v1's wrist bone head (in the forearm): its forearm direction
PLACE_RESID_FRAC = 0.06          # placement residual per landmark, x hand length (report; plan expects under)
HEADING_ITERS = 2                # spread the fingers to v1's headings, re-place, repeat
NOTCH_CAVITY = 0.3               # no forearm vertex with a cavity mask above this

# ---- rig (rig.py, plan 5) -----------------------------------------------------------
WEIGHT_SMOOTH_PASSES = 2         # Laplacian passes on the finger webs and the thenar web
RIGID_RINGS = 2                  # rings of cage faces around the nail bed that ride on .03 only
VOLUME_MIN = 0.85                # joint cross-section at any limit pose, x rest
WEB_DIHEDRAL_MAX = 25.0          # max dihedral change across the thenar web at the game's thumb poses (the crease)

# ---- density (dense.py, plan 3.4) ---------------------------------------------------
DENSE_TIP_W = 0.5                # faces with this much .03 weight (grown one ring) get level 2
LIMIT_LEVELS = 3                 # the limit surface proxy every vertex is snapped to
CAP_SKIN_VERTS = 14000           # after UV seam splits
CAP_SKIN_TRIS = 27500
FACET_MAX_DEG = 4.0              # index last joint, DIP-to-tip: adjacent face normals

# ---- nail unit v2 (nails.py, plan 4); lengths in mm --------------------------------------
NAIL_WIDTH_FRAC = 0.80           # visible plate width / finger width at mid-nail
NAIL_FREE_LEN = 0.25             # free edge length / nail bed length (Jesse is choosing this)
NAIL_FREE_RANGE = (0.05, 0.90)   # the viewer's slider (the morph's two ends)
NAIL_TIP_ROUND = 0.70            # 0 square .. 1 full oval: the free edge outline
NAIL_SIDE_TAPER = 0.05           # the sides converge this much toward the tip
NAIL_CUTICLE_ARC = 0.45          # cuticle sagitta, x half width (a clear U)
NAIL_C_CURVE = 1.0               # transverse radius, x the radius fitted to the bed
NAIL_C_TIGHTEN = 0.10            # ... tighter by this past the hyponychium
NAIL_DROOP = 0.012               # the free edge curves down: mm per mm^2 of overhang
NAIL_THICKNESS = 0.5             # plate thickness at the free edge
NAIL_LIFT = 0.15                 # V1 placeholder: plate above the (unsculpted) bed
FOLD_TUCK_PROX = 1.2             # the plate runs under the proximal fold (hidden)
FOLD_TUCK_SIDE = 0.4             # ... and under the side folds
NAIL_COLS = 13                   # visible columns (+2 side tuck columns)
NAIL_BED_ROWS = 19               # visible rows over the bed
NAIL_FREE_ROWS = 6               # visible rows past the hyponychium
CAP_NAIL_VERTS = 520

# ---- skin colour masks (masks.py): R blush, G palm side, B cavity, A thinness -------------
MASK_ATTR = 'Col'
MASK_SMOOTH_PASSES = 3
CAVITY_CURV = (0.03, 0.15)       # concave mean curvature (1/mm) -> cavity 0..1
