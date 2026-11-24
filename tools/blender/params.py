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
BAKE_SOFT_RINGS = 4              # the re-pose bake uses weights diffused over the webs, thenar, wrist + this many rings
BAKE_SOFT_PASSES = 30
WEB_RELAX_ITERS = 10             # Taubin passes on the webs and the thenar after the re-pose
WEB_RELAX_LAMBDA = 0.5
WEB_RELAX_MU = -0.53
THUMB_MC_FRAC = 0.44             # thumb chain anatomy (thumb.py): first metacarpal = this x wrist-to-index-MCP ...
THUMB_PP_SCALE = 0.80            # ... the proximal phalanx shortened by this ...
THUMB_DP_SCALE = 0.88            # ... and the distal ...
THUMB_MC_THICK = 1.10            # ... the metacarpal segment thicker round its axis ...
THUMB_DIGIT_THICK = 1.10         # ... the two phalanges a little stockier
THENAR_FILL_MM = 2.5             # after the bake: the thenar eminence filled this much on the palm side ...
THUMB_MC_ROUND_MM = 1.0          # ... and the first metacarpal rounded this much on the back ...
THENAR_FILL_SMOOTH = 6           # ... smoothed over this many passes
THUMB_FIT_MM = 3.0               # (plan) thumb nail centre vs v1's: not reachable with a natural thumb on the desk
THUMB_ALONG_W = 0.5              # thumb fit weights: along the index (a longer thumb may reach further)
THUMB_OUT_W = 1.5                # ... and sideways out of the hand (what sticks out)
THUMB_OUT_MM = 8.0               # the thumb nail no further out of the hand (sideways) than v1's
THUMB_FIT_DEG = 8.0              # (info) thumb nail normal vs v1's
THUMB_REST_FLEX = (12.0, 10.0)   # stage 1 (placing the base like v1's): the outer joints' prior
THUMB_DESK_GAP_MM = 3.0          # stage 1: the thumb's lowest point on the desk, at most this far above it
THUMB_STRAIGHT_FLEX = (4.0, 4.0) # stage 2 (Jesse, after V2): the outer joints of a relaxed, fairly straight thumb
THUMB_STRAIGHT_PRIOR_W = 0.1     # ... (mm-equivalent per degree away from that)
THUMB_SIDE_CURL_MAX = 5.0        # stage 2: seen from the side, each outer joint bends down at most this (degrees)
THUMB_CURL_W = 6.0               # ... (mm-equivalent per degree over)
THUMB_DESK_CLEAR_MM = 1.0        # stage 2: the thumb's lowest point at least this far above the desk ...
THENAR_DESK_CLEAR_MM = 3.5       # ... and the thenar's (the bake still presses it a little lower)
THUMB_META_PITCH = -6.0          # stage 2: the metacarpal slopes this much down toward the tip (degrees) ...
THUMB_META_W = 0.6               # ... (mm-equivalent per degree)
THUMB_BELOW_INDEX_MM = 2.0       # stage 2: the thumb tip no higher than this below the index's last-joint axis ...
THUMB_LEVEL_W = 3.0              # ... (per mm above that)
THUMB_NAIL_TILT = 50.0           # stage 2: the thumb nail faces this far from straight up, more sideways than up (anatomy) ...
THUMB_NAIL_TILT_W = 0.5          # ... (mm-equivalent per degree)
THUMB_MC_ANGLE = 35.0            # stage 2: the first metacarpal's angle from the index metacarpal, seen from above ...
THUMB_MC_ANGLE_W = 1.5           # ... (per degree)
THUMB_TOP_BEND = (6.0, 20.0)     # stage 2: seen from above, the phalanges turn this much from the metacarpal toward the index
THUMB_REACH = 0.5                # stage 2: the thumb tip reaches about the middle of the index's proximal phalanx ...
THUMB_REACH_W = 4.0              # ... (per proximal-phalanx length)
THUMB_STAGE2_BASE_W = 0.05       # stage 2: the base joint stays near its stage-1 place (per degree)
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
WEIGHT_SMOOTH_PASSES = 4         # Laplacian passes on the finger webs and the thenar web
FINGER_JOINT_PASSES = 2          # Laplacian passes on the finger joint blends (more flips more DIP slivers)
THENAR_RINGS = 3                 # the thenar web's weight smoothing reaches this many rings out
THENAR_SMOOTH_PASSES = 20
RIGID_BORDER_PASSES = 0          # Laplacian passes on the two rings round the rigid nail unit
RIGID_SNAP_W = (0.6, 0.9)       # after subdivision, .03 weights over this range ease to 1 (the nail unit stays rigid)
RIGID_RINGS = 2                  # rings of cage faces around the nail bed that ride on .03 only
VOLUME_MIN = 0.85                # joint cross-section at any limit pose, x rest
WEB_DIHEDRAL_MAX = 25.0          # max dihedral change across the thenar web at the game's thumb poses (the crease)

# ---- density (dense.py, plan 3.4) ---------------------------------------------------
DENSE_TIP_W = 0.5                # faces with this much .03 weight (grown one ring) get level 2 ...
DENSE_TIP_HALF = 0.5             # ... on the back, and on the pad past this fraction of the last bone
DENSE_PAD_KEEP = 0.35            # 'back' reaches this far round the sides (x the local radius)
LIMIT_LEVELS = 3                 # the limit surface proxy every vertex is snapped to
CAP_SKIN_VERTS = 14000           # after UV seam splits
CAP_SKIN_TRIS = 27500
FACET_MAX_DEG = 4.0              # index last joint, DIP-to-tip: adjacent face normals

# ---- nail unit v2 (nails.py, plan 4); lengths in mm --------------------------------------
NAIL_WIDTH_FRAC = 0.80           # visible plate width / finger width at mid-nail
NAIL_FREE_LEN = 0.25             # free edge length / nail bed length (Jesse is choosing this)
NAIL_FREE_RANGE = (0.05, 0.90)   # the viewer's slider
NAIL_FREE_STOPS = (0.05, 0.15, 0.25, 0.40, 0.60, 0.90)  # its morph targets (exact geometry at each)
NAIL_CORNER = 0.8                # the free edge's oval starts at most this far before the hyponychium (mm)
NAIL_TIP_ROUND = 0.70            # 0 square .. 1 full oval: the free edge outline
NAIL_SIDE_TAPER = 0.05           # the sides converge this much toward the tip
NAIL_CUTICLE_ARC = 0.45          # cuticle sagitta, x half width (a clear U)
NAIL_CUTICLE_ROUND = 0.12        # the cuticle's corners pull in this much (x half width) ...
NAIL_CUTICLE_ROWS = 0.18         # ... over this much of the bed
NAIL_C_CURVE = 1.0               # transverse radius, x the radius fitted to the bed
NAIL_C_TIGHTEN = 0.15            # ... tighter by this toward the free edge ...
NAIL_C_TIGHTEN_LEN = 3.0         # ... starting this far (mm) before the hyponychium
FREE_SIDE_DROP = 0.25             # ... starting this far under the plate side edge (mm) ...
FREE_SIDE_RAMP = 0.45            # beside the free edge's curled sides the fingertip skin stays under a ramp this steep
NAIL_ARC_DEG = {'thumb': 110.0, 'index': 100.0, 'middle': 100.0, 'ring': 96.0, 'pinky': 90.0}  # C-curve across the visible plate (Jesse, after V2)
NAIL_FREE_SLOPE = 0.45          # past the hyponychium the plate keeps this much of the bed's downward slope
                                 # (all of it made a long nail a claw)
NAIL_DROOP = 0.004               # ... and curves down a little: mm per mm^2 of overhang
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
# the groove sculpt (plan 4.3): widen on the cage, then shape the skin round the plate
WIDEN_ITERS = 4                  # measure on the limit surface, rescale the groove's angular span, repeat
WIDEN_FADE = (0.22, 0.04)        # the widening fades in from these fractions of the last bone before the bed
FOLD_H_PROX = 0.45               # the proximal fold stands this far above the plate surface (mm)
FOLD_H_SIDE = 0.35               # ... the side folds
FOLD_WIDTH = 1.6                 # a fold's width outside the outline (mm)
FOLD_COVER = 0.25                # inside the outline the skin drops through the plate's level over this (mm):
                                 # the fold overlaps the rim, never lets it or the tuck show
FOLD_MEET = 0.03                 # the skin meets the plate's level this far outside the outline (mm)
FOLD_SMOOTH_FROM = 0.32          # the folds' displacement is smoothed from this far outside the outline (mm) ...
FOLD_SMOOTH_PASSES = 14          # ... with this many passes
FOLD_PULL_DOWN = 1.0              # outside the outline a fold pulls the skin down this much of the way (0: lifts only)
FOLD_EDGE = 0.55                 # fold height right at the outline, x the fold height
FOLD_SIDE_END = (1.5, 2.5)       # the side folds fade out round the hyponychium, over [y_h - a, y_h + b] (mm)
UNDER_TOL = 0.05                 # the check: skin within this of the plate top at its rim counts as meeting it (mm)
SKIN_UNDER = 0.03               # inside the visible outline the skin stays at least this far under the plate top (mm)
BED_GAP = 0.1                    # the bed sits this far under the plate's underside (mm)
HYPO_GAP = 0.3                   # the fingertip rounds away under the free edge: mm per mm of overhang
HYPO_TILT = 32.0                 # the hyponychium line: where the dorsal surface turns this far from the bed (deg)
FOLD_BAND = None                 # (lo, hi): skin edges whose signed distance to the outline (mm) meets it get one cut;
                                 # off: level 2 is dense enough there, and it cost 2,700 verts
BED_FLOOR = 0.68                 # ... and never shorter than this x the finger width
BED_MIN = 0.7                    # a bed patch shorter than this x the finger width runs out to the hyponychium line
NAIL_ARCH_MIN = 18.0             # the plate's arch along the finger: radius never under this (mm)
#         # skin edges whose signed distance to the outline (mm) meets this band are cut once
