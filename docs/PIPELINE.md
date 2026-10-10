# 3sD-INPAINTegration pipeline: measured inputs, immutable identity, local creation

## Capability boundary

The [current README](../README.md) and [source](../src/index.js) are the
implemented contract, not a promise of working model integrations. The framework
implements validation, ordered adapter calls, immutable publication, rig helpers,
and confidence-atlas accumulation. Reconstruction, XPBD, rendering, inpainting,
identity recognition, optical flow, and local LLM/VLM inference require separately
implemented, reviewed adapters. No model weights ship here. A cold start cannot
produce an actual person or video with the repository alone.

| Phase | Inputs | Outputs | Current status / failure boundary |
| --- | --- | --- | --- |
| Capture | Consented images, nine calibrated cameras, hair masks | Local view records | Input validation exists; capture/calibration tools are external. |
| Acquisition | Reviewed source locks, trusted asset hashes, licenses | Transferable local sources/models | Separate connected-machine workflow; unresolved provenance blocks acquisition. |
| Offline setup | Transferred sources, hash inventory, wheels, target recipe | Verified local installation | Fail-closed operational tools; target selection does not supply missing implementations. |
| Analyze | Plates/masks and camera records | Mattes, contours, parsing, face/body points | `analyzeViews` adapter; structural validation exists. |
| Fit / texture / scalp / groom | Ordered analyses and source priors | Seven canonical identity assets | Adapter-only reconstruction and export. |
| Publish / reuse | Complete bundle or existing identity | Validated absolute paths and manifest | Implemented immutable storage; cache hits skip reconstruction. |
| Animate / render | Bundle, timeline, pose, scene, dynamics | Curves, six control maps | Physics and renderer adapters required. |
| Prompt / inpaint | Control maps, local weights, optional prompt adapter | Generated frame | Optional `compose`; required `inpaint`; no built-in inference. |
| Refine / export | Source identity, calibrated requests, trusted embedding | New identity plus fresh body albedo | Ordered feedback orchestration exists; all feedback inference is adapter-only. |

See [INSTALL](INSTALL.md) for operational commands and conditional success
criteria, [OFFLINE_SECURITY](OFFLINE_SECURITY.md) for enforcement limits, and
[AGENT_IMPLEMENTATION](AGENT_IMPLEMENTATION.md) for implementation gates.

| Status | Capabilities / evidence |
| --- | --- |
| Implemented | Immutable storage, nine-view/analysis validation, rig/confidence helpers, ordered adapters, acquisition/integrity and Linux wrapper checks. |
| Tested | Existing Node and Python fixture tests, CLI refusal/help, hashes/paths/wheels/audit; owners report passing final suites with a real isolated-install smoke skip where namespaces are denied. Counts vary as tests are added. |
| Adapter-only | Actual model inference, smooth reconstruction/baking, renderer, sd-cli/llama.cpp, XPBD/collision and feedback quality guards. |
| Experimental | Proposed SI/row-major/OpenCV conventions, bounded expression mapping and bending-model specification until concrete adapter validation. |
| Blocked | Untrusted/missing weights, unresolved licenses/provenance, missing recipes/adapters, unreviewed non-Linux isolation, and actual isolation on hosts that refuse namespaces. |

Python 3.12 local construction, sidecar process topology and absence of external
IP/TCP/DNS/HTTP(S) traffic require actual implementation/enforcement evidence;
fixture or skipped smoke tests do not demonstrate an end-to-end cold start.

## 1. Capture and analysis

On a `prepare(identity, views)` cache miss, supply all nine unique names:
`front`, `right_three_quarter`, `right_profile`, `right_rear`, `back`,
`left_rear`, `left_profile`, `left_three_quarter`, `crown`. Additional uniquely
named views are permitted. The eight ring views are intended at 45-degree steps;
the crown is elevated. The API checks names, not physical camera placement.

| View name | Proposed subject-relative yaw | Proposed elevation |
| --- | --- | --- |
| `front` | 0° | Horizontal ring |
| `right_three_quarter` | 45° | Horizontal ring |
| `right_profile` | 90° | Horizontal ring |
| `right_rear` | 135° | Horizontal ring |
| `back` | 180° | Horizontal ring |
| `left_rear` | 225° | Horizontal ring |
| `left_profile` | 270° | Horizontal ring |
| `left_three_quarter` | 315° | Horizontal ring |
| `crown` | Measured yaw, not prescribed | Measured positive elevation looking down at scalp |

This table is a capture convention, not enforced calibration or invented
default camera matrices. Record actual yaw/elevation, lens/intrinsics, distortion,
image dimensions and physical scale. Keep neutral expression, pose, hair state,
lighting/exposure/white balance and lens settings consistent across the measured
set; record unavoidable variation. Use an observed calibration/scale reference,
not guessed focal length, body size or automatic exposure defaults.

Each view needs a nonempty regular-file `plate` and `hairMask`, and a `camera`
with finite flat arrays `intrinsics` (9 values) and `worldToCamera` (16).
Use absolute local paths operationally; current source accepts relative file
paths as well. Numeric checks do not prove calibration, invertibility, matrix
layout, handedness, or image-size correspondence.

Historical five-view *completed bundles* can still be imported or reused without
reconstruction because schema-version-1 publication does not decode the spatial
archive. This does **not** mean the current five-view preparation input is
accepted: it fails on a cache miss. No silent generation of four missing
observations, schema replacement, or mutation of old bundles is allowed.

`analyzeViews` returns one analysis per view, in input order. Supply positive
integer `imageSize`, non-null `matte`, `faceParsing`, `bodyParsing`, and at least
one nonzero-area contour with at least 64 `(x,y)` points inside the image.
Contours wholly snapped to the integer/half-pixel grid fail validation. Trace
soft-matte iso-contours using subpixel interpolation; the framework does not
decode a matte or certify its accuracy.

An adapter can combine SAM2 prompts/coarse subject selection with BiRefNet
high-accuracy soft matting; neither a binary SAM mask nor a model name certifies
subpixel edges. Sapiens may add pose/segmentation/depth/normal evidence, but its
CC-BY-NC-4.0 license restricts intended use and requires review. Retain multi-level
semantic labels separately: subject/background, body/clothing part, and facial
skin/brow/eye/nose/lip/ear/hair regions. Define label IDs and mappings explicitly;
BiSeNet class conventions are not universal body/clothing labels. Source only
validates non-null parsing handles, not their semantic correctness.

Person detection precedes whole-person cropping, pose decoding and rig mapping.
Keep head, hands and feet in the crop. Supply one pose mode:
`body18` (18), `body25` (25), `openposeFull` (128), `wholebody` (133, default),
or `wholebody3d` (133). Preserve model indices. Points are finite XYZ/confidence
records or `null`; dropped observations must not be guessed. The exact default
`KEYPOINT_THRESHOLD` in `src/analysis.js` is **0.45**, not 0.25; an explicit
`keypointThreshold` in `[0,1]` overrides it. Each point set must retain a point.
2D body modes require `z=0`; `wholebody3d` requires at least one retained nonzero
depth. Detector NMS and identity similarity thresholds are adapter settings,
not this keypoint threshold.

Visible front/three-quarter faces require exactly 68 sparse points and at most
one add-on: medium at least 100 (often 106), or dense at least 400 (often 468).
Other occluded views can set `faceLandmarks: null`. Draw only the 68-point face
overlay for OpenPose ControlNet, not the dense mesh. `buildRig` creates only
bones with retained endpoints, attaches hands to wrists and face to neck; 2D
length is `null`, not a measured anatomical length. Single-view RTMW3D depth
does not implement calibrated multiview triangulation or DensePose.

## 2. Reconstruction and publication

The exact stage order is `analyzeViews` → `fitGeometry` → `bakeAlbedo` →
`mapScalp` → `reconstructGroom` → `archiveSpatialMaps`. Later stages receive
the same context and validated analyses. A thrown error stops the sequence,
cleans the workspace and publishes nothing.

Fit a connected parametric head/body surface to calibrated subpixel silhouettes,
parsing regions, landmarks and pose observations. Preserve topology/UV indexing;
regularize deformation with shape priors and smoothness. Binary-mask voxel
carving alone is not an acceptable smooth head/body fit. Hair visual hulls may
use occupancy evidence but cannot reveal concavities or internal strands.

Bake illumination-normalized face/body albedo with visibility and confidence
gating, then harmonize seams (for example Poisson blending in the adapter).
`ConfidenceAtlas` actually replaces RGB only for strictly higher float32
confidence; equal confidence retains previous color. It does not perform
projection, visibility, de-lighting, blending or PNG encoding.

Project hair masks into scalp UV space, build root growth/junction masks,
reconstruct an occupancy hull and strand-direction field, and export guides
with stable root bindings. Record assumptions and uncertainty; nine silhouettes
do not prove hidden hair geometry.

| Canonical filename | Producer/export requirements |
| --- | --- |
| `mesh_head.obj` | Head geometry and stable UV coordinates. |
| `mesh_body.gltf` | glTF 2.0 body, skinning and hierarchy; buffers/images embedded, no external URIs. |
| `uv_skin_albedo.png` | Intended 4096×4096 illumination-normalized skin atlas. |
| `uv_scalp_junction.png` | Head-UV root growth zones and junction mask. |
| `hair_physics.abc` | Alembic guides, stable roots and groom attributes. |
| `multi_angle_pose.mask` | ZIP spatial archive: plates, cameras, mattes, contours, parsing, hair masks, rings, landmarks, pose mode/keypoints, fitting evidence/provenance. |
| `skeleton_profile.json` | Relative bone lengths, joint names/limits, units and coordinate conventions. |
| `uv_body_albedo.png` | Optional for historical seven-asset bundles; freshly exported and required by refinement. |

`AssetLibrary.publish` copies required assets, checks nonempty regular files,
JSON syntax, glTF version/resources, writes byte counts/SHA-256 in
`manifest.json`, and atomically publishes the directory. It rejects overwrites.
`load` verifies identity/schema/filenames/size/hash; only absence returns `null`.
Corruption is an error, not a reconstruction fallback. It does not decode OBJ,
PNG, Alembic or ZIP or prove topology, 4K resolution, roots or licenses. Concurrent
preparations are not inference-deduplicated. Publication is not power-loss
durability, and a hash plus replaceable manifest is not publisher authentication.

## 3. Proposed physical convention and XPBD adapter

**Proposed adapter convention, not an enforced schema:** SI meters, kilograms,
seconds; right-handed world with +Y up; gravity in m/s², wind velocity in m/s,
world-to-camera extrinsics and explicit row/column layout, UV origin and pixel
origin documented by each adapter. `time` is nonnegative; refinement yaw is
degrees in `[0,360)`. The source enforces finite camera arrays and those numeric
bounds, not a shared physical coordinate system. Convert assets/cameras together
once, preserve head/body/groom/root alignment, and test unit conversion.

For a proposed explicit projection contract, flatten `K` and world-to-camera
`T` row-major and use column vectors: `p_camera=T*[p_world,1]`, then
`pixel_homogeneous=K*p_camera.xyz`, dividing by its third coordinate.
Store the adapter's distortion model separately. An OpenCV camera convention
has +X right, +Y down and +Z forward. Conversion to a render camera with +Y up
and -Z forward can use `S=diag(1,-1,-1,1)` and `T_render=S*T_opencv`; adjust
projection/pixel-origin conventions consistently rather than only flipping an
image. This describes a proposal, not a mandated renderer convention; test
known 3D points, handedness, matrix transpose and depth sign through every
adapter. The current API does not distinguish layouts.

No XPBD solver is implemented. A future solver should use predicted positions,
inverse masses `w_i`, fixed timestep/substeps `dt > 0`, constraint compliance
`alpha >= 0`, and a multiplier **accumulated across iterations**:

```text
alpha_tilde = alpha / dt²
delta_lambda = (-C(x) - alpha_tilde * lambda)
               / (sum_i w_i * ||gradient_i C||² + alpha_tilde)
x_i += w_i * gradient_i C * delta_lambda
lambda += delta_lambda
```

Initialize multipliers to zero at the start of each timestep/substep being
solved, not every constraint iteration. Keep accumulated multipliers until that
step completes. Explicitly specify any reviewed warm-start policy rather than
accidentally carrying stale impulses between timelines. Guard zero denominators,
degenerate segments, invalid mass/compliance, and NaNs. Reconstruct velocities
from corrected positions and apply a documented damping law, not arbitrary
frame-dependent shrinkage.

Stretch: `C = ||x_b-x_a|| - restLength`, with gradients `-n,+n` where
`n=(x_b-x_a)/||x_b-x_a||`. Reject/handle zero-length segments.
One explicit bending option for consecutive points is a rest-curvature-vector
constraint `C_vec = x_a - 2*x_b + x_c - q_rest`. Solve each component with
gradients `e_k,-2*e_k,e_k` **when `q_rest` is held fixed for that solve**.
This second-difference constraint is not a full rotation-invariant rod/twist
model: rotate `q_rest` using a prescribed material frame before the solve and
validate that approximation. If the frame depends on the solved positions,
include its derivatives rather than reusing these fixed-target gradients.
Alternatively implement an angle/rod model with its own derived gradients and
degeneracy handling. Merely labeling a distance constraint “bending” is
insufficient.

Root attachments follow the posed scalp through fixed barycentric bindings or
an explicit attachment constraint; zero inverse mass fixes a root only after
its target has been updated. Head/body collision can use a signed-distance
constraint `C=phi(x)-radius >= 0`, gradient `gradient(phi)`, and unilateral
projected multipliers: clamp the new multiplier to `>=0` and apply only its
actual change. Solve penetrations without attraction across a gap. Moving
colliders, friction, continuous collision detection and strand/self-collision
need explicit algorithms/tests; paths passed by `physics.simulate` do not
provide any of these. Surface resolution, interpenetration and tunneling remain
quality gates, not current guarantees.

Future complex security/XPBD code should carry verbose explanatory comments:
threat model, invariant, multiplier lifetime, compliance units, collision sign,
projection and degeneracy choices. This documentation-only change does not
alter production source.

## 4. Local frame generation

`renderFrame` loads a stored identity then calls `physics.simulate` with groom,
scalp, skeleton and head/body collider paths, timeline/dynamics/pose. The renderer
receives curves, bundle, scene, pose, camera/yaw/time and must return all six
non-null maps: `baldComposite`, `hairMask`, `depth`, `lineart`, `parsing`,
`keypoints`. Validate their size/range/projection in the adapter; handles are
opaque to the framework.
The renderer is authoritative for posed geometry, cameras, occlusion, root
placement and control-map projection. ControlNet consumes 2D conditioning
images; it does not rig a mesh, solve skeleton transforms, simulate hair or
prove anatomical/camera consistency.

Expression text is a proposed adapter feature, not a core string-to-rig API.
Use an explicit reviewed vocabulary and bounded mapping to supported FACS AUs
or blendshapes, for example “small smile” → a capped bilateral AU12/lip-corner
puller, or “brow raise” → capped AU1/AU2 where the actual rig supports them.
Store the chosen numeric bounds/config and validate the resulting deformation;
there is no universal AU-to-blendshape amplitude. Refuse unsupported/unknown
text rather than inventing a pose or silently passing unlimited values to the
rig. A local prompt model may describe the rendered expression, but must not
override authoritative geometry.

Optional local `prompter.compose` returns a nonempty `prompt` and optional
string `negativePrompt`. Without it, prompt settings belong to diffusion.
Connect llama.cpp/local VLM only with licensed, hash-verified local weights.
`diffusion.inpaint` can adapt stable-diffusion.cpp `sd-cli`, inpainting weights,
compatible depth/lineart/segmentation/OpenPose ControlNets and hair LoRA.
Executable availability is not proof of compatible multi-ControlNet or GPU
support; test the selected build and adapter. No model plugin loader exists in
the Node CLI; the integration application must call the exported API.

## 5. Recursive refinement

`refineSequence(sourceIdentity, newTargetIdentity, requests, adapters)` needs
strictly increasing nonnegative times, calibrated cameras and at least nine
distinct yaws. A 24-view proposal uses `0,15,...,345` degrees, but counts alone
do not certify coverage. The target must be new; the source stays immutable.

Track provenance for every captured/generated observation locally: source kind,
content hash, originating capture or generation request/seed, camera, model
ID/revision/hash, license review reference, threshold values and immutable
configuration digest. Preserve confidence/visibility, transformations and
accept/reject decisions. Hash configuration snapshots rather than referring to
a mutable “current settings” file. Archive this evidence in the spatial bundle
or a reviewed companion local archive, with schema/version and artifact hashes.
These are proposed adapter export requirements, not currently enforced fields
inside the opaque ZIP. Never upload personal observations, embeddings, prompts
or provenance tied to a subject to GitHub. Generated evidence must remain marked
generated and cannot replace measured-source authority.

The required feedback sequence is `initialize` once, then each frame's
`extract` → `checkIdentity` → (if accepted) `smoothHair` → `updateAlbedo` →
`refineGeometry` → `recalibrateSkeleton` → `refineHair`. Await updates before
the next render. `initialize` provides independent mutable state and a finite,
frozen trusted-source identity embedding. Extraction and guards must not mutate
state. Rejected frames never enter updates or accepted-frame optical-flow
history. Configure identity/hair/geometry guard thresholds in the adapter; there
is no built-in similarity threshold or guarantee against diffusion drift.

Feedback extraction includes the full analysis plus non-null `skin`,
`bodyTexture`, `bodyMask`, `hairMask`, `strandDirections`. Physics/renderer must
consume current state, not repeatedly reload unchanged source files. Diffusion
also receives camera/yaw, identity embedding and renderer depth as
`controlDepth`; it must actually enforce their intended use.

Require nine distinct **accepted** yaws before `finalize`; otherwise publish
nothing. Finalization exports all assets and a fresh `uv_body_albedo.png`.
The loop deletes the copied body texture before finalization, so initialize must
decode it if needed. `onFrame` streams results; GPU synchronization, buffer
lifetime and cleanup belong to adapters. There is no CUDA bridge, automatic
VRAM sharing, persistent per-frame checkpoint or latency/accuracy guarantee.

## Tests and acceptance

Run the existing framework checks without models:

```sh
npm run check
node --test test/framework.test.js test/refinement.test.js test/rig.test.js
```

These test orchestration, validation, integrity, immutable reuse, rig mapping
and refinement behavior using fixtures, not real model quality or air-gap
security. Future adapter acceptance must include calibrated reprojection and
contour error, seam/visibility confidence, root attachment under animation,
stretch/bend convergence across timestep/iteration changes, collider penetration,
timeline reset and isolation of identities, rejected-frame nonmutation, fresh
exports, and disconnected-machine creation. Store diagnostics and personal
evidence locally. Never invent measured percentages or mark fixture tests as a
successful model cold start.

## Licensing and evidence

Repository code is Apache-2.0 ([LICENSE](../LICENSE)); model, training-data,
parametric-body/head, conversion and runtime licenses are separate. BFM/SMPL-X,
face-recognition checkpoints, community ONNX conversions, GGUFs, ControlNets
and LoRAs need independent provenance, redistribution and intended-use review.
See the [model inventory](../models/README.md). Unknown hashes, unresolved
source-lock revisions and unreviewed licenses block the applicable phase.
No unavailable prior conversation is a trusted hash or license authority.
