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

No model weights, licensed morphable/SMPL-X data, GPU dependencies, solvers,
or synthetic placeholder production assets are included. Tests use explicit
dummy assets and mock adapters to verify persistence and orchestration, not
reconstruction quality.