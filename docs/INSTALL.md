# 3sD-INPAINTegration acquisition and offline installation

Run these phases in order. Commands assume the repository root as current
directory; replace `/absolute/...` examples with actual reviewed local paths.
Examples are operational templates, not commands executed during this PR.
No model download is required for documentation or fixture tests.

## Prerequisites and current blockers

- Development: Node.js **22+**; Python 3 with the standard library for operational
  scripts and their tests. The Node framework has no runtime dependencies.
- Wheel construction and deployment require an authenticated **Python 3.12**
  bootstrap and Python 3.12 virtual environments. Operational tooling itself
  remains standard-library-only; no extra packages are needed merely to run it.
- Offline execution: Linux x86-64, `unshare` with working user/network namespaces,
  local Python/venv/pip prerequisites, trusted storage and physically disconnected
  creation hardware. Prepare OS packages/toolchains on the acquisition machine.
- Provision Node.js 22+ and Python from authenticated offline bootstrap artifacts
  before running these scripts; the interpreter and OS bootstrap are trusted
  prerequisites, not downloaded by the launcher. Do not run internet `apt`,
  `pip`, npm or other package acquisition on the creation machine.
  Select Python 3.12 for acquisition setup/build/install and transfer the complete
  trusted interpreter/venv/pip bootstrap without online builder downloads.
- Target-native wheels, all transitive dependencies, native runtime libraries,
  GPU drivers/CUDA where applicable, reviewed source recipes and actual adapters
  are supplied by humans. They are not downloaded or inferred by offline tools.
- [Model inventory](../models/README.md) records metadata only. Unknown hashes,
  sizes, licenses or source revisions block their corresponding assets/build.
  No weights ship. Never replace an unknown trusted SHA-256 with a guessed value
  or a claim about an unavailable prior conversation.

| `--target` | Host selection | Execution status |
| --- | --- | --- |
| `linux-cpu` | Linux x86-64 | Namespace backend exists; needs reviewed CPU recipe, wheels and adapter. |
| `linux-gpu-cuda` | Linux x86-64 | Same isolation; CUDA/build compatibility is not automatically validated. |
| `macos-m1` | macOS arm64 | Metadata target recognized; execution blocked pending reviewed isolation backend. |
| `windows-gpu-cuda` | Windows x86-64 | Metadata target recognized; execution blocked pending reviewed isolation backend. |

These target identifiers select host checks and local recipe/requirements files.
They are not four complete platform implementations; cross-building is refused.

## Phase 1 — Validate development checkout

On the dedicated connected preparation machine, obtain the repository for
review (this is development/acquisition, not creation):

```sh
git clone https://github.com/jameshroop-art/3sD-INPAINTegration.git
cd 3sD-INPAINTegration
```

Check out the human-approved operational revision before assembling a deployment
bundle; cloning the current default branch does not authenticate a release or
pin external sources. Provision the trusted Python/Node bootstrap described above.

```sh
npm run check
npm test
python3 -m unittest discover -s test -p 'test_*.py'
```

Expected: existing structural/orchestration and operational fixture tests pass.
This proves neither model installation nor physical air-gap isolation. Keep
production `src/` unchanged for this task.

## Phase 2 — Human provenance and license review

On a separate acquisition machine, review each needed model/runtime source,
upstream license and intended use. Populate an asset entry only with an
authenticated source URL, exact SHA-256, expected byte size, safe destination,
reviewed extraction allowlist/limits and license; then mark it ready.
For an archive, `extraction.member_sha256` must map exactly every allowed
`members` path to a pretrusted lowercase SHA-256; acquisition verifies each
extracted file against that map after safe extraction. Missing/extra/incorrect
member hashes block transfer/publication. A directory is never hashed.
Keep unavailable entries blocked. Resolve each required source-lock `null`
commit to an independently verified exact commit only after human review.

Do not download subject data or models in CI. BFM/SMPL-X, recognition weights,
ONNX conversions, inpainting/ControlNet/LoRA checkpoints and GGUFs have separate
license/provenance obligations; Apache-2.0 for this repository does not grant
rights to those assets.

The inventory currently names YOLOX/DWPose/RTMW3D, SAM2/BiRefNet, face parsing
and landmark/recognition packs, local Qwen text/vision GGUFs and projector,
SD1.5 inpainting/ControlNets and manual parametric-model inputs. Optional Sapiens
models are non-commercial; InsightFace pretrained models also carry distinct
non-commercial research restrictions. Optional SDXL/custom checkpoints/native
wheels remain blocked without exact provenance and compatibility. Treat this
as a candidate inventory, not a licensed installed stack.
Verified Buffalo-L release URL/size metadata likewise does not authenticate
the archive or extracted members: trusted archive/member hashes and license
approval remain required and blocked until reviewed.

Prepare a **separate absolute** acquisition policy outside the creation bundle:

```json
{
  "offline_required": false,
  "acquisition_only": true
}
```

Do not mutate `offline/policy.json` or the creation policy to acquire assets.

## Phase 3 — Explicit connected-machine acquisition

After all selected entries have trusted metadata:

```sh
bash scripts/setup_model_downloads.sh \
  --acquisition-only --connected-machine \
  --policy /absolute/separate/acquisition-policy.json \
  --manifest /absolute/reviewed/models/manifest.json \
  --model-root /absolute/transfer/models \
  --venv /absolute/local-acquisition-venv
```

Setup initializes only the model root and a new empty no-pip venv; it does not
precreate archive destinations/member parents, acquire models, upgrade pip or
establish asset readiness. An existing venv is refused. Duplicate identifiers,
duplicate destinations and overlapping/nested destinations are rejected.
Use the trusted Python 3.12 interpreter for this setup. Acquisition setup must
sanitize its environment; a venv name alone does not establish interpreter
version or safety.

```sh
python3 scripts/fetch_models.py \
  --acquisition-only --connected-machine \
  --policy /absolute/separate/acquisition-policy.json \
  --manifest /absolute/reviewed/models/manifest.json \
  --model-root /absolute/transfer/models
```

Selected-group/local-fallback invocation:

```sh
python3 scripts/fetch_models.py \
  --acquisition-only --connected-machine \
  --policy /absolute/separate/acquisition-policy.json \
  --manifest /absolute/reviewed/models/manifest.json \
  --model-root /absolute/transfer/models \
  --group pose --retries 2 \
  --local-dir /absolute/reviewed/local-fallback
```

`--group` is repeatable and must match manifest groups; the example selects
`pose`, not a full creation stack. A local fallback file is named by asset ID
and must match the pretrusted size/hash. It is not an offline creation escape
hatch. Current retry bounds are 0–5. Acquisition rejects blocked entries before
transfer, hash/size mismatches, unsafe paths, unapproved archive members or
existing unverified extracted destinations. Fix provenance/staging; do not turn
off integrity checks.
Optional entries are skipped by default. Explicit `--include-optional` selects
them too; selected optional-but-blocked entries still fail before transfer.
This flag does not enable the deliberately disabled SDXL backend.

After `setup_model_downloads.sh`, use the requested order with the same explicit
arguments and transfer root:

```sh
bash scripts/download_segmentation_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json --model-root /absolute/transfer/models
bash scripts/download_pose_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json --model-root /absolute/transfer/models
bash scripts/download_face_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json --model-root /absolute/transfer/models
bash scripts/download_language_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json --model-root /absolute/transfer/models
bash scripts/download_sd15_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json --model-root /absolute/transfer/models
```

Acquire separately inventoried SAM2 config with `download_sam2_config.sh` and the
same arguments.
`download_optional_sdxl_controls.sh` deliberately refuses until reviewed
backend support exists. `clone_model_implementations.sh` forwards to the
explicit source-acquisition helper; none of these wrappers installs adapters.

Expected only conditionally: selected assets verify and publish to their safe
destinations. With shipped unresolved metadata, **blocked acquisition is the
correct result**, not a broken promise. Stage source checkouts separately using
the explicit source acquisition helper described below.

```sh
bash scripts/clone_model_implementations.sh \
  --acquisition-only --connected-machine \
  --policy /absolute/separate/acquisition-policy.json \
  --lock /absolute/reviewed/offline/manifests/sources.lock.json \
  --destination /absolute/transfer/external \
  --source stable-diffusion.cpp
```

`--source` is repeatable and selects acquisition-lock IDs, not arbitrary URLs.
Use an actual reviewed ID from that lock; the command remains blocked while
its status/license or commit is unresolved. The helper fetches the exact pinned commit into a new
local checkout; it does not build/install/execute the repository. Review license,
submodules, symlinks and source contents before making it eligible for offline
build. The shared source lock uses `id`, owner/repository names and `status: ready`;
build checks the approved repository/commit/license metadata and source content
again before use.
Source-lock verification metadata may record verified commits separately from
`build_status: untested` and unresolved license status. A verified source commit
does not verify a model hash, build recipe, runtime compatibility or permission
to use its weights; retain each independent blocker.

## Phase 4 — Assemble and authenticate the transfer bundle

Physically transfer the reviewed repository/tooling, source checkouts, models,
native prerequisites and target wheelhouse to disconnected hardware. Prepare
these local files under the bundle root:

Use reviewed USB/removable media and a fresh destination. For a trusted,
already-reviewed directory bundle, a standard local copy is sufficient:

```sh
cp -a /absolute/trusted-usb/offline-bundle /absolute/new-local-bundle
python3.12 offline/verify_offline.py --root /absolute/new-local-bundle --target linux-cpu
```

The destination must not already exist. Authenticate the inventory out of band
and inspect/reject links, special files and unsafe contents before copying;
`cp -a` preserves them and is not a security validator. A reviewed user-controlled
archive may instead be unpacked with a standard local tool after member/path/link
review, with no overwrites or traversal. No custom USB pack/unpack helper ships,
but standard trusted local tools exist. Physical media alone is not authenticity.

| File / directory | Required contents |
| --- | --- |
| `offline/policy.json` | Unmodified fail-closed offline execution policy. |
| `models/manifest.json` | Shared `schema_version: 1` / `models` inventory with required ready assets, trusted hashes, exact sizes, model-relative destinations and licenses. |
| `config/model_paths.json` | Explicit named model mappings resolved relative to its model root, not directly relative to the repository. |
| `models/` | Actual trusted local model files beneath the policy/config model root. |
| `offline/manifests/sources.lock.json` | Shared reviewed `schema_version: 1` / `sources`: repo, exact commit, license, ready status. Null/unresolved revisions block build. |
| `offline/sources/<repository-name>/` | Clean pinned local Git checkouts without unsupported submodules/symlinks. |
| `offline/wheelhouse/<target>/` | Only trusted regular `.whl` files for the selected host/ABI. |
| `offline/build-requirements.<target>.txt` | All build dependencies pinned with hashes. |
| `offline/requirements.<target>.txt` | All runtime dependencies pinned with hashes. |
| `offline/manifests/wheel_rules.json` | Human-reviewed target defaults and per-wheel SHA/name/version/target/Python-3.12 environment profiles; empty/unresolved rules block installation. |
| `offline/recipes/<target>.json` | Reviewed explicit build commands and deterministic ordered patches. Missing/empty recipe blocks. |
| `offline/artifacts.sha256` | Independently authenticated inventory covering all required files, every operational `.py` tool, models/members, sources, wheels, policies, configs, recipes, patches and adapter/runtime dependencies. |

Model/work/output roots in the policy are authoritative; runtime and wheelhouse
locations are fixed operational-script conventions, not extra policy fields.
The examples above must match the actual bundle. Acquisition and offline verification share
`models/manifest.json`; do not assume the downloader assembles the complete
operational bundle/config/requirements. Resolve destinations as
Keep `config/model_paths.json` to the exact requested keys; document path-origin
ambiguity externally rather than adding configuration metadata fields. Resolve destinations as
`bundle_root / model_root / destination`. For extracted directory assets,
inventory and authenticate each actual local output file separately; an archive
hash does not verify a directory, and directories themselves are not hashed.
Offline verification uses the same archive entry and its reviewed
`extraction.member_sha256` map: every allowed extracted member needs an
authenticated artifact-inventory record and matching member hash. The exact
allowlist, size limit and actual directory contents must match, with no links
or unexpected files. A directory is never hashed as the original archive.
Optional `--deployment-manifest /absolute/reviewed/deployment-manifest.json`
on `scripts/fetch_models.py` emits same-schema individually ready member
records after trusted extraction, preserving parent archive provenance and
unselected entries. The output must be outside the model root with an existing
safe parent and must not already exist. Human review/authentication of the
emitted manifest and files remains required; output generation does not
self-authorize missing hashes. Deployment-only member entries are not acquisition
download entries.

Each requirement line is exactly:

```text
package-name==reviewed-version --hash=sha256:64-lowercase-hex-digits
```

This is a format illustration, **not** a usable pin. Each actual hash must match
exactly one local wheel with the same distribution/version. Requirements may
not contain URLs, paths, directives, source distributions or implicit
dependency downloads. Maintain a complete explicit transitive dependency set.

Hash-inventory format is `SHA256`, two spaces, relative POSIX path. Do not hash
`offline/artifacts.sha256` into itself. Authenticate the inventory externally;
hashing freshly downloaded bytes alone does not establish trusted provenance.
The shipped checkout intentionally lacks a usable complete artifact inventory
and stack; no automatic “trust all local files” command is provided.

## Phase 5 — Verify without importing models

On the disconnected machine:

```sh
python3 offline/verify_offline.py \
  --root /absolute/offline-bundle --target linux-cpu
```

Expected only with prepared trusted assets: local metadata/size/hash checks
pass and a local verification audit record is written. Verification does not
probe CUDA, install wheels, create isolation or load inference models. Missing
artifact inventory, required blocked asset, malformed policy, wrong host,
unsafe path or mismatch returns nonzero (normally `Blocked:` and exit 2).

## Phase 6 — Offline source build, then review outputs

```sh
python3.12 offline/build_offline.py \
  --root /absolute/offline-bundle --target linux-cpu
```

Optional `--source REPO=relative-local-checkout` is repeatable and must name an
exact repository in the trusted lock. Build requires clean pinned sources,
hashed source files, reviewed recipe/patches, nonempty build requirements and
the matching wheelhouse. Current recipe entrypoints are staged
Without an override, use the reviewed `offline/sources/<source-id>`
checkout when present, otherwise its reviewed `external/<source-id>`
checkout. Both paths still require pinned clean contents and trusted hashes;
fallback is local only, never a clone/download during build. Current recipe entrypoints are staged
Only selected implementation IDs are build prerequisites. Default selection is
`sam2`, `sapiens`, `stable-diffusion.cpp`, `llama.cpp`; optional recipe
`source_ids` selects a unique reviewed subset. Unselected blocked model-only
metadata does not force every lock entry ready; each selected blocked or null
source still refuses. Current recipe entrypoints are staged
`venv/bin/python`, with explicit argument arrays; this is not a generic
CMake/CUDA/Metal build driver. Stage suitable reviewed build orchestration
through that contract, or leave an unsupported native build blocked.
Recipes may explicitly select `source_ids`; use actual IDs such as
`sam2`, `sapiens`, `stable-diffusion.cpp` and `llama.cpp`. Selection does not
approve blocked licenses or resolve null revisions. A reviewed smaller source
set must still provide the actual implementations needed by its chosen target.

The required construction sequence is: acquire exact resources on the separate
connected machine → human-comb/review code and licenses → apply reviewed
deterministic offline patches → create isolated **Python 3.12** build venv →
build compatible `cp312` wheels (or compatible pure-Python wheels) → record hashes
and SBOM → human-review/authenticate outputs → offline installation. Review
runtime imports, lazy loaders, native hooks, update/telemetry paths and sidecars
for DNS/TCP/HTTP/HTTPS and external IPv4/IPv6 access. No online resource download
is allowed during build. Missing reviewed patches/resources/ABI compatibility
block the target, not trigger fetching or silent fallback.

Expected only with complete inputs and working isolation: local build completes
in `offline/staging-build-<target>`. Existing staging is refused; do not reuse
mutable partial output silently. A human must review/hash successful outputs
and update the independently authenticated transfer inventory before trusting
or installing them. No source “latest” lookup or online build fallback exists.
The recipe must emit wheel outputs outside staged input `wheels/`, `venv/` and
`sources/` directories; no output wheels means blocked. The builder writes
deterministic staged `artifacts.sha256` and `sbom.json` for those outputs, with
`authenticated: false` and `review_required: true`. These generated inventories
are review aids, not automatic supply-chain authentication.
It also emits `wheel_rules.proposed.json`; proposed profiles are not approved
installation rules. Human review must supply authenticated per-wheel rules in
`offline/manifests/wheel_rules.json`, whose shipped `rules` array is empty and
therefore blocks real installation.

## Phase 7 — Offline wheel installation

```sh
python3 offline/install_offline.py \
  --root /absolute/offline-bundle --target linux-cpu
```

Expected only after verification and with target runtime requirements/wheels:
immutable local runtime venv `offline/runtime/venv-linux-cpu` is created under
namespace isolation, with no-index/require-hashes/wheel-only/no-deps pip.
The isolated build/install sequence also runs `pip check` to detect omitted or
incompatible transitive dependencies; `--no-deps` is not permission to omit them.
Install only with trusted Python 3.12 and matching `cp312`/compatible pure wheels;
native platform tags, libraries and drivers must match the actual target.
Review/validate an environment rule for every wheel in
`offline/manifests/wheel_rules.json` before installation. “Localhost Only” means
Each approved rule includes `status: "approved"` and hashed local `review`
evidence (`path` and `sha256`); blocked proposals cannot claim review approval. “Localhost Only” means
The cold gate also validates every wheel's actual ZIP metadata and compatibility
tags, including manylinux/glibc compatibility; a filename or profile alone is
not proof of a valid compatible wheel. Build outputs undergo the same check
before proposed rules/hash/SBOM generation. “Localhost Only” means
Compatible profiles include supported `cp312` native wheels, compatible `abi3`
wheels and `py3`/`py312` `none-any` pure wheels; native files inside an `any`
wheel are rejected. Linux native tags must match x86-64 and host glibc. “Localhost Only” means
Every wheelhouse file requires approval, including unselected wheels and build
dependencies. Remove unreviewed extras or review them; selection cannot bypass
the gate. Launch also verifies the copied local venv interpreter's hash and
Python 3.12 version inside isolation. “Localhost Only” means
local-machine file/process operations, **not loopback TCP permission**: no DNS,
TCP, HTTP(S), IPv4/IPv6 or outside-sidecar access. Do not fabricate wheel hashes
or profiles to pass this gate. Linux execution needs the reviewed enforcement
backend; Windows profiles are declarative and execution remains refused until
its actual isolation backend is reviewed/implemented.
An existing venv is refused. Failed staging is retained for explicit local
diagnosis; remove incomplete staging/venv only after reviewing it and confirming
no process uses it. Successful installation is not model or adapter acceptance.

The acquisition empty-venv setup in Phase 3 is not an offline installer and
does not install a model stack. Use `offline/install_offline.py` for deployment;
do not mistake a successful empty acquisition venv for model readiness.

## Phase 8 — Launch reviewed integration and create locally

Prepare an executable adapter under the local `offline/runtime/` directory and authenticate
its hash plus dependencies. Configure local capture/input/output paths in the
reviewed adapter/config; `launch_offline.py` does not accept arbitrary trailing
model commands or implement an API plugin loader.

```sh
python3 offline/launch_offline.py \
  --root /absolute/offline-bundle --target linux-cpu \
  --adapter create-local
```

`create-local` is an example human-provided executable name, **not a shipped
adapter**. Expected only with actual licensed local models, verified runtime
files and a functioning adapter: the process completes under verified Linux
network namespace isolation. Missing adapter, blocked assets, failed namespace
probe or failed child command returns nonzero without online fallback.

The adapter must execute the [pipeline phases](PIPELINE.md): analyze nine
measured views, fit/bake/scalp/groom/archive, publish, simulate/render/inpaint,
and optionally refine to a new immutable identity. It should write sanitized
stage diagnostics and acceptance evidence locally. No actual inference command
for `sd-cli`/llama.cpp is asserted here because compatible binaries, model
paths/options and the integration adapter are not shipped.

Inspect an already complete exported identity using the actual Node CLI:

```sh
node src/cli.js import /absolute/local-identities subject_01 /absolute/local-export
node src/cli.js inspect /absolute/local-identities subject_01
node src/cli.js list /absolute/local-identities
```

This CLI only imports/inspects/lists bundles; it has no `prepare`, `render` or
`refine` subcommand. Those operations are exported JavaScript API calls made
by the integration application. Import success verifies structure/hash, not
model quality or measured anatomical accuracy.

## Cold-start acceptance

1. Record provenance/license approvals and authenticated inventory out of band.
2. On a fresh disconnected machine, verify assets before any inference import.
3. Build/install only from complete reviewed local inputs; record the selected
   host/ABI/runtime and namespace success locally.
4. Confirm no network fallback exists; refusal when namespace creation/probes
   fail is required. Non-Linux execution remains blocked.
5. Run the actual reviewed adapter with consented nine-view inputs; retain local
   phase diagnostics, output paths, camera/fit/texture/root/collision quality
   results and rejected-frame guard evidence.
6. Import/inspect the result, reuse without reconstruction, and verify failed
   reconstruction/refinement never modifies the source identity.
7. Keep all personal data, weights and private diagnostics outside GitHub.

**Current result:** a full cold start is blocked until humans supply trusted,
licensed assets, resolved source locks, target requirements/recipes and an
implemented adapter. Fixture tests and CLI help cannot replace this evidence.
