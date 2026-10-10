# Local model inventory

No weights ship here. The manifest is an inventory, **not** an authenticated
download allowlist. Every asset remains `blocked` with `sha256: null`; unresolved
URLs, sizes and archive layouts are deliberately null rather than fabricated.
Verified metadata: SAM 2.1 upstream checkpoint/config links and Apache-2.0,
Sapiens CC-BY-NC-4.0 license, and FaceXLib's **v0.2.0**
`parsing_bisenet.pth` release URL/53,289,463-byte size. Metadata retrieval did not
download weights or establish trusted asset hashes.
Buffalo-L v0.7 release URL and 288,621,354-byte size are likewise metadata-verified;
its trusted archive/member hashes and license approval remain blocked.

## Layout and path resolution

Join `repo_root / config.model_root / mapped_value`. The supplied configuration
comment says repo-relative, but values such as `detect/yolox_l.onnx` omit the
`models/` prefix; resolving them directly against the repo root would be wrong.
All destinations in the manifest are relative to the selected model root.
Optional custom BFM files use sibling `face/bfm_custom`, not a child of the
`face/bfm` archive destination: acquiring one package must not overwrite or
silently merge another package's trusted members. Any reviewed replacements
must likewise avoid overlapping archive destination prefixes.

```text
models/
  detect/                    YOLOX detector
  pose/{dwpose,rtmw3d/onnx}/  2D fallback and third-party Soykaf 3D export
  segment/{sam2,birefnet,sapiens}/
  face/{insightface,landmarks,parse,flame,bfm}/
  llm/{text,vision}/          BOTH text shards, vision GGUF and projector
  sd/{sd15,controlnet-sd15,sdxl,custom}/
  body/smplx/
  wheels/                    unresolved native face3d wheel
```

Sapiens filenames, custom BFM, face3d wheel and CyberRealistic destinations are
inventory placeholders where the original exact assets were unavailable; they
are not claims about published filenames. Review and replace placeholders with
exact approved local paths before acquisition. RTMW3D is a **Soykaf third-party
ONNX export**, not an official export guarantee. Sapiens is non-commercial;
InsightFace recognition weights have separate research-use terms. SMPL-X, FLAME
and BFM require manual registration/license acceptance. Never redistribute gated
data or assume this project's Apache license covers models. Native checkpoints,
remote model code and quantizations need provenance and compatibility review.

## Acquisition only — separate connected machine

First copy the manifest into a human-reviewed acquisition manifest. Authenticate
each source, exact SHA-256 and size via a trusted/out-of-band channel, review the
license and intended use, and mark only approved entries `ready`. Archive entries
also require exact allowed member paths and positive total extracted-size limits.
Each archive file must additionally have an authenticated SHA-256 in
`extraction.member_sha256` (member-relative path to hash). Acquisition checks
these individually after extraction; offline verification must check those
same local files, never attempt to hash a directory or compare it to the
compressed archive hash.

The offline verifier accepts a ready archive record only when its complete
reviewed `members`/`member_sha256` map and each local member's trusted artifact
record are present; it verifies extracted files, never hashes a directory.
`--deployment-manifest /absolute/new/deployment.json` writes a new local manifest
after successful authenticated acquisition, expanding selected archives into
individually ready member records. Output must have an existing parent outside
the model root and cannot overwrite an existing file or follow symlinks.
Each member carries its authenticated hash, measured size and parent provenance;
unselected entries are retained. Review and authenticate the output before use.
It does not install models, supply missing trusted hashes or authorize acquisition.
Alternatively, before deployment a human creates a reviewed manifest
using the **same** `schema_version: 1` / `models` schema: replace each verified
archive entry with one file entry per allowlisted member. Preserve all unrelated
entries. Each member entry has a unique ID (`archive-id:member-path`), the
parent's group/license/required flag, `status: "ready"`, destination
`parent-destination/member-path`, `extraction: {"type": "none"}`, the
already authenticated `member_sha256` value, and its reviewed exact local
`size_bytes`. Retain `parent_id`, `parent_sha256` and `parent_source_url`
as provenance metadata; `source_url` may retain that archive URL but is not
a direct member download URL. Never use this deployment manifest for acquisition.
Its ready file records describe already acquired local bytes only.

Keep the exact original acquisition manifest and authenticated archive/member
hash evidence locally. Authenticate the transformed manifest and each member's
`models/destination` path in `offline/artifacts.sha256` before verification.
No end-to-end deployment is implemented. Changing
the manifest cannot make previously untrusted member hashes trustworthy.
Do not derive “trusted” hashes from an arbitrary download or guessed conversation.
Prepare a separate policy JSON with exactly these acquisition permissions:

```json
{"offline_required": false, "acquisition_only": true}
```

Never modify `offline/policy.json` to acquire models. On the acquisition machine:

```sh
bash scripts/setup_model_downloads.sh --acquisition-only --connected-machine \
  --policy /absolute/reviewed/acquisition-policy.json
bash scripts/download_segmentation_models.sh --acquisition-only --connected-machine \
  --policy /absolute/reviewed/acquisition-policy.json --manifest /absolute/reviewed/manifest.json
```

Then use `download_pose_models.sh`, `download_face_models.sh`,
`download_language_models.sh`, `download_sd15_models.sh`, and
`download_sam2_config.sh` with the same explicit arguments. Optional SDXL wrapper
always refuses until backend support is reviewed. The shared
`python3 scripts/fetch_models.py` accepts repeatable `--group`, `--model-root`, `--local-dir`
and `--retries 0..5`. Optional entries are skipped unless `--include-optional`
is explicitly supplied; unresolved optional Sapiens assets therefore do not
block a reviewed required segmentation subset. Local fallback files are named by manifest `id` and must
match the already trusted size/hash. Blocked entries fail before any transfer,
including local fallback. Successful downloads are staged, hashed and safely
published; archives reject traversal, links, special files, unknown or duplicate
members, missing members and oversize content. Existing verified single files
are reused; unverified/extracted destinations are never silently overwritten.
Use trusted storage without concurrent adversarial writers.

`clone_model_implementations.sh` is explicit acquisition for source inspection,
not runtime loading or installation. Each selected source needs a real pinned
commit and approved `ready` source-lock entry; unresolved licenses block it.
Sources are not executed and submodules/LFS weights are not acquired.

Setup requires a trusted **Python 3.12** interpreter and creates an **empty venv
without pip bootstrap or upgrades**, using isolated interpreter mode and an
allowlisted subprocess environment (no inherited proxies, loader overrides or
secrets). This connected-machine bootstrap does not install or build packages.
Setup initializes only the model root, not archive destinations or descendants,
rejects duplicate/nested destinations and refuses an existing venv.
The requested unconditional pip update conflicts with pinned local-wheel requirements and is
not performed. Acquisition setup initializes only an empty venv and requires
explicit connected-machine acquisition authorization. It never installs packages.
All creation-device installation must use `offline/install_offline.py`, with
verified isolation and hash-pinned local wheels for the complete transitive
dependency set. There is no convenience pip installation bypass.
Review/comb and deterministically patch acquired source before building, using a
separate isolated Python 3.12 build venv and compatible `cp312` or reviewed
pure-Python wheels. Authenticate output wheel hashes/SBOM before offline
installation. No online builder downloads or outside sidecar daemons are allowed.
All sidecar descendants must share verified isolation. Namespace controls
prevent external packets/connections when verified; they do not forbid AF_INET
socket creation or prove arbitrary malicious code harmless. Missing assets and
unsupported enforcement must block rather than claim uninterrupted operation.
Offline runtime, wheels and audit paths are `offline/runtime`,
`offline/wheelhouse` and `offline/logs`. The reviewed per-wheel rules in
`offline/manifests/wheel_rules.json` must bind each actual wheel's SHA-256,
name, version, target and Python 3.12 profile before installation. Empty rules
are blockers, never permission to infer trusted pins. “Localhost only” means
local-machine file/process operations, **not loopback TCP permission**.
Linux enforcement must verify no external DNS/TCP/HTTP(S)/IPv4/IPv6 access;
Windows rules are declarative only and execution remains blocked until a reviewed
backend exists. Acquisition setup neither installs wheels nor bypasses those rules.

After authenticated acquisition, transfer via physical media and follow
[offline installation](../docs/INSTALL.md). No working model stack, actual
inference, native build, GPU compatibility or cold-start deployment is claimed.

## Fixture validation

```sh
python3 -m unittest discover -s test -p 'test_acquisition.py'
python3 -m py_compile scripts/fetch_models.py \
  scripts/setup_model_downloads.py scripts/clone_external_repos.py
bash -n scripts/download_segmentation_models.sh
```

Tests use synthetic local fixtures only; no model downloads or deployment proof.
