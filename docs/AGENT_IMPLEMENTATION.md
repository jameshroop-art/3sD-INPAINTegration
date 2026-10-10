# 3sD-INPAINTegration: Phase 0 through Phase 9

Read the requested issue/task, [README](../README.md), actual source and
[AGENTS](../AGENTS.md) first. If original issue/history is unavailable, report
that limitation rather than inventing a prior conversation. The initial
operational PR leaves production JavaScript unchanged; future explicitly
authorized extensions require compatibility review and regression tests.
No phase is complete merely because its command parses or a fixture passes.

## Phase 0 — Inventory & backward compatibility

**Inputs:** current checkout, requested scope and existing API/tests.
**Commands:**

```sh
npm run check
npm test
```

**Outputs:** source-backed capability/status inventory, baseline results and
disjoint implementation ownership. Preserve schema-version-1 immutable bundles,
nine named cache-miss views and historical completed-bundle reuse. Proposed
units, camera layouts, expression mapping and adapters are not enforced source
contracts. **Failures:** baseline failures or undocumented contract changes
block extension; do not fix unrelated source or silently invent missing views.
**Tests:** existing Node runner, then focused regressions for authorized changes.
**Security/license:** keep private evidence/secrets outside the PR; repository
Apache-2.0 is not model/data permission. Human review approves scope.

## Phase 1 — Schemas & nine-view extension

**Inputs:** actual view/camera/analysis contracts and immutable schema.
**Commands:**

```sh
node --test test/framework.test.js test/rig.test.js
npm run check
```

**Outputs:** documented nine-view cameras, persistent 68/106/468 landmarks,
multi-level region labels and adapter signatures. Current `VIEW_ANGLES` and
validation already require nine named views; this PR does not edit them.
Future explicitly authorized `pipeline.js`/camera changes need focused tests.
Preserve historical five-view completed-bundle import/cache reuse, not a false
promise of five-view cache-miss acceptance. Any future legacy capture adapter
must be explicit and separately tested.
**Failures:** silent schema replacement, guessed views, invalid calibration,
label/index mismatch or regressions block. **Tests:** nine-view requirements,
extra unique views, invalid cameras/contours/tiers and immutable legacy reuse.
**Security/license:** source/generated provenance is local-only; parametric and
landmark model rights are separate. Proposed units, row-major/OpenCV conversion,
semantic labels and expression mappings need adapter review.

## Phase 2 — Model acquisition separation

**Inputs:** independently reviewed source lock, approved licenses, authenticated
Python/Node/toolchain bootstrap and a separate acquisition policy.
**Commands** on the dedicated connected machine:

```sh
bash scripts/clone_model_implementations.sh \
  --acquisition-only --connected-machine \
  --policy /absolute/separate/acquisition-policy.json \
  --lock /absolute/reviewed/offline/manifests/sources.lock.json \
  --destination /absolute/transfer/external --source sam2
bash scripts/setup_model_downloads.sh \
  --acquisition-only --connected-machine \
  --policy /absolute/separate/acquisition-policy.json \
  --manifest /absolute/reviewed/models/manifest.json \
  --model-root /absolute/transfer/models \
  --venv /absolute/local-acquisition-venv
```

**Outputs:** exact approved local source checkouts, model-root directory only
and empty no-pip venv, not installed models/adapters. **Failures:** null/unresolved
pins, blocked licenses, wrong policy, unsafe paths or existing destinations
block; duplicate/overlapping destinations and an existing venv also block.
Never choose automatic “latest.” **Tests:** acquisition fixture tests
and wrapper syntax. **Security/license:** explicit acquisition-only flags,
separate absolute policy (`offline_required:false`, `acquisition_only:true`);
never mutate creation policy. Record source/license/SBOM provenance. An SBOM
does not establish rights or vulnerability freedom.
Use authenticated Python 3.12 for the acquisition venv and sanitize setup's
environment. Version mismatch or unsafe bootstrap blocks setup; do not install
dependencies merely to run the standard-library acquisition tools.

### Ordered model downloads

**Inputs:** copied human-reviewed manifest with trusted exact hashes/sizes,
approved model licenses and safe extraction allowlists with an exact
`extraction.member_sha256` map covering each allowed member.
**Commands:** after the Phase 2 acquisition setup above, execute in this order, with the same separate
acquisition policy and reviewed manifest:

```sh
bash scripts/download_segmentation_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json
bash scripts/download_pose_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json
bash scripts/download_face_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json
bash scripts/download_language_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json
bash scripts/download_sd15_models.sh --acquisition-only --connected-machine --policy /absolute/separate/acquisition-policy.json --manifest /absolute/reviewed/models/manifest.json
```

Set `--model-root /absolute/transfer/models` on each command for transfer staging.
Run `download_sam2_config.sh` with the same arguments for its separately inventoried
config. `download_optional_sdxl_controls.sh` is optional and currently refuses.
Acquisition skips optional entries by default; `--include-optional` explicitly
selects them and still refuses blocked assets before transfer.
**Outputs:** hash-verified selected assets, not a licensed working stack.
**Failures:** unknown SHA-256, blocked model, size mismatch, unsafe archive/member
or unsupported backend blocks acquisition. **Tests:** local synthetic transfer,
hash/size, policy, traversal, extraction and repeat-run tests, no real weights.
**Security/license:** mark registration-gated BFM/FLAME/SMPL-X and non-commercial
Sapiens/InsightFace checkpoints explicitly; repository licenses do not grant
checkpoint/training-data/quantization rights.

## Phase 3 — Offline wheel construction

**Inputs:** reviewed native sources/build dependencies, target-compatible wheels,
all transitive runtime requirements, model member hashes and USB transfer media.
Require trusted Python 3.12 bootstrap acquired separately, and `cp312` or
compatible pure-Python wheel ABI. Human-comb/review acquired code and licenses,
Require reviewed `offline/manifests/wheel_rules.json` target defaults and each
wheel's SHA/name/version/target/Python-3.12 profile. Empty rules and unknown pins
remain blocked. Localhost-only profiles permit local files/processes, not TCP
loopback; forbid DNS/TCP/HTTP(S)/IPv4/IPv6/outside sidecars and unsafe inherited
environment. Linux/Microsoft profile declarations do not implement Windows
isolation; unsupported execution refuses. Human-comb/review acquired code and licenses,
patch all network/lazy-download/update/telemetry paths, then create an isolated
Python 3.12 build venv from local resources only. No online builder download.
**Commands:** inspect existing interfaces before assembling the local bundle:

```sh
python3 offline/build_offline.py --help
python3 offline/install_offline.py --help
python3.12 offline/build_offline.py --root /absolute/offline-bundle --target linux-cpu
```

The build command executes only after the trusted local sources, hashed patches,
target recipe and build wheels are staged; it creates the isolated Python 3.12
build venv and refuses missing inputs without online acquisition.
The repository has no complete wheel acquisition/package utility.
Human deployment tooling must assemble and physically transfer the reviewed
bundle using [INSTALL Phase 4](INSTALL.md#phase-4--assemble-and-authenticate-the-transfer-bundle).
Do not invent a working package command or hash pin.
**Outputs:** authenticated `offline/artifacts.sha256`, shared
`models/manifest.json`, `config/model_paths.json`, individually hashed extracted
members in the shared archive map, source lock, target recipe, build/runtime requirements and
`offline/wheelhouse/<target>`. **Failures:** absent/empty requirements, ABI mismatch,
archive entries without complete trusted member maps, unknown hashes or unsigned/unreviewed provenance
block. **Tests:** hash inventory parsing, wheel pin matching, path/symlink and
omitted-dependency regressions. **Security/license:** audit every dependency and
native component; authenticate the inventory out of band rather than trust
hashes generated from arbitrary downloads. Keep subject data off transfer PRs.
Recipes must emit actual wheels outside staged inputs/venv/source trees.
Generated output `artifacts.sha256`/`sbom.json` are explicitly unauthenticated
review aids; no wheels or unreviewed outputs cannot advance to installation.
Recipe `source_ids` uses real IDs including dotted `.cpp` names; honor blocked
licenses/pins for selected sources. Generated `wheel_rules.proposed.json` is
review-only, not a substitute for authenticated per-wheel installation rules.
Review DNS/TCP/HTTP/HTTPS, IPv4/IPv6 and outside-sidecar access in Python/native
code; sidecars and every descendant must share isolation, never delegate to an
external host daemon. Missing actual enforcement remains blocked, not promised.
Current Linux worker checks PID 1, down loopback/no routes or listeners and
packet/DNS refusal, with PID-namespace descendant teardown. This is not seccomp
or a hostile-code/filesystem sandbox; validate the actual backend on deployment
hardware and report namespace refusal honestly.

## Phase 4 — Policy enforcement

**Inputs:** physically disconnected machine, trusted bootstrap and transferred
bundle with the exact flat creation policy.
**Commands:**

```sh
python3 offline/verify_offline.py --root /absolute/offline-bundle --target linux-cpu
node --test test/offline.test.js
```

**Outputs:** local integrity/config verification and sanitized local audit,
not model imports or successful isolation. **Failures:** malformed
`offline_required:true` / `policy_version:1` policy, enabled remote permissions,
missing assets/hash records or invalid paths block. JSON/comment alone is not
enforcement. **Tests:** policy typing, duplicate keys, hashes, shared model
schema, config/member paths, host mismatch and denied namespaces.
**Security/license:** all remote flags remain false; no creation-machine online
apt/pip/npm. Runtime worker uses sanitized environment. Linux network isolation
is not a filesystem/Unix-socket/native-hook sandbox; physical disconnection and
trusted reviewed code remain required. Non-Linux execution stays blocked.

## Phase 5 — Integration adapters

**Inputs:** verified target source/recipe/wheel bundle and actual reviewed adapter.
**Commands:**

```sh
python3 offline/build_offline.py --root /absolute/offline-bundle --target linux-cpu
python3 offline/install_offline.py --root /absolute/offline-bundle --target linux-cpu
python3 offline/launch_offline.py --root /absolute/offline-bundle --target linux-cpu --adapter create-local
```

`create-local` is human-provided, not shipped. Review/hash build outputs before
trusting installation. **Outputs:** conditional local build/runtime and adapter
execution; target selection does not implement CUDA/Metal/Windows stacks.
**Failures:** missing recipe/requirements/adapter, nonlocal dependencies,
`pip check` failure or refused namespace blocks with no online fallback.
**Tests:** pinned clean sources, explicit recipes, local wheels and launch
refusal tests, plus real disconnected-host acceptance separately.
**Security/license:** native hooks/adapters run only after human review; annotate
complex trust/probe invariants thoroughly. Compatible sd-cli/llama.cpp features,
model licenses and local config must be established, not inferred from binaries.
Connect reviewed local SAM2/BiRefNet/Sapiens/ONNX/GGUF loaders, sd-cli inpainting
and llama.cpp prompt adapters through the exported JavaScript API, not invented
CLI subcommands. Validate calibrated smooth geometry/UV fitting and actual
renderer-authoritative depth/lineart/parsing/OpenPose images; ControlNet is not
a 3D rig. No remote model code or unconditional pip update is permitted.

## Phase 6 — Hair physics & expression

**Inputs:** scalp UV/root bindings, calibrated masks/direction fields, groom,
colliders and reviewed physics adapter.
**Commands** for current orchestration:

```sh
node --test test/framework.test.js
```

**Outputs:** conditional reconstructed guides and simulated curves; no built-in
XPBD/collision solver exists. **Failures:** missing roots, invalid/degenerate
constraints, NaNs, penetration/tunneling or unstable timelines fail quality gates.
**Tests:** root attachment, stretch/bend convergence across dt/iterations,
collision sign/projection, self-collision if implemented, timeline reset and
identity isolation. **Security/license:** Alembic/native solver inputs and
dependencies reviewed; comments explain accumulated multiplier lifetime,
`alpha/dt²`, actual bending gradients and unilateral constraints. Reset only at
timestep/substep start, not each solver iteration. Silhouettes do not prove
hidden strand structure; preserve uncertainty and local provenance.
Map only a reviewed expression vocabulary to bounded supported FACS/blendshapes;
test bounds, unknown-text refusal and root/collider behavior under expressions.

## Phase 7 — Texture & inpaint orchestration


**Inputs:** trusted-source identity, calibrated synthetic requests, current
geometry/texture/hair state and reviewed feedback adapters.
**Commands:**

```sh
node --test test/refinement.test.js test/rig.test.js
```

**Outputs:** confidence/visibility-aware albedo, seam harmonization and a new
immutable refined bundle with freshly exported body texture.
**Failures:** failed identity/hair guard, fewer than nine accepted yaws, missing
fresh body albedo, callback/export failure publishes nothing.
**Tests:** strictly higher-confidence updates, rejected-frame nonmutation,
previous-accepted optical flow, update-before-next-render, fresh exports and
source integrity. **Security/license:** source/generated observation provenance,
model/config hashes, license references and thresholds are local-only immutable
evidence. GPU buffer ownership/synchronization is adapter-owned; no VRAM bridge
or identity-drift guarantee is claimed.
Add calibrated multi-view projection/de-lighting/seam harmonization, local
sd-cli control-map inpaint and optional VLM validation. Identity and hair
thresholds are tunable adapter configuration, distinct from keypoint default
0.45; record/test them against trusted captured evidence.

## Phase 8 — Testing & validation

**Inputs:** stable implementations, consent-free fixtures and a permitted real
isolation environment. **Commands:**

```sh
npm run check
npm test
python3 -m unittest discover -s test -p 'test_*.py'
for script in scripts/*.sh; do bash -n "$script" || exit; done
```

**Outputs:** measured test results separated from actual model/deployment evidence.
**Failures:** regressions, missing assets, bad hashes, nonlocal dependency
references, namespace/packet/DNS leakage or secret-bearing logs block.
**Tests:** nine-view synthetic fixtures, historical bundle compatibility,
policy/path/hash/missing-asset rejection, wheel-only install and dependency
checks, subprocess isolation, local secret-free audit, real packet/DNS probes
when permitted. If the host denies isolation, report refusal—not a successful
probe or relaxed fallback. **Security/license:** no weight downloads or personal
data in agent tests; fixtures are not licensed-model or physical air-gap proof.

## Phase 9 — Documentation & status

**Inputs:** final stable scripts/docs, reviewed branch and prepared actual stack
if available. **Commands:**

```sh
npm run check
npm test
python3 -m unittest discover -s test -p 'test_*.py'
for script in scripts/*.sh; do bash -n "$script" || exit; done
```

Validate every local doc link and actual CLI `--help` after interface coordination.
Then perform [cold-start acceptance](INSTALL.md#cold-start-acceptance) on the
disconnected machine only with real licensed assets/adapters.
Update README, PIPELINE and INSTALL together with a capability status table:
**implemented** (actual code), **tested** (named tests/evidence),
**adapter-only** (contract without a built-in backend), **experimental**
(explicitly unvalidated proposal), or **blocked** (missing provenance, license,
runtime, recipe, platform isolation or adapter). Do not promote an experimental
coordinate/physics proposal or mocked fixture to implemented model capability.
Include registration/non-commercial warnings and known geometry/identity/
isolation limits beside the relevant capabilities.
**Outputs:** separate fixture results, actual deployment evidence and explicit
remaining blockers. **Failures:** any required review/test or provenance gate
blocks merge; absent actual models/adapters means cold start remains blocked.
**Tests:** fixture success is not model-quality or air-gap proof; record actual
namespace refusal honestly. **Security/license:** sanitized local diagnostics,
no exposed device paths/environment secrets/generated outputs in PR/CI.
Documentation/additive tests may be automation-eligible but still require review
and CI. Use scoped branch commits; merge only after validation and human review,
never automatically. Do not fabricate percentages, latency or model success.
