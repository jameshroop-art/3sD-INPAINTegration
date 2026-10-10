# 3sD-INPAINTegration

A dependency-free Node.js framework for **persistent digital-double assets**.
It manages identity bundles and coordinates pluggable reconstruction, physics,
rendering, and inpainting backends. It does not yet implement those backends or
ship model weights.

## Nine-view capture and offline deployment

The operational specification follows **nine-view capture → connected-machine
acquisition → physically transferred, hash-verified offline wheels → local
creation**. The online GitHub PR is a development record only; personal images,
embeddings, prompts, generated outputs, model weights, and device metadata must
never enter it.

- [Pipeline and capability status](docs/PIPELINE.md)
- [Acquisition, offline installation, and cold-start procedure](docs/INSTALL.md)
- [Offline security guarantees and limitations](docs/OFFLINE_SECURITY.md)
- [Ordered implementation and review instructions](docs/AGENT_IMPLEMENTATION.md)
- [Model inventory and licensing gates](models/README.md)

The current capture API already requires the nine named views below. Historical
five-view bundles remain reusable through the immutable-bundle import/cache
contract; this does **not** mean five-view reconstruction is accepted on a cache
miss. No existing bundle schema is replaced. Any future legacy five-view capture
adapter must be explicit and separately tested, not silently synthesize four
missing observations.

The offline tools fail closed when trusted hashes, platform isolation, build
recipes, or local adapters are missing. They do not implement the model backends
or establish an end-to-end creation result. Deployment and creation belong on a
separate disconnected machine; see the status tables before attempting setup.
Wheel construction uses a **Python 3.12 venv** with separately acquired, reviewed
and patched local resources. Build, install and creation must not use external
DNS, TCP, HTTP(S), IPv4/IPv6 connectivity or out-of-framework sidecars; isolation
and descendant-process limits require actual host validation, not just offline
environment variables. Missing assets fail rather than trigger a runtime download.
Each wheel also needs a reviewed, hash-bound local-machine environment rule for
its Linux or Microsoft Windows target. “Localhost only” is not permission for a
loopback TCP service under the no-TCP/no-IP policy. Windows rules are declarative
until a tested Windows isolation backend exists.

## Getting started

Requires Node.js 22 or newer. No runtime dependencies or installation are needed.

```sh
npm run check
npm test

# Import a completed, self-contained bundle from a reconstruction tool:
node src/cli.js import /absolute/path/assets/identities subject_01 /absolute/path/export
node src/cli.js inspect /absolute/path/assets/identities subject_01
node src/cli.js list /absolute/path/assets/identities
```

The CLI returns JSON and exits nonzero on invalid input, incomplete imports, or
corrupt identities. Library paths are resolved to absolute paths.

## Permanent identity layout

Each identity has these canonical assets plus a versioned `manifest.json`:

| File | Backend responsibility |
| --- | --- |
| `mesh_head.obj` | Fit the morphable head; export geometry with UV coordinates and a consistent coordinate system. |
| `mesh_body.gltf` | Export SMPL-X body geometry, skinning, and joint hierarchy as glTF 2.0. All buffers and image resources must be embedded as data URIs, so the file remains portable. |
| `uv_skin_albedo.png` | Produce a 4096×4096 UV albedo map using multi-view projection, color harmonization, and illumination removal. |
| `uv_scalp_junction.png` | Bake binary hair-root growth zones and scalp/feature junctions in the head's UV space. |
| `hair_physics.abc` | Export guide curves, stable root bindings, and groom attributes in Alembic. |
| `multi_angle_pose.mask` | Produce a ZIP archive (custom `.mask` extension) containing all (at least nine) raw plates, background-removal mattes, subpixel edge contours, BiSeNet face/body parsing maps, hair masks, organ rings, camera calibration, the indexed 68-point face landmarks (plus the 106 or 468 face-crop add-on, when used), and the body keypoints of the chosen pose mode. |
| `skeleton_profile.json` | Export relative bone lengths, named joints, constraints, units, and coordinate conventions for retargeting. |

Refined bundles also include `uv_body_albedo.png`, a full-body UV texture for
clothing, footwear, and exposed skin. It is optional for legacy seven-asset
bundles and required by the feedback loop. When present it is copied, hashed,
and verified just like the canonical files. The body exporter must embed its
texture in glTF as well if it is used by the glTF material; external glTF
references remain unsupported.

`AssetLibrary.publish(identity, sourceDirectory)` copies all seven files into a
private staging directory, hashes them, writes a schema-version-1 manifest, and
atomically renames the complete directory into place. Existing bundles cannot be
overwritten through the API. Concurrent publishers have one winner; the other
fails without replacing the winner. Failed imports clean up their staging area.

`load(identity)` returns absolute asset paths after checking manifest identity,
version, filenames, sizes, and SHA-256 hashes. Only an absent identity directory
returns `null`; a damaged bundle is an error, not an invitation to silently
regenerate an identity. Symlink identity directories and symlink asset files are
rejected. `list()` lists candidate identity directories; use `load()`/`inspect`
to validate them.

The library validates completeness, file integrity, JSON syntax, glTF version,
and absence of external glTF resources. It does **not** decode meshes, PNGs,
Alembic, or ZIPs, nor verify topology, texture resolution, landmarks, or physical
root bindings. The producing backend must validate those semantics. Keep the
library root on trusted local storage: hashes detect accidental corruption, not
malicious replacement of both assets and manifest. Atomic publication provides
process-level visibility, not a power-loss durability guarantee. Interrupted
processes may leave hidden `.staging-*` directories; remove those only when no
publisher is active.

## Reconstruction backend contract

Import `AssetLibrary`, `DigitalDoublePipeline`, `ASSETS`, and `VIEW_ANGLES` from
`src/index.js`. Construct the pipeline with a library and a backend, then call
`prepare(identity, views)`. Its result is `{ bundle, reused }`.

On a cache hit, the backend and source views are not required or consulted.
On a miss, at least **nine** perspectives (`MIN_PERSPECTIVES`) are required.
Fewer views leave the silhouette/contour constraints underdetermined and the
fitted shape collapses into blocky or distorted geometry. `VIEW_ANGLES` lists
the nine required angle names, each of which must appear exactly once (any
order): an eight-way ring at 45° steps plus an elevated crown view.

1. `front`
2. `right_three_quarter`
3. `right_profile`
4. `right_rear`
5. `back`
6. `left_rear`
7. `left_profile`
8. `left_three_quarter`
9. `crown` (elevated, looking down at the scalp)

Additional views are allowed if each has a unique `angle` name. Each view
contains `angle`, absolute nonempty regular-file paths `plate` and `hairMask`,
and `camera` with flattened, finite `intrinsics` (9 elements) and
`worldToCamera` (16 elements). Backends must agree on matrix layout, handedness,
units, calibrated projection, and image dimensions. Numeric validation alone
does not establish physically valid calibration.

The pipeline calls these async backend methods sequentially, each receiving
the same `{ identity, views, directory, assets }` context. After
`analyzeViews`, the context also contains the validated, frozen `analyses`
array (one entry per view, in view order) so every later stage fits against
the same mattes, contours, parsing maps, and landmarks:

| Method | Required work/output |
| --- | --- |
| `analyzeViews` | Return one [view analysis](#view-analysis-contract) per view: high-accuracy background removal, subpixel edge contours, BiSeNet parsing, 68-point face landmarks (plus one 106 or 468 face-crop add-on), and body keypoints in one pose mode (default 133 whole-body). Follows the [rig order](#rig-order). Validated before any fitting. |
| `fitGeometry` | Fit/export head, body, and skeleton profile **to the analysis edge contours** (see [Contoured mesh fitting](#contoured-mesh-fitting)). Rig the skeleton from the body-part parsing and pose keypoints (see [Higher-point mapping](#higher-point-mapping)); place facial features from the landmark tiers. |
| `bakeAlbedo` | Export illumination-normalized UV skin albedo; connect bald/scalp inpainting and Poisson harmonization here. |
| `mapScalp` | Project hair masks onto the bald scalp; export the UV junction mask and retain hull/direction-field intermediates. |
| `reconstructGroom` | Reconstruct the multi-view hair hull and guide splines rooted in the scalp; export the physics-ready groom. |
| `archiveSpatialMaps` | Archive plates, calibration, masks, rings, landmarks, and reusable fitting/inpainting intermediates in the spatial ZIP. |

### View analysis contract

`validateAnalysis` (exported) enforces the shape of each analysis object. The
same contract applies to refinement `extract` observations.

| Field | Requirement |
| --- | --- |
| `imageSize` | `{ width, height }` positive integers of the analyzed image. |
| `matte` | Soft (non-binary) alpha matte from a high-accuracy background-removal / matting model. Hair strands and fabric edges need fractional alpha; a thresholded segmentation mask loses the edge persistence the mesh depends on. |
| `contours` | Nonempty array of closed subject outlines traced from the matte edge, each a flat `[x0, y0, x1, y1, …]` array (or typed array) of at least `MIN_CONTOUR_POINTS` (64) points inside the image with nonzero enclosed area. Outlines whose every coordinate lies on the pixel or half-pixel grid are rejected as blocky staircases; trace the iso-contour of the soft alpha with subpixel interpolation instead. |
| `faceParsing` | BiSeNet face-parsing label map (for example the 19 CelebAMask-HQ classes: skin, brows, eyes, ears, nose, lips, hair, neck, …). Used for face texture placement and ControlNet conditioning. |
| `bodyParsing` | Body-part parsing map (head, torso, upper/lower arms, hands, legs, feet, clothing) for rigging, skinning weights, and texture region assignment. |
| `faceLandmarks` | `{ sparse, medium?, dense? }` (`FACE_LANDMARK_TIERS`): `sparse` is exactly 68 points (iBUG-68) and is always required. Add **at most one** face-crop add-on per pass: `medium` (at least 100, for example 106-point landmarks) or `dense` (at least 400, for example a 468/478-point mesh). Supplying both is rejected. Required for the `front` and both three-quarter views; `null` only when the face is not visible, such as rear, profile-occluded, or crown views. |
| `poseMode` | Optional, one per pass (`POSE_MODES`, see [Pose modes](#pose-modes)): `body18`, `body25`, `openposeFull`, `wholebody` or `wholebody3d`. Defaults to `wholebody` (133), what the whole-body packs emit. |
| `bodyJoints` | Exactly as many indexed points as `poseMode` defines. |
| `keypointThreshold` | Optional, in `[0, 1]`; defaults to `KEYPOINT_THRESHOLD` (0.45). |

Point arrays keep the producing model's index order. Each entry is either a
point with finite `x`, `y`, `z` and `confidence` in `[threshold, 1]`, or `null`
when the model scored it below the keypoint threshold. Dropped points are
`null`, never guessed or interpolated; points below the threshold are rejected
rather than silently kept. Each set must keep at least one point. In 2D body
modes every joint `z` must be 0; `wholebody3d` (rtmw3d) must carry depth (at
least one nonzero `z`). Face mesh points may carry `z` in any mode. The framework
validates structure only; matting accuracy, parsing quality, and landmark
accuracy are the backend's responsibility and should be checked against ground
truth.

### Pose modes

| `poseMode` | Points | Source | Intricate use |
| --- | --- | --- | --- |
| `body18` | 18 | `dw-ll_ucoco_384.onnx` body subset | Spine and limbs. Coarse pose only. |
| `body25` | 25 | Same pack, body plus feet | Adds toes and heel so the stance locks. |
| `openposeFull` | 128: 18 body, 68 face, 21 left hand, 21 right hand | DWPose regroup (`toOpenPoseFull`) | The ControlNet `openpose_full` map. |
| `wholebody` | 133: 17 body, 6 feet, 68 face, 42 hands | `dw-ll_ucoco_384.onnx`, RTMW-x, RTMPose-l, RTMPose-t | Highest 2D mode these packs emit. Default. |
| `wholebody3d` | 133 in xyz | `rtmw3d-x_8xb64_cocktail14-384x288-b0a0eab7_20240626.onnx` | Same joints with depth. Single-view 3D. |

Face sets ride alongside any mode in `faceLandmarks`: 68 (DWPose face or the
dlib 68 `.dat`) always, plus at most one add-on: 106 (`2d106det.onnx`, extra
lid, brow and lip points mapped onto the face overlay) or 468 (BFM
`index_mp468_from_mesh35709.npy` seated on the 68; surface points used to warp
the face, never drawn as a stick). Hands are 21 + 21 points with four joints per
finger and are required for finger rigs.

There is no multi-view OpenPose 3D weight and no BODY_25-only weight in this
inventory; do not invent either. `wholebody3d` is single-view rtmw3d depth, not a
multi-camera triangulator. Multi-view consistency comes from the calibrated
views and mesh fitting, not from the pose model.

`buildRig(joints, mode)` (exported from `src/rig.js`) turns validated joints
into bones: shoulder–elbow–wrist, hip–knee–ankle, toe and heel bones off each
ankle (`body25`, `wholebody*`), and each finger as a four-bone chain off its hand
wrist. A bone is emitted only when both endpoints were kept; dropped (`null`)
joints are never guessed. In `wholebody3d` each bone carries its xyz `length`;
in 2D modes `length` is `null` because a screen stick has no bone length. The
result also lists attachments: the 68 face points parent to the neck (the
shoulder midpoint for COCO layouts) and each hand set to its body wrist.
`toOpenPoseFull(joints)` regroups 133 whole-body joints into the 128-point
`openposeFull` layout (deriving the neck from the shoulders and dropping feet)
while keeping any depth, so the renderer can project it through the camera before
drawing.

### Higher-point mapping

| Feature | Low mode | Higher mode | How it maps |
| --- | --- | --- | --- |
| Torso and limbs | 18 body | 25 with feet, or 133 | Extra foot points parent to the ankle. |
| Fingers | Wrist only | 21 per hand | Each finger is a 4-bone chain off the wrist. |
| Eyes and lids | 2 eye corners | 106, then 468 | 106 adds lid points; 468 fills the lid surface. The stick drawing still uses the 68. |
| Lips | 20 mouth points of the 68 | 106 lip ring, then 468 | 468 is the mesh used to seat the mouth. ControlNet still gets the 68 mouth points. |
| Brows | 10 brow points of the 68 | 106 brow arc | Mapped onto the face overlay, parented to the head. |
| Hair | None in OpenPose | BiSeNet class 17 mask (`faceParsing`) | Not points. Parented to the head box. The strand map still needs a Lineart or SoftEdge ControlNet weight. |
| Body surface | Joints only | Not available | No DensePose weight, so no UV surface from the rig. Rig 3D is joint depth, not a skinned mesh; the surface comes from [contoured mesh fitting](#contoured-mesh-fitting). |

Pick one mode per pass. OpenPose full is the default intricate 2D drawing:
compute `wholebody` joints and regroup them with `toOpenPoseFull`. Add 106 or 468
only on the face crop. Use `wholebody3d` only when the rig must carry depth.
Never feed 468 points into the OpenPose stick drawing: the ControlNet face
overlay is 68 points.

### Rig order

1. **Person detect.** `yolox_l.onnx` returns person boxes, followed by
   non-maximum suppression (threshold about 0.45).
2. **Identify.** Each box is one person. Do not use a face-only crop: the crop
   must include head, hands, and feet, or those joints never exist.
3. **Pose.** The chosen whole-body ONNX model runs on the crop at 384×288
   (256×192 for the tiny pack). SimCC decodes to 133 `(x, y, score)` points.
4. **Rig.** Points become bones: shoulder–elbow–wrist, hip–knee–ankle,
   wrist–finger chains, and the 68 face points parented to the neck. A point
   under the keypoint threshold (about 0.45) is dropped (`null`), not guessed.
5. **Map.** Draw the rig as an OpenPose image (body sticks, hand sticks, 68-point
   face contour). That image is the renderer's `keypoints` ControlNet condition.
   Body, hands, and face can each be drawn or omitted; omitting a part only
   changes the drawing, because the keypoints were already computed.

When the rig must carry depth (`wholebody3d`):

1. Person box from `yolox_l.onnx`.
2. 2D whole-body from `dw-ll_ucoco_384.onnx`, so the joint order is known.
3. `rtmw3d` on the same crop: xyz per joint in the same whole-body layout.
4. `buildRig` in 3D: shoulder–elbow–wrist and hip–knee–ankle become bones with
   length, not just screen sticks.
5. Project xyz back to an OpenPose image for ControlNet, or keep xyz for a depth
   or normal pass.
6. Face 106 or 468 stays on the head joint, hands stay on the wrist joints, and
   hair stays a BiSeNet mask parented to the head, not a 3D bone.

### Contoured mesh fitting

Blocky, unnatural shapes come from carving voxels with binary masks or from
fitting to pixel-staircase outlines. `fitGeometry` must instead:

- Use the analysis `contours` (the image edges of the background-removed
  subject) as the silhouette constraint in every calibrated view, minimizing the
  distance between projected mesh outline and contour rather than voxel
  occupancy.
- Deform a single connected, watertight parametric surface (morphable head,
  SMPL-X body) so topology and UV indexing stay intact; never output disconnected
  voxel islands or marching-cubes blocks.
- Use parsing labels to attach each contour segment to the correct body part
  (for example arm versus torso), and the face landmarks and pose keypoints to
  anchor facial features, limbs, and joint angles. Dropped (`null`) keypoints
  contribute no constraint.
- Regularize with Laplacian/normal smoothness and the parametric prior so the
  surface stays smooth between views.

All canonical outputs must be written in `directory` under the filenames in
`assets`. Backends may share intermediates through that temporary directory,
but must archive any intermediates they want retained: only the seven canonical
outputs are published. The workspace is deleted on success or failure. A backend
error stops subsequent stages and does not publish a partial identity.
Concurrent preparation of the same new identity is not deduplicated: callers
should serialize expensive builds; publication still prevents overwrite.

## Physics-guided frame contract

`renderFrame(identity, request, { physics, renderer, diffusion, prompter })` loads a
validated stored identity without invoking reconstruction. `request` contains
finite nonnegative `time` (seconds), `pose`, `scene`, and `dynamics`. The latter
three are backend-defined; use explicit units for gravity, wind, stiffness,
damping, mass, and animation transforms.

1. `physics.simulate(...)` receives groom, scalp, skeleton, head/body collider
   paths, time, dynamics, and pose; it returns simulated curves. The solver must
   enforce scalp-root anchoring and collider constraints. Stateful solvers must
   isolate identities/sequences and handle timeline resets.
2. `renderer.render(...)` receives the bundle, curves, scene, pose, and time.
   It applies target lighting/HDRI and returns `baldComposite`, `hairMask`,
   `depth`, `lineart`, `parsing`, and `keypoints`. The hair mask and `parsing`
   map should use the consumer's BiSeNet conventions; `keypoints` is the
   OpenPose image from step 5 of the [rig order](#rig-order): body and hand
   sticks plus the 68-point face contour only (never the 106 or 468 points). Map values may
   be buffers or paths, as agreed with diffusion.
3. Optional `prompter.compose(...)` receives identity, time, pose, scene,
   camera, yaw, and the rendered `maps`, and returns `{ prompt, negativePrompt? }`
   (a nonempty string and an optional string). Connect a local llama.cpp LLM, or
   a VLM that reads `baldComposite` and the control maps, here to write
   per-frame prompts describing the identified body parts, expression, and
   pose. Without a prompter, prompt configuration stays in the diffusion
   adapter. Keep the GGUF weights local and run llama.cpp without network access.
4. `diffusion.inpaint(...)` receives those maps, identity, time, and any
   `prompt`/`negativePrompt`. An adapter can connect stable-diffusion.cpp
   `sd-cli`, the inpainting checkpoint, multi-ControlNet (depth, lineart,
   segmentation from `parsing`, and pose/face from `keypoints`), and a hair
   LoRA. It fills the gaps between the rendered mesh edges and the target view.
   Model selection and ControlNet weights belong to that adapter.

These are integration contracts, not built-in physics or rendering. There is
no executable model plugin loader: integrate the exported API in your own
application. Do not execute untrusted adapter code or untrusted assets in
external rendering tools.

## Recursive in-flight refinement

`pipeline.refineSequence(sourceIdentity, targetIdentity, requests, adapters)`
extends an existing prepared identity through sequential synthetic views.
It uses the same `physics`, `renderer`, `diffusion`, and optional `prompter` adapters plus a
`feedback` backend and an optional async `onFrame` callback.

The target must be a new identity name: existing identities remain immutable.
The method makes a private working copy of the source bundle, initializes
in-memory refinement state once, then completes all accepted updates from
Frame N **before** rendering Frame N+1. Physics and rendering receive the
latest `state` as well as the working asset paths; they must consume the
in-memory geometry, textures, skeleton, and hair hull instead of repeatedly
reloading the unchanged source files.

`requests` is a nonempty array of frame requests. Each requires:

- Strictly increasing, finite, nonnegative `time` in seconds.
- Finite `yaw` in degrees in `[0, 360)`.
- Calibrated `camera` matrices in the same format as the input views.
- Backend-defined `pose`, `scene`, and `dynamics` as needed.

The sequence must cover at least nine distinct yaw perspectives, and at least
nine distinct yaws must pass the identity guard before finalization; otherwise
nothing is published. A 24-view sweep can use yaw angles 0, 15, …, 345. The
framework does not assume that angle count alone guarantees adequate coverage.
No default camera is invented from yaw.

### Feedback backend methods

| Method | Contract |
| --- | --- |
| `initialize({ bundle })` | Decode the copied source assets into independent mutable `state`; return `{ state, identityEmbedding }`. Derive the finite embedding array from trusted original imagery/identity data (for example with w600k_r50), never from generated frames. Seed face/body UV confidence, mesh/scalp anchors, skeleton confidence, and hair occupancy/vector fields here. |
| `extract({ frame, request })` | Extract features from the generated frame without access to accumulated state. Return a full [view analysis](#view-analysis-contract) (`imageSize`, soft `matte`, subpixel `contours`, `faceParsing`, `bodyParsing`, 68-point `faceLandmarks` with at most one 106/468 add-on, or `null` when the face is not visible; `bodyJoints` in the chosen `poseMode`) plus non-null `skin`, `bodyTexture`, `bodyMask`, `hairMask`, `strandDirections` buffers/handles. Use real matting/face/pose/parser adapters; a segmentation mask alone does not provide strand orientation. |
| `checkIdentity({ frame, observations, identityEmbedding, request })` | Return a strict boolean. Reject synthetic observations inconsistent with the trusted source, geometry, hair appearance, or cross-view constraints. Configure similarity thresholds and quality tests in the backend. Rejected frames never enter update methods or temporal smoothing history. |
| `smoothHair({ frame, observations, previous, request })` | Return a non-null smoothed hair mask. `previous` is null initially, otherwise `{ frame, hairMask, request }` for the previous **accepted** frame. Implement optical-flow alpha warping/smoothing here; use camera/time gaps if intervening frames were rejected. |
| `updateAlbedo({ state, observations, request, identityEmbedding })` | Un-project visible face/body pixels through calibrated cameras and current UV geometry. Normalize illumination and replace only lower-confidence texels; persist confidence in state, not just RGB. |
| `refineGeometry(context)` | Refine the head from reprojection/landmark/contour evidence and the body from the frame's subpixel edge contours and parsing, as in [Contoured mesh fitting](#contoured-mesh-fitting). Keep topology/UV indexing, units, and scalp-root bindings consistent. Clamp updates against trusted source priors. |
| `recalibrateSkeleton(context)` | Fuse pose-mode joint observations (skipping dropped `null` points) with confidence/visibility gating and anatomical constraints; update relative bone lengths and joint limits without changing coordinate conventions. |
| `refineHair(context)` | Carve the occupancy hull using the smoothed mask and calibrated camera, fuse strand directions, and update guides while preserving scalp anchors. Geometry changes must also update collider/root bindings. |
| `finalize({ state, bundle, directory, assets, acceptedFrames, rejectedFrames })` | Export final meshes, 4K UV skin, body UV texture, scalp junction, Alembic guide curves, skeleton JSON, and archived observations/confidence/provenance to the given filenames. Unchanged source assets are already copied. Reject inadequate coverage or fit quality rather than inventing success. |

The four update methods share the same context and run in the table's order.
Low-confidence/occluded points are permitted but must not dominate fitting.
Buffers, masks, and vector-field semantics are backend-owned and must be
validated by that backend.

The source embedding is copied and frozen once. Diffusion receives this
`identityEmbedding`, the request's `camera`/`yaw`, and `controlDepth` equal to
the current renderer depth map, as well as its usual mask/depth/lineart maps.
The diffusion adapter must actually enforce those constraints; merely passing
the values is not an identity guarantee. A face-recognition embedding does not
by itself lock hair color, curl, or highlights: the guard needs separate
appearance constraints.

Frames are passed directly between adapters without being encoded or saved by
the loop. GPU tensors/handles are supported as opaque adapter values, but the
Node framework does not intercept sd-cli VRAM or implement a CUDA bridge.
Backends must synchronize producers/consumers and keep the previous accepted
frame valid for optical flow instead of recycling its GPU buffer too soon.
Extraction/guards must not mutate the state; update methods are its only
per-frame writers. Callers own backend GPU resource release on both success
and failure.

`onFrame({ frame, index, accepted })` is awaited after each frame's updates or
rejection, before generating the next frame. It can stream results without
retaining the entire video. The loop retains only the previous accepted frame;
callbacks and adapters control any additional buffering.

After the sequence, the copied body-albedo file is removed so `finalize` must
export it freshly from state, even when refining a previously refined identity.
Decode any source texture needed by finalization during initialization rather
than relying on that copied file still existing at export time.
Then `finalize` exports the state once and the library atomically
publishes a validated target bundle. The result is
`{ bundle, acceptedFrames, rejectedFrames }`. Errors, callback failures, or
all-rejected sequences delete the workspace and publish nothing. Source assets
remain intact, so failed synthetic updates cannot corrupt a reusable identity.
There are no per-frame persistent checkpoints; long runs should be managed by
the integrating application. Final export/hashing necessarily involves disk I/O
and computation, even though a second inference/baking sweep is not required.

### Confidence-aware UV accumulation

`ConfidenceAtlas` provides an actual CPU-side RGB/confidence accumulator,
defaulting to 4096×4096 (about 112 MiB for RGB and Float32 confidence buffers).
It supports face or body UV atlases. `update(samples)` accepts projected samples
with `index` (flattened texel index), `rgb` (three byte values),
`confidence` in `[0, 1]`, and optional boolean `visible` (default true).
It validates the entire batch before writing, skips invisible or zero-confidence
samples, and overwrites a texel only with strictly higher float32 confidence.
Equal-confidence samples retain the existing RGB. `coverage` reports the
fraction with positive confidence, not the fraction with nonblack RGB.

The atlas exposes `pixels` and `confidence` typed arrays for adapter initialization
and PNG/export integration. When restoring confidence externally, also restore
`populated` consistently. It does not project pixels, infer visibility,
remove lighting, encode PNGs, or perform Poisson blending. Those operations
belong to the albedo backend; GPU implementations may use their own atlas
instead. Confidence should account for angle, occlusion, image resolution,
segmentation quality, and whether evidence is captured or synthetic.

## Scope and guarantees

Reusing a complete identity bypasses **identity reconstruction inference**,
including initial detection, fitting, scalp inpainting, and parsing. File I/O,
hash verification, simulation, rendering, target-pose estimation, and diffusion
still cost time; the framework promises neither zero computation nor
millisecond setup. It returns paths rather than loading decoded geometry into
a GPU scene.

A UV map is not automatically lighting-independent: the albedo backend must
remove baked illumination. Stable geometry and textures provide deterministic
reference assets, but diffusion may still change facial features or skin tone;
ControlNet does not mathematically eliminate identity drift. Hair reconstruction
from nine silhouettes and gradient fields is still underdetermined and requires
additional priors and quality checks.

Synthetic views provide inferred evidence, not measured subject depth. They
cannot prove an exact skull/body match, expose true internal hair layers, or
guarantee full UV coverage and zero identity drift. Silhouette visual hulls
cannot recover hidden concavities or internal strand collisions without
additional evidence/priors. More angular samples do not establish the quoted
accuracy percentages or eliminate latency. Finalizing/exporting Alembic and
textures still takes work, and game-engine import compatibility must be checked
against a concrete exporter and rig/groom convention.

No model weights, licensed morphable/SMPL-X data, GPU dependencies, solvers,
or synthetic placeholder production assets are included. Tests use explicit
dummy assets and mock adapters to verify persistence and orchestration, not
reconstruction quality.