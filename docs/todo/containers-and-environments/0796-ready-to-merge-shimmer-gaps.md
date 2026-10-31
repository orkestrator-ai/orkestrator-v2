# The "ready to merge" shimmer lacks live GitHub evidence for some merge states

An environment's name shimmers while its pull request is ready to merge
(`evaluatePrMergeReadiness`, `packages/protocol/src/pr-merge-readiness.ts`; see
[github-pull-requests.md](../../architecture/github-pull-requests.md#ready-to-merge)).
Viewer merge permission is now cached and checked, and a leaf's monitor health
is relayed to command nodes. What remains is live evidence for the merge states
that real PRs have not shown yet.

## Task analysis

Analysed 2026-10-30 against `main` at `cd7bbe3e5`.

The feature landed in `917600f2e` (#1404). `cd7bbe3e5` (#1451) added the red
conflicts and yellow waiting colours on the same freshness rule but did not
touch any task here. The earlier analysis (2026-10-28, `79f3bc97`) still held:
none of the three tasks had merged. Tasks 1 and 2 are done on this branch.

### Tasks

1. **Viewer permission**: the shimmer can show for a credential that may not merge. Status: done.
2. **Relay a leaf's monitor health**: let a command node show readiness for another machine's rows again. Status: done.
3. **Live evidence**: confirm the `mergeStateStatus` mapping against real GitHub, and that the container image's `gh` accepts the fields. Status: open (`DIRTY`, `UNSTABLE` and the image's field list confirmed; `CLEAN`, `BLOCKED` and draft still unobserved).

### 1. Viewer permission

**Problem.** A read-only credential saw the shimmer, then got an error from
Merge. The rule did not ask whether the viewer may merge.

**Context.** The PR monitor's lookup is `gh pr view <url> --json
url,state,mergeable,mergeStateStatus,isDraft,…` or `gh pr list --head … --json
…` (`getPrMonitorDetectionRequest`, `apps/backend/src/core/commands-pr-monitor.ts`).
An open PR is polled every 20 s. Merge runs with the same credential the
monitor reads with: host `gh api` in the worktree for local environments
(`mergePullRequestViaGitHubApi`), `gh` inside the container otherwise
(`mergePullRequestInContainer`, both in `commands-review.ts`).

**Investigation.** `gh` has no viewer or permission field for `pr view --json`.
The PR viewer already derives write access from REST `permissions` (`admin`,
`maintain` or `push`) in `loadViewerIdentity`
(`apps/backend/src/core/github-pull-requests.ts`), with the Settings credential.
Done on this branch: `PrViewerPermissionCache`
(`apps/backend/src/core/pr-viewer-permission.ts`) is filled by `gh api
--hostname github.com repos/{owner}/{repo} --jq .permissions` through the
detection's own runner, for open PRs only, once per credential scope and
repository per hour. The answer travels as `viewerCanMerge` on the monitor
state, and `evaluatePrMergeReadiness` returns `no-merge-permission` only for
`false`. A merge that fails with a permission-shaped error clears the entry
(`runStoredEnvironmentMergeOnce`). Read-only check against this repository:
the lookup printed `{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}`.

**Decisions.**

- **How to learn whether the merging credential may merge?**
  - **A per-repository cache, filled through the environment's own `gh` runner, refreshed at most hourly and cleared when a merge fails with a permission error (recommended).** Implemented.
    - Pros: at most one extra request per repository per hour; checks the credential that will merge.
    - Cons: new cached state and a new not-ready reason; a revoked permission shows the shimmer for up to an hour; push access still does not prove a ruleset lets this user merge.
  - **Ask on every poll.**
    - Pros: always current.
    - Cons: one more GitHub query per environment every 20 s.
  - **Accept the gap and keep the documented caveat.**
    - Pros: no code.
    - Cons: a read-only credential still shimmers.

### 2. Relay a leaf's monitor health

**Problem.** A command node received a leaf's persisted PR reading but not
whether the leaf's monitor was current, so it could not tell a healthy leaf
from one whose `gh` kept failing. Remote readiness was switched off.

**Context.** Node summaries are built from the leaf's `get_environment_snapshots`
(`apps/backend/src/core/nodes/node-read-model.ts`) by `toNodeEnvironmentSummary`
(`packages/protocol/src/node-summaries.ts`). The leaf's health is runtime
monitor state: `consecutiveErrors` and `lastSuccessfulCheckAt`, which `pause`
clears (`apps/backend/src/core/pr-monitor.ts`). The command node refreshes a
project's summaries on the leaf's `environment` resource changes, on reconnect,
and every 60 s.

**Investigation.** Done on this branch. `isPrReadingConfirmedByMonitor`
(protocol) is the monitor half of freshness, used by this machine's rows and by
the leaf. `get_environment_snapshots` with `includePrMonitorHealth: true` adds
`prMonitorConfirmed` and `prViewerCanMerge` from the announced monitor state
(`PrMonitorRuntime.relayedHealth`); the command node always sends it
(`NODE_SUMMARY_ENVIRONMENT_READ_ARGS`). When the monitor-side inputs change,
`PrMonitorRuntime` announces a content-free `environment-pr-health` resource
change, and the command node re-reads that project. `nodeEnvironmentPrMergeState`
(`apps/web/src/lib/pr-merge-readiness.ts`) requires a connected machine,
`current` summaries and `prMonitorConfirmed`. The remote sidebar shows ready and
conflicts; search and the mobile title show ready.

**Decisions.**

- **What to relay?**
  - **One leaf-computed boolean per environment, `prMonitorConfirmed` (recommended).** Implemented.
    - Pros: the leaf applies the same rule as its own rows; no clock comparison across machines; a reconnect re-read reconciles missed events.
    - Cons: the snapshot handler joins runtime monitor state into persisted records; one more resource-change source.
  - **Relay the raw fields and decide on the command node.**
    - Pros: richer detail later.
    - Cons: duplicates the rule; timestamps from another clock; more protocol surface.
  - **Keep remote readiness off for good.**
    - Pros: no work.
    - Cons: the feature stays local-only.

### 3. Live evidence

**Problem.** The `mergeStateStatus` mapping (`mergeabilityFromMergeStateStatus`,
`pr-merge-readiness.ts`) is tested with fixtures. An unknown JSON field makes
the whole `gh` lookup fail, so the container image's `gh` must accept
`mergeStateStatus` and `isDraft`.

**Context.** The image installs `gh` from Debian's apt (`docker/Dockerfile`),
unpinned, on `oven/bun:1.4.4-debian`. The cases to confirm: `CLEAN` for a
mergeable PR, `BLOCKED` with a required review outstanding, `UNSTABLE` with a
failing non-required check, and `DRAFT` or `isDraft` for a draft.

**Investigation.** Observed on 2026-10-30, read-only:

- Host `gh` is 2.102.0. Both local images (`orkestrator-v2:latest` and
  `orkestrator-v2:dev-2726f8f5da9b`) ship `gh` 2.46.0 (`Debian 2.46.0-3`, Debian
  13 trixie). Run with `--network none`, `gh pr view --json` lists
  `isDraft`, `mergeable`, `mergeStateStatus` and `statusCheckRollup`, and
  `gh api --help` lists `--hostname` and `--jq`. An authenticated lookup inside
  a container was not run.
- The monitor's exact lookup (`gh pr view <url> --json
  url,state,mergeable,mergeStateStatus,isDraft,baseRefName`) on this
  repository's open PRs exited 0. #1452 returned `DIRTY` with `CONFLICTING`.
  #1449 and #1443 returned `UNSTABLE` with `MERGEABLE`; their rollups had
  failing checks ("Unit and integration tests", and on #1449 "Native menu
  (windows-latest)"). `main` is unprotected with no rulesets, so those checks
  are non-required, which matches the `unstable` mapping.
- No open PR was `CLEAN`, `BLOCKED` or a draft, and this repository has no
  required review, so those cases cannot occur here today. Merged PRs return
  `UNKNOWN`, which maps to not ready.

**Decisions.**

- **What run counts as a pass?**
  - **A throwaway private repository with a ruleset that requires one review and one status check, and four PRs (clean, review outstanding, failing non-required check, draft), read with the exact monitor lookup on the host and inside the current image (recommended).** Pass: the four expected values, and the image's lookup exits 0.
    - Pros: covers every mapped state and the image in one sitting; no risk to real repositories.
    - Cons: creating the repository and ruleset is a GitHub write that needs the user's approval; the review case needs a second account or an approving reviewer.
  - **Observe the states on orkestrator-v2's own PRs in normal use.**
    - Pros: no setup; already gave `DIRTY` and `UNSTABLE`.
    - Cons: `BLOCKED` cannot occur without a required review, and a draft or `CLEAN` open PR may not appear soon.

## Current state

- `evaluatePrMergeReadiness` is the one rule. It needs an open PR, no
  conflicts, merge state `clean`, no failing or pending check in the rollup, a
  merging credential not known to lack push access, and a fresh reading.
- This machine's rows are fresh when the monitor mirror is current and
  `isPrReadingConfirmedByMonitor` holds.
- Another machine's rows are fresh when the machine is connected, its
  summaries are current, and the leaf relays `prMonitorConfirmed`.

## Outstanding work

1. **Live evidence.** Run the throwaway-repository check in task 3 once the
   user approves creating it, including an authenticated lookup inside the
   current image. Status: open (task 3).

## Assumptions and decisions

### Task 1: the recommended hourly cache, keyed by credential scope

Took the recommended option. The cache key is the credential scope plus the
repository, not the repository alone: local environments share the host's `gh`
login (`local-gh`), but each container sources its own runtime credential, so
each container (`container:<id>`) is its own scope. The same split is why
`prMonitorCooldownScope` never shares across containers. A failed lookup is
cached as unknown for ten minutes rather than an hour, so a transient GitHub
error does not hide a real "may not merge" for long, and unknown never blocks.
Only github.com PR URLs are looked up, because Merge itself only accepts them.

### Task 1: the permission check comes last in the rule

`no-merge-permission` is checked after conflicts and failing checks, so the red
conflicts signal and the not-ready reasons a user can act on still show for a
viewer who could not merge anyway.

### Task 1: broad match for permission errors on merge

`isMergePermissionError` matches `HTTP 403` and GitHub's permission wordings.
A false match (for example a 403 rate limit, or a 403 from deleting a
protected branch after a successful merge) only clears one cache entry, which
the next check refills, so breadth costs one request at most.

### Task 2: a separate `environment-pr-health` hint instead of an `environment` change

The recommended option says the leaf emits a summary change when confirmation
flips. Announcing an ordinary `environment` change would also wake every
backend observer of environment changes (preview reconciliation, workflow
wakes, the public API reconciler) for a record that did not change. A new
hint-only resource kind reaches the command node through the same
`resource-changed` stream and revision sequence, and nothing else reacts to it.
Subscribing the command node to the leaf's `pr-monitor-changed` events was also
rejected: those carry the PR URL, which node summaries deliberately keep on the
leaf.

### Task 2: the hint fires on monitor-side input changes, not only on flips

The leaf compares the monitor-side inputs (errors at zero, an answered check,
PR URL, state, conflicts, permission) rather than the final boolean, because
the boolean also depends on the environment record. Persistence and the
monitor's announcement happen at different moments, so a reading can be
unconfirmed for an instant between the two; re-announcing when the monitor
side catches up closes that gap. Uneventful announcements (another error, a new
rollup) do not fire it.

### Task 2: remote rows also show the red conflicts signal

The conflicts colour (#1451) was off for remote rows for the same reason as
ready. With confirmation relayed, the remote sidebar uses
`nodeEnvironmentPrMergeState` for both. Search and the mobile title only ever
showed ready, and still do.

### Task 3: no throwaway repository was created

The brief allows only read-only `gh` calls and no GitHub writes, so the
recommended run was not attempted. The read-only evidence above narrows it to
the `CLEAN`, `BLOCKED` and draft cases and an authenticated in-container lookup.

## Related

- [github-pull-requests.md](../../architecture/github-pull-requests.md#ready-to-merge):
  the rule, the permission cache and the relay.
