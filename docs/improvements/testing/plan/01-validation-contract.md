# 01 — Define validation evidence and completeness

Status: Not started. Depends on: none. Findings: T5, T6, requirement provenance.

[Plan index](00-index.md) · [Next step](02-source-identity.md)

## Outcome

Give all layers one vocabulary for what ran, what was required, what source was
observed, and what conclusion is justified. Introduce readable contracts first;
later steps populate them and change presentation. Do not equate `completed`
with passed or use a free-text note as the only record of a missing requirement.

## Current owners to inspect

- `packages/protocol/src/review-validation.ts`: plan/run/result interfaces and
  bounded runtime validation.
- `packages/protocol/src/review-workflow.ts`: package format, package validators,
  workflow compatibility, and shared exports.
- `packages/protocol/src/review-evidence-frames.ts`: discovery instructions.
- `apps/backend/src/core/review-validation-prompts.ts`: structured plan schema.
- `apps/backend/src/core/review-validation-service.ts`: result-to-package adapter.
- `apps/backend/src/core/commands-review.ts`: package generation and verification.
- `apps/backend/src/core/review-package.ts`: persisted package parsing.
- `apps/backend/src/core/storage-reviews.ts`: persisted workflow reading.

## Proposed model

Names below are proposed. Prefer additive, versioned metadata instead of
changing the existing lifecycle and per-command status unions unnecessarily.

| Concept | Proposed representation | Authoritative producer |
| --- | --- | --- |
| Plan version | Optional `schemaVersion`; absence identifies legacy input | Discovery contract/backend parser |
| Requirement | Stable ID, category, required/advisory importance, bounded source reference, selected command IDs or explicit omission reason | Discovery, validated by backend |
| Coverage outcome | `satisfied`, `failed`, `incomplete`, `not-applicable`, or `unknown`, with reason code | Pure backend/shared derivation |
| Covered command | Typed `coveredByCommandId`, separate from generic skipped status | Worker after actual covering result |
| Source observation | Expected HEAD, observation phase/time, identity mode, bounded outcome/reason, optional digest | Worker, never discovery agent |
| Validation assessment | Command outcome, completeness, source qualification, and bounded reason codes | Shared deterministic derivation |

Use requirement categories such as unit/integration, browser, native, container,
platform, static, build, and other. Category is descriptive; it must not infer
commands or decide whether the repository needs a language/toolchain.

Requirements must reference evidence such as an instruction section, task,
workflow, or explicit user requirement. Keep references workspace-relative;
do not embed file contents, command output, or environment values. A required
check with no selected commands must carry a nonempty omission reason.

## Tasks

- [ ] Write a compatibility table for current persisted plans/runs, legacy
      inline packages, current pointer packages, and the proposed additions.
- [ ] Add bounded optional requirement metadata to the plan parser. Preserve
      the current 32-command and 24,000-byte plan limits. Start with at most
      32 requirements and bounded references/reasons; oversized discovery must
      fail clearly rather than silently lose a required check.
- [ ] Reject duplicate IDs, unknown command references, malformed categories,
      invalid omission combinations, and contradictory coverage declarations.
- [ ] Keep advisory observations separate from missing required checks. Retain
      legacy `limitations` for compatibility and classify unstructured legacy
      limitations as coverage uncertainty, not known harmless advice.
- [ ] Add typed execution coverage links without mutating the discovered plan.
      The worker's effective scheduling decisions remain separate metadata.
- [ ] Add source-observation and assessment shapes with closed reason codes.
      Do not allow an agent-supplied field to claim worker verification.
- [ ] Create a pure assessment helper in protocol code, with no React, process,
      filesystem, or provider dependency. Both backend and renderer can use
      the same implementation; backend persists the authoritative assessment.
- [ ] Specify how package generation includes the new evidence in its digest.
      Keep old package bytes untouched. If compatibility requires a package
      format bump, implement a new reader branch rather than changing the
      interpretation of previously signed/hashed data.
- [ ] Update structured schema and runtime validators together. During rollout,
      readers accept old plans; new discovery responses request the new shape.
- [ ] Add package exports only where needed. If workspace manifest metadata
      changes, follow the repository's pinned-Bun lockfile regeneration rules.

## Assessment rules

1. Running/queued/planned work remains active; cancellation is a separate state.
2. A failed process result remains failed regardless of whether the overall run
   has reached `completed` or whether reviewers may proceed.
3. No executed check yields `not-validated`, including an empty limited plan.
4. A required check omitted or blocked yields incomplete validation. Advisory
   notes alone do not invalidate otherwise complete execution.
5. A covered skip satisfies a requirement only when the actual covering command
   passed and the declared dependency/coverage relationship is valid.
6. A generic skip with no typed coverage proof never counts as executed success.
7. Missing legacy coverage metadata yields an explicit legacy/unknown scope.
   Existing passed command rows still show their actual process result.
8. Dirty/changed/unavailable source observations qualify the evidence; they do
   not rewrite a successful exit code as a failing assertion.
9. Even clean observations in a live worktree do not yield an immutable-source
   guarantee. Represent execution coverage and source qualification separately.

## Tests and acceptance

Build table-driven tests of the pure helper and validators. Include: zero
commands, one pass, one failure, passed plus required omission, advisory-only
notes, valid coverage deduplication, failed coverer, unresolved prerequisite,
legacy data, malformed references, source unknown, and cancellation.

Round-trip new records through storage and package parsing. Load representative
old records without rewriting them. Confirm unknown or oversized metadata is
rejected at the boundary and that rendering cannot upgrade a backend limitation.

Acceptance: the same fixture derives the same assessment in package generation,
workflow snapshots, and frontend consumption, with documented legacy behavior.

## Verification and rollout

Run owning protocol and backend parsing tests through `test:logged`, then the
shared implementation handoff checks from the index. These changes should be
reviewable before execution/UI behavior changes. Keep the new metadata optional
for persisted readers until all producers and consumers support it.

Rollback must preserve newly recorded facts. An older UI may omit fields, but
must not be allowed to reseal a new-format package under older semantics. Test
that downgrade boundary explicitly if package format changes.
