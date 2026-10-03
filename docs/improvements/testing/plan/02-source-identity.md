# 02 — Qualify source identity during validation

Status: Not started. Depends on: 01. Finding: T5.

[Plan index](00-index.md) · [Previous](01-validation-contract.md) ·
[Next](03-validation-status-and-ui.md)

## Outcome and selected approach

Stop treating a stable HEAD as proof of which source the commands tested.
Implement conservative observations of the existing live worktree and carry
that qualification into every result/package. Preserve useful command execution
in dirty environments; do not silently clean, stash, commit, or isolate them.

This closes the misleading-evidence problem without pretending to solve
immutable execution. A live run can say that tracked source matched HEAD at
the observed boundaries. It cannot say that the tree was immutable between
those observations. Display source drift or uncertainty independently of
process success.

## Files and boundaries

Inspect `review-validation-worker.ts`, `review-validation-service.ts`,
`review-validation-artifacts.ts`, `commands-review.ts`,
`review-worktree-fingerprint.ts`, and `review-worktree-probe.ts` in
`apps/backend/src/core/`, plus their existing tests. The fingerprint code already
performs bounded environment-side hashing and rejects unstable observations;
reuse or extract that logic rather than adding renderer-side file reads.

Also inspect `scripts/test-admission.ts`, `scripts/test-all.ts`, and
`packages/protocol/src/host-test-scheduler.ts`: cooperative groups already
recheck HEAD after admission. Observation semantics must agree at that boundary.

## Observation design

- Expected HEAD comes from the immutable discovered plan.
- Capture source state after workspace admission, immediately before command
  spawn after host admission, after commands settle, and before package sealing.
- Persist a bounded record of observed tracked changes and nonignored untracked
  paths. Do not infer that an untracked file is harmless generated output.
- Distinguish committed source mismatch, unknown/unstable observation, and
  expected artifact output under the exact backend-owned evidence directory.
- Existing ignored build caches remain outside Git's source claim. Explicitly
  state that ignored files, dependencies, external services, and environment
  configuration are not certified by a Git-tree observation.
- Retain actual process exit status. A source mismatch qualifies evidence as
  unsuitable to establish validation of the named commit; a moved HEAD keeps
  the existing stop/rediscovery semantics.

For bounded content fingerprints, hash at the environment, stream large input,
and return digests and closed reason codes. A path list alone cannot detect
edits to an already-dirty file. Reuse the probe's time/byte bounds; inability to
complete a probe becomes `unknown`, never a clean observation.

## Implementation tasks

- [ ] Introduce a focused source-observation helper usable by the serialized
      environment worker and local/container package-sealing path.
- [ ] Capture a baseline at execution admission, not only at discovery. Record
      queued changes even when the command has not started yet.
- [ ] Capture per-command pre/post observations without blocking the worker's
      heartbeat or cancellation path. Use bounded subprocesses and await/catch
      every probe promise; stop owned probe processes on cancellation.
- [ ] Coalesce simultaneous observations where possible while retaining their
      attribution to command boundaries. Avoid continuously hashing the tree.
- [ ] Ensure cooperative aggregate groups perform compatible observations
      after their own admission. Do not double-reserve capacity or count queue
      wait as command execution time.
- [ ] Preserve uncertainty when commands overlap. An edit cannot be attributed
      confidently to one command merely because its completion was observed
      first. Qualify all overlapping evidence that may have consumed it.
- [ ] Restrict automatic artifact exclusions to exact owned paths, including
      the existing review directory exclusion. Broad `dist`, cache, or source
      glob exemptions must not be guessed by the discovery agent.
- [ ] Persist observations atomically alongside run state, within the existing
      snapshot byte budget. A missed event must be recoverable from status.
- [ ] Add source qualification to preparation and sealed package metadata.
      Compare with a fresh seal-time observation; a later change cannot silently
      upgrade or erase an earlier drift observation.
- [ ] Update review prompts to describe the actual source guarantee and ask
      reviewers to retain source limitations in their conclusions.
- [ ] Correct `docs/architecture/review-preparation.md` and the testing guide:
      document detection boundaries and remove the current clean-tree promise
      that the implementation does not enforce.

## Regression scenarios

| Scenario | Expected evidence |
| --- | --- |
| Clean tree, stable HEAD, passing check | Pass plus clean-at-observed-boundaries qualification |
| Tracked edit before execution | Pass/fail remains factual; drift is prominent and commit identity is not certified |
| Edit while queued for capacity | Fresh admission observation detects it |
| Same path edited again while already dirty | Content observation changes; path-set equality does not hide it |
| Command modifies a tracked fixture or snapshot | Source drift preserved even when command exits zero |
| Nonignored generated file appears | Explicit changed/uncertain input scope unless a valid narrow output policy exists |
| Owned evidence files appear | No recursive self-drift or repeated artifact hashing |
| File changes then restores between probes | No immutable guarantee; document the limit rather than assert impossible detection |
| HEAD changes | Existing rediscovery failure retained |
| Probe times out, exceeds bounds, or sees unstable files | Unknown qualification with reason; no false clean state |
| Backend/UI restarts while worker runs | Same run and observations rehydrate; no second dispatch |
| Local and container execution | Same normalized observation and assessment semantics |

Include rename, deletion, staged changes, non-ASCII/newline paths, symlink
changes, submodule state, and unavailable Git in focused probe tests. If a
repository feature cannot be observed reliably, record that limitation.

## Verification

Extend existing real-process worker tests and probe tests using temporary
repositories. Coordinate mutations with explicit markers/barriers, not sleeps.
Run service/package/controller tests to prove the evidence reaches every review
surface. Step 03 owns visible status assertions; step 07 owns browser recovery.
Perform the required inactive-environment test for backend changes.

Measure probe overhead on a small fixture and a representative large worktree.
Record bounded bytes/time, not paths or contents. If overhead is excessive,
reduce observation frequency with explicit weaker qualification; do not remove
bounds or report an observation that was never made.

## Future immutable execution boundary

A later isolated-snapshot mode requires a separate reviewed design: exact tree
materialization, submodules/LFS, dependency setup without implicit installation,
toolchain and service identity, output/cache directories, container parity,
credentials, resource reservations, cancellation, artifact transfer, and cleanup.
Tracked mutation during the isolated run must still qualify the result.
Do not claim isolation is equivalent to a filesystem sandbox or hermetic build.

That mode is deliberately not a dependency of this plan. If live source
qualification is insufficient for a repository's policy, report the requirement
as unmet rather than silently performing unsupported snapshot execution.
