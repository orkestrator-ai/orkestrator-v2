# Step 04 — Evidence verification generations

Status: 🟨 Implemented on branch; pending review and merge

Depends on: Step 01

## Outcome

Verify one exact sealed evidence generation once before reviewer admission and
once before consolidation. Eliminate reviewer-count-proportional package and
artifact hashing without weakening stale-snapshot or tamper detection.

## Threat model and constraint

Verification is a safety boundary, not a cacheable convenience. An optimization
must still detect:

- a changed package or referenced validation artifact;
- a worktree/snapshot identity mismatch;
- evidence regenerated under a new validation run;
- a backend restart that lost ephemeral trust state;
- paths replaced through links or mount changes; and
- a consolidation attempt against evidence different from the reviewers' input.

An `mtime` or size-only cache is not acceptable. A persisted “verified” boolean
is not acceptable because files can change while the backend is offline.

## Generation model

Define a backend-local `ReviewEvidenceGeneration` identity from the immutable
references already persisted with the workflow:

- review package content hash/reference;
- ordered artifact content hashes and declared sizes;
- snapshot/worktree identity;
- validation run or package generation ID; and
- environment generation/mount identity where available.

Successful verification issues an in-memory permit:

```text
{ workflowId, generationKey, phase, verifiedAt }
```

`phase` is `fanout` or `consolidation`. A permit is deliberately not persisted.
After process restart, controller takeover, package regeneration, or evidence
identity change, verification runs again. This bounds the trust interval to one
live backend generation.

The package and artifact files must be made read-only before a permit is issued.
Verification must open/read the exact sealed objects exposed to reviewers. A
filesystem watcher may eagerly invalidate a permit, but absence of a watcher
event is never proof of immutability.

## Implementation tasks

### Protocol and storage identity

- [ ] Inventory the current package reference and artifact metadata in the
  protocol. Reuse existing hashes and generation IDs rather than adding a
  second competing identity.
- [ ] If any identity component is missing, add optional backward-compatible
  fields to the package/workflow types and validators. Older workflows without
  them use the legacy verify-per-use path until regenerated.
- [ ] Centralize deterministic generation-key construction. Sort only fields
  that are semantically unordered; do not conceal artifact-order changes.
- [ ] Never expose absolute evidence paths in the key, metric, or UI.

### Sealing and verification

- [ ] Add a backend evidence verifier/permit owner near
  `verifyEnvironmentReviewPackage` in `commands-review.ts`, or a dedicated
  `review-evidence-integrity.ts` if the responsibility no longer fits the
  command file.
- [ ] Seal permissions only after validation artifacts and manifest are fully
  written and fsynced/atomically renamed. A failed seal leaves no trusted
  generation.
- [ ] Verify path containment, file type, declared size, content hash, manifest
  parse, snapshot identity, and artifact set before issuing a permit.
- [ ] Invalidate on package replacement, stale-evidence transition, environment
  restart/generation change, controller takeover, validation rerun, explicit
  workflow restart, or any failed verification.
- [ ] Bound the permit map by active workflows and remove entries on terminal
  workflow cleanup. Do not let it become workflow history.

### Fan-out integration

- [ ] Move verification out of the per-reviewer `reviewerPrompt` callback in
  `multi-review-service.ts`.
- [ ] Require a valid `fanout` permit before any reviewer in that generation can
  leave `pending`. All reviewers in one admission wave receive the same exact
  generation key.
- [ ] If verification fails, fail the workflow and abandon/decline every live
  reviewer according to existing fatal-package semantics. Do not localize an
  evidence failure to one reviewer.
- [ ] Verify again with `phase: consolidation` immediately before building the
  consolidation evidence frame. This proves the final report is based on the
  same sealed inputs after the potentially long reviewer phase.
- [ ] Apply the same contract to Build Pipeline multi-review stages.

## Content-addressed follow-up

The strongest long-term boundary is a backend-owned content-addressed evidence
store with atomic publish and read-only mounts. Treat that as a separate design
spike unless the current package layout can adopt it without delaying the
phase-scoped permit. The spike must specify garbage collection, reference
counting across workflows, crash recovery, disk quotas, Windows/macOS behavior,
and container/local parity before implementation.

## Tests

- Two reviewers cause one fan-out verification; consolidation causes one more.
  Reviewer counts 1, 8, and 32 still produce exactly two phase verifications.
- A backend/service reconstruction re-verifies rather than restoring a permit.
- Modifying, replacing, truncating, linking, or deleting the package or any
  artifact invalidates/fails verification before the next phase.
- A package regeneration changes the generation key even if byte sizes match.
- A permit for workflow A, phase A, or environment generation A cannot authorize
  another workflow, phase, or generation.
- An old workflow missing the new optional identity uses the safe legacy path.
- No reviewer dispatch starts if phase verification fails.
- The baseline reports bytes hashed as approximately `2 * evidence bytes`, not
  `(reviewer count + 1) * evidence bytes`.

## Acceptance criteria

- Exactly one full integrity read per active phase/generation in a live backend.
- No persisted trust decision survives restart.
- Evidence is read-only for the permit's lifetime and all invalidation paths are
  tested.
- Fatal evidence errors remain workflow-wide and happen before new dispatches.
- Both local-worktree and container evidence paths have equivalent behavior.
- The service test that expected three verifies for two reviewers is replaced
  by generation-based assertions, not simply weakened.

## Implementation record

- `review-evidence-permits.ts` implements `ReviewEvidencePermits` and
  `evidenceGenerationKey`. The key is a digest of environment, package
  id/content hash/size/commit range/round and snapshot fingerprint.
- Permits are in memory only and are scoped to workflow, phase
  (`fanout` or `consolidation`), generation and controller token. They expire
  after 30 minutes and are bounded. They are dropped on failure, release,
  retry, reviewer restart and step restart.
- The runner calls `host.beforeAdmission()` once per pass, before any reviewer
  that needs its original prompt leaves `pending`/`prepared`. A failure there
  is workflow-fatal: nothing is dispatched and live reviewers are abandoned.
  Schema repairs and unstick continuations are not re-gated, as before.
- Multi Review verifies through the permit for fan-out, and again, separately,
  before building the consolidation prompt. The Build Pipeline stage verifies
  once per admission wave (its pass holds the pipeline lock).
- Rollback gate: `MultiReviewServiceOptions.evidencePermits: false` restores
  verification inside every reviewer prompt.
- Tests: two reviewers now verify twice, not three times
  (`multi-review-service.test.ts`); the pipeline verifies once for the wave;
  1–32 reviewers verify twice (bench); a retrying reviewer reuses the live
  permit but a new service re-verifies; the rollback gate verifies per
  reviewer (`multi-review-service-efficiency.test.ts`); key sensitivity,
  phase/controller/workflow scoping and expiry (`review-fanout-support.test.ts`).
- Read-only evidence: the package file is already written `0o444`. Validation
  artifacts are not re-moded by this change.
- Deferred: the content-addressed evidence store, per the plan.
