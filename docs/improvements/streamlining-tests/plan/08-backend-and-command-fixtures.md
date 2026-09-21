# 08 — Reduce backend control-process and Git fixture overhead

Status: Worker observation implemented; Git fixtures retained after audit.
Depends on: [01](01-baseline-and-coverage-inventory.md),
[02](02-gateway-expiry-fixture.md).

## Implementation result

Validation-worker behavior waits now observe the fixture-owned state file with
a byte bound, schema/run-identity checks and a real deadline. Start, final
public status, cancellation and control-surface validation remain process-backed.
The focused file passed in 28.5 seconds, compared with 30.36 seconds in the
review, while removing repeated Bun status processes from intermediate polls.
The command-integration Git fixtures were retained: the audited call sites
exercise repository, history, remote, upstream or worktree semantics, and no
clear directory-only use justified replacing the real fixture.

## Goal

Keep real backend lifecycle and Git behavior coverage while eliminating setup
that is unrelated to the assertion. The review measured 30.36 seconds in the
validation-worker file and 22.54 seconds in the broad command-integration file.
This step contains two independent changes and should normally be two PRs.

## Part A: validation-worker observation

Read [review-validation-worker.test.ts](../../../../apps/backend/src/core/review-validation-worker.test.ts),
[the worker/control implementation](../../../../apps/backend/src/core/review-validation-worker.ts),
and `review-validation-artifacts.ts` before changing polling.

The existing `completed`, `waitUntilQueued` and `waitFor` helpers repeatedly
invoke `control(..., "status")`. Each invocation spawns another Bun process.
The worker itself persists an atomically replaced `state.json` containing its
run and heartbeat, but the control reader also validates confinement, identity,
size and freshness. Direct file polling must not be substituted for tests of
those validations.

### Tasks

- [ ] Count control processes per test in the existing helper paths. Separate
  startup, cancellation and explicit API assertions from intermediate waits.
- [ ] Classify each case as control-surface validation or worker-behavior
  validation. Keep all direct control-surface tests process-backed.
- [ ] Add a test-only observation helper for worker-behavior waits that reads
  the fixture-owned state file without starting or modifying work.
- [ ] Bound observation reads by byte size and a real deadline. Validate the
  expected run ID/shape before passing state to a predicate. Report a concise
  status/heartbeat summary on timeout, not arbitrary file or command contents.
- [ ] Only tolerate a specifically expected transient “not created yet” state
  during startup. Treat malformed JSON, a replaced run or invalid state as
  fixture failures; do not silently poll through corruption.
- [ ] Assert the final state through the real status control process for each
  converted lifecycle scenario where that public surface is part of the result.
  Keep at least one full start → repeated status → completion sequence.
- [ ] Preserve actual process creation for worker start and cancellation, and
  keep teardown cancellation through the real control path.
- [ ] Keep tests for stale heartbeat, changed immutable plan, oversized or
  symlinked state, cancellation tombstone, queue admission, timeout/output caps,
  child cleanup and reconnect without redispatch on the real control reader.
- [ ] Do not use the test helper as a new production status implementation.
  Avoid a parallel implementation of control policy in the test harness.

Do not fake time across the worker and parent. Queue deadlines, heartbeat
expiry and child lifetime are cross-process properties. For non-timing cases,
prefer fixture barrier files or completion signals; for timing cases, preserve
the real timer boundary and the reason for its duration.

## Part B: command/Git fixture selection

Read [command-fixtures.ts](../../../../tests/unit/electron/command-fixtures.ts),
[commands-integration.test.ts](../../../../tests/unit/electron/commands-integration.test.ts)
and the command modules reached by each candidate.

`createGitWorktreeWithOrigin()` creates a bare remote, initializes a working
repository, checks out main, configures identity, commits, adds origin and
pushes. That is necessary for some branches, but not for every delegation test
that happens to ask the helper for a writable directory.

### Tasks

- [ ] Map each call site to its actual needs: writable directory, repository,
  commit history, local bare remote, worktree metadata or tracked upstream.
- [ ] Replace only directory-only uses with the existing temporary-directory
  helper. Keep production command routing and validation real; narrow the
  external dependency mock rather than mock the assertion's subject.
- [ ] Use a minimal repository for cases requiring Git identity/status but no
  remote, and keep the full helper for push/fetch/upstream behavior.
- [ ] Preserve real Git for worktree creation/deletion, branch rename,
  rollback, dirty/untracked files, ignored artifacts, caches and concurrent
  changes. A canned `git status` string is not equivalent to those tests.
- [ ] Consider immutable per-file repository seeds only if process counting
  shows setup still dominates. Copy into separate fixture-owned directories;
  never share mutable refs, index, hooks or worktree metadata between tests.
- [ ] Verify copied repositories do not retain remote paths into another
  case's directory and do not use hardlinks for mutable Git objects/metadata
  without proving the resulting isolation.
- [ ] Leave real parser tests in `tmux-session.test.ts` intact. They prove an
  installed parser accepts generated configuration; a mock parser cannot
  replace them. Put them in an explicit owner only if selection is clarified,
  not simply to exclude their cost from the full gate.

## Validation

```bash
mise run test:logged -- --name streamlining-validation-worker -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures

mise run test:logged -- --name streamlining-command-fixtures -- \
  bun test ./tests/unit/electron/commands-integration.test.ts \
  --parallel=1 --only-failures
```

Then run affected command-registry, scheduler, artifact and lifecycle suites.
Exercise concurrent fixtures with the normal aggregate worker plan. Confirm
each child exits before deleting its directory, and no fixture contaminates
another's Git config, environment, remote or state files.

## Completion and rollback

- [ ] Converted worker waits create fewer control processes without bypassing
  control-surface or immutable-state coverage.
- [ ] Command fixtures create fewer Git processes where Git is irrelevant.
- [ ] No mutable repository/worker state is shared across independent cases.
- [ ] Measured file/package duration improves and required integration cases
  remain listed explicitly.

Revert observation polling separately from Git fixture changes. If direct
state observation cannot remain a faithful test-only wait, keep process-backed
status polling and record the candidate as deferred.
