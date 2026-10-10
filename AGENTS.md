# 3sD-INPAINTegration agent working agreement

Read [README](README.md), the requested issue/task, and actual `src` contracts
before changing documentation or implementation.
Never infer historical context or trusted model hashes from an unavailable
conversation.

## Boundaries

- Production `src/` is unchanged by the initial operational/documentation PR.
  Future authorized implementation may change it with focused regression tests.
  Preserve schema-version-1 immutable identities and existing behavior.
- Current preparation requires nine named views; historical five-view completed
  bundles remain importable/reusable, not valid five-view cache-miss input.
- No personal images, weights, embeddings, generated frames, prompts, environment
  secrets, exposed device paths, device inventory or private diagnostics in PRs.
  Acquire models only through the explicit reviewed connected-machine workflow.
- Never modify `offline/policy.json` to obtain network access. Acquisition is
  explicit on a separate connected machine using a separate absolute policy
  with `offline_required: false` and `acquisition_only: true`.
- Unknown asset hashes, unresolved source-lock revisions and unclear licenses
  are blockers. Do not substitute fabricated pins, placeholder successes or
  automatic upstream “latest” resolution.
- Linux isolation must fail closed; refuse other OS execution until a reviewed
  isolation backend exists. Target recipes are not implemented platform stacks.
- Do not execute untrusted adapters or weaken isolation for convenience.

## Workflow and review

Follow [ordered gates](docs/AGENT_IMPLEMENTATION.md). Coordinate file ownership
before parallel changes and validate documented commands against stable scripts.
Use surgical edits and add regression tests to the existing runner; do not
introduce dependencies or test tools gratuitously.
Explain complex security/XPBD invariants in verbose code comments when those
implementations are explicitly authorized.

Human review is required for policy, isolation, dependency/provenance, licenses,
native build recipes and model/adapter integration. Documentation and additive
tests may be automation-eligible but still require normal review/CI gates.
Work on a reviewable branch with scoped commits. Merge only after required
validation and human review gates pass; never auto-merge or bypass checks.

Before completion, run the smallest relevant existing checks, verify local links
and CLI help/arguments, report blockers and distinguish fixtures from real
offline/model execution. Never claim an end-to-end cold start without prepared,
licensed, trusted local assets and a working reviewed adapter.
