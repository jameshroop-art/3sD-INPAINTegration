# 3sD-INPAINTegration

A dependency-free Node.js framework for **persistent digital-double assets**.
It manages identity bundles and coordinates pluggable reconstruction, physics,
rendering, and inpainting backends. It does not yet implement those backends or
ship model weights.

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
| `multi_angle_pose.mask` | Produce a ZIP archive (custom `.mask` extension) containing the five raw plates, hair masks, organ rings, camera calibration, and indexed 468-point XYZ landmark maps. |
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
On a miss, exactly five views in this order are required:

1. `left_profile`
2. `left_three_quarter`
3. `front`
4. `right_three_quarter`
5. `right_profile`

Each view contains `angle`, absolute nonempty regular-file paths `plate` and
`hairMask`, and `camera` with flattened, finite `intrinsics` (9 elements) and
`worldToCamera` (16 elements). Backends must agree on matrix layout, handedness,
units, calibrated projection, and image dimensions. Numeric validation alone
does not establish physically valid calibration.

The pipeline calls these async backend methods sequentially, each receiving
the same `{ identity, views, directory, assets }` context:

| Method | Required work/output |
| --- | --- |
| `fitGeometry` | Fit/export head, body, and skeleton profile. Connect face detection and pose fitting here. |
| `bakeAlbedo` | Export illumination-normalized UV skin albedo; connect bald/scalp inpainting and Poisson harmonization here. |
| `mapScalp` | Project hair masks onto the bald scalp; export the UV junction mask and retain hull/direction-field intermediates. |
| `reconstructGroom` | Reconstruct the multi-view hair hull and guide splines rooted in the scalp; export the physics-ready groom. |
| `archiveSpatialMaps` | Archive plates, calibration, masks, rings, landmarks, and reusable fitting/inpainting intermediates in the spatial ZIP. |

All canonical outputs must be written in `directory` under the filenames in
`assets`. Backends may share intermediates through that temporary directory,
but must archive any intermediates they want retained: only the seven canonical
outputs are published. The workspace is deleted on success or failure. A backend
error stops subsequent stages and does not publish a partial identity.
Concurrent preparation of the same new identity is not deduplicated: callers
should serialize expensive builds; publication still prevents overwrite.

## Physics-guided frame contract

`renderFrame(identity, request, { physics, renderer, diffusion })` loads a
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
   `depth`, and `lineart`. The hair mask should use the consumer's BiSeNet
   conventions. Map values may be buffers or paths, as agreed with diffusion.
3. `diffusion.inpaint(...)` receives those maps, identity, and time. An adapter
   can connect sd-cli, the inpainting checkpoint, ControlNet, and a hair LoRA.
   Model selection and prompt configuration belong to that adapter.

These are integration contracts, not built-in physics or rendering. There is
no executable model plugin loader: integrate the exported API in your own
application. Do not execute untrusted adapter code or untrusted assets in
external rendering tools.

## Recursive in-flight refinement

`pipeline.refineSequence(sourceIdentity, targetIdentity, requests, adapters)`
extends an existing prepared identity through sequential synthetic views.
It uses the same `physics`, `renderer`, and `diffusion` adapters plus a
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
- Calibrated `camera` matrices in the same format as the five input views.
- Backend-defined `pose`, `scene`, and `dynamics` as needed.

A 24-view sweep can use yaw angles 0, 15, …, 345. Partial sweeps are allowed;
the framework does not assume that angle count guarantees adequate coverage.
No default camera is invented from yaw.

### Feedback backend methods

| Method | Contract |
| --- | --- |
| `initialize({ bundle })` | Decode the copied source assets into independent mutable `state`; return `{ state, identityEmbedding }`. Derive the finite embedding array from trusted original imagery/identity data (for example with w600k_r50), never from generated frames. Seed face/body UV confidence, mesh/scalp anchors, skeleton confidence, and hair occupancy/vector fields here. |
| `extract({ frame, request })` | Extract features from the generated frame without access to accumulated state. Return `faceLandmarks` (468 indexed XYZ/confidence objects), `bodyJoints` (133 indexed XYZ/confidence objects), and non-null `skin`, `bodyTexture`, `bodyMask`, `hairMask`, `strandDirections` buffers/handles. Use real face/pose/parser adapters; a segmentation mask alone does not provide strand orientation. |
| `checkIdentity({ frame, observations, identityEmbedding, request })` | Return a strict boolean. Reject synthetic observations inconsistent with the trusted source, geometry, hair appearance, or cross-view constraints. Configure similarity thresholds and quality tests in the backend. Rejected frames never enter update methods or temporal smoothing history. |
| `smoothHair({ frame, observations, previous, request })` | Return a non-null smoothed hair mask. `previous` is null initially, otherwise `{ frame, hairMask, request }` for the previous **accepted** frame. Implement optical-flow alpha warping/smoothing here; use camera/time gaps if intervening frames were rejected. |
| `updateAlbedo({ state, observations, request, identityEmbedding })` | Un-project visible face/body pixels through calibrated cameras and current UV geometry. Normalize illumination and replace only lower-confidence texels; persist confidence in state, not just RGB. |
| `refineGeometry(context)` | Refine the head from reprojection/contour evidence and the body from multi-view silhouette constraints. Keep topology/UV indexing, units, and scalp-root bindings consistent. Clamp updates against trusted source priors. |
| `recalibrateSkeleton(context)` | Fuse 133-joint observations with confidence/visibility gating and anatomical constraints; update relative bone lengths and joint limits without changing coordinate conventions. |
| `refineHair(context)` | Carve the occupancy hull using the smoothed mask and calibrated camera, fuse strand directions, and update guides while preserving scalp anchors. Geometry changes must also update collider/root bindings. |
| `finalize({ state, bundle, directory, assets, acceptedFrames, rejectedFrames })` | Export final meshes, 4K UV skin, body UV texture, scalp junction, Alembic guide curves, skeleton JSON, and archived observations/confidence/provenance to the given filenames. Unchanged source assets are already copied. Reject inadequate coverage or fit quality rather than inventing success. |

The four update methods share the same context and run in the table's order.
Point objects contain finite `x`, `y`, `z` and `confidence` in `[0, 1]`;
array indices must map to the backend's documented landmark/joint definitions.
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
from five silhouettes and gradient fields is underdetermined and requires
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