# 3sD-INPAINTegration repository instructions

Follow [AGENTS.md](../AGENTS.md) and
[docs/AGENT_IMPLEMENTATION.md](../docs/AGENT_IMPLEMENTATION.md). Read the issue,
README and current source first.

The initial operational PR leaves production `src/` unchanged; future authorized
implementation requires focused regression coverage and must preserve immutable
bundle contracts. Nine named capture views are already required on
cache misses; historical five-view completed bundles are reusable, not accepted
as new five-view captures.

Keep deployment and personal creation on a separate disconnected machine.
Acquisition requires explicit acquisition-only/connected-machine flags and a
separate absolute policy; never weaken `offline/policy.json`. Unknown hashes,
null/unresolved source locks, absent adapters and unclear licenses block success.
No weights, personal data, invented pins or fabricated cold
starts. Linux namespace isolation must fail closed; other OS backends require
human review before execution.

Policy/isolation/license/build/model changes require human review. Automated
docs/test additions remain subject to review and CI. Work on a reviewable branch,
make scoped commits and merge only after required validation/review; never
auto-merge or bypass gates. Comment
complex security/XPBD code thoroughly when implementation is authorized.
Validate documentation paths and actual CLI arguments after coordination.

Never expose environment secrets, local device paths/inventory, personal images,
embeddings, prompts, generated outputs or private logs in source/PR/CI artifacts.
Runtime remote model code/loading is forbidden; only reviewed local sources,
models and adapters may execute. Use existing shell/Python fixture tests and
Node checks locally; do not acquire packages/models during creation.
Do not download model weights during agent sessions or use environment variables
to carry secrets. Gate all network-capable code with the offline policy and
explicit acquisition-only machine authorization.

Record dependency/SBOM provenance and separate model/runtime/data licenses.
Apache-2.0 for this repository does not grant model or training-data rights.
Mark registration-gated BFM/FLAME/SMPL-X and non-commercial checkpoints explicitly;
unknown rights/hashes remain blocked rather than silently approved.
