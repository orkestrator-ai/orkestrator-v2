# The "ready to merge" shimmer does not check merge permission or a leaf's monitor health

An environment's name shimmers while its pull request is ready to merge
(`evaluatePrMergeReadiness`, `packages/protocol/src/pr-merge-readiness.ts`; see
[github-pull-requests.md](../../architecture/github-pull-requests.md#ready-to-merge)).
Viewer permission is not polled, and leaf monitor health is not relayed.
Remote readiness is suppressed until monitor health can be confirmed.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

The feature landed in `917600f2e` (#1404). No later commit touches it. The
safe half of item 2 (remote readiness switched off) is done and is not
repeated as a task.

### Tasks

1. **Viewer permission**: the shimmer can show for a credential that may not merge. Status: open.
2. **Relay a leaf's monitor health**: let a command node show readiness for another machine's rows again. Status: open (remote readiness safely suppressed meanwhile).
3. **Live evidence**: confirm the `mergeStateStatus` mapping against real GitHub, and that the container image's `gh` accepts the fields. Status: open.

### 1. Viewer permission

**Problem.** A read-only credential sees the shimmer, then gets an error from Merge. The rule does not ask whether the viewer may merge (`pr-merge-readiness.ts:27-30`).

**Context.** The PR monitor's lookup is `gh pr view <url> --json url,state,mergeable,mergeStateStatus,isDraft,…` or `gh pr list --head … --json …` (`apps/backend/src/core/commands-pr-monitor.ts:92-133`). An open PR is polled every 20 s (`apps/backend/src/core/pr-monitor-policy.ts:24`). Merge runs with the same credential the monitor reads with: host `gh api` in the worktree for local environments (`mergePullRequestViaGitHubApi`, `commands-review.ts:1140`, `createLocalGhRunner`), `gh` inside the container otherwise (`mergePullRequestInContainer`, `commands-review.ts:1178`). That credential normally pushed the branch.

**Investigation.** `gh` 2.102.0's JSON field list for `pr view` has no viewer or permission field, so the claim holds. The PR viewer already derives write access from REST `GET /repos/{owner}/{repo}` `permissions` (`admin`, `maintain` or `push`) in `loadViewerIdentity` (`apps/backend/src/core/github-pull-requests.ts:354-380`), but with the Settings credential and REST client, not the monitor's runner.

**Decisions.**

- **How to learn whether the merging credential may merge?**
  - **A per-repository cache, filled through the environment's own `gh` runner (`gh api repos/{owner}/{repo} --jq .permissions`), refreshed at most hourly and cleared when a merge fails with a permission error (recommended).** Readiness treats "no push, maintain or admin" as not ready, with a new reason; an unknown permission does not block, since that would hide the shimmer whenever the cache is cold.
    - Pros: at most one extra request per repository per hour; checks the credential that will merge.
    - Cons: new cached state and a new not-ready reason; a revoked permission shows the shimmer for up to an hour; push access still does not prove a ruleset lets this user merge.
  - **Ask on every poll.**
    - Pros: always current.
    - Cons: one more GitHub query per environment every 20 s, the cost the file rejected.
  - **Accept the gap and keep the documented caveat.**
    - Pros: no code; the merging credential pushed the branch in nearly every real case.
    - Cons: a read-only credential (for example a token a user shares with a reviewer) still shimmers.

### 2. Relay a leaf's monitor health

**Problem.** A command node receives a leaf's persisted PR reading but not whether the leaf's monitor is current, so it cannot tell a healthy leaf from one whose `gh` keeps failing.

**Context.** Node summaries carry `prState`, `prHasMergeConflicts` and `prMergeability` (`packages/protocol/src/node-summaries.ts:80-87`, filled by `toNodeEnvironmentSummary` at `:242-246`). The leaf's health is in-memory monitor state: `consecutiveErrors` and `lastSuccessfulCheckAt` (`apps/backend/src/core/pr-monitor.ts:228` and `:263`). `pause` clears the confirmation so a resume must earn a new one (`pr-monitor.ts:533-545`). This machine's rows use that state (`isLocalEnvironmentReadyToMerge`, `apps/web/src/lib/pr-merge-readiness.ts:34-55`).

**Investigation.** Remote readiness is off: `isNodeEnvironmentReadyToMerge` returns `false` (`apps/web/src/lib/pr-merge-readiness.ts:63-68`), used by the remote sidebar (`RemoteMachineTree.tsx:765`), search (`apps/web/src/lib/project-search.ts:231`) and the title (`AppShell.tsx:110`). The file's requirements for a relay still stand: confirmation tied to the leaf's current monitor lifetime, cleared on pause or detection failure, and reconciled after missed events.

**Decisions.**

- **What to relay?**
  - **One leaf-computed boolean per environment, for example `prMonitorConfirmed`: true only while the leaf's monitor has answered a check for this PR in its current lifetime and the latest check did not fail (recommended).** The leaf emits a summary change when it flips. The command node also requires the node's summaries to be current, and treats an absent field (older leaf) as false.
    - Pros: the leaf applies the same rule as its own rows; no clock comparison across machines; a reconnect re-read reconciles missed events.
    - Cons: summaries are built from persisted environment records, so the builder must join in runtime monitor state; one more summary event source.
  - **Relay the raw fields (`consecutiveErrors`, `lastSuccessfulCheckAt`, a monitor-lifetime id) and decide on the command node.**
    - Pros: the command node could show richer detail later.
    - Cons: duplicates the leaf's rule; timestamps from another clock; more protocol surface.
  - **Keep remote readiness off for good.**
    - Pros: no work; never wrong.
    - Cons: other machines' rows never shimmer, so the feature is local-only.

### 3. Live evidence

**Problem.** The `mergeStateStatus` mapping (`mergeabilityFromMergeStateStatus`, `pr-merge-readiness.ts:58-81`) is tested only with fixtures.

**Context.** The cases to confirm: `CLEAN` for a mergeable PR, `BLOCKED` with a required review outstanding, `UNSTABLE` with a failing non-required check, and `DRAFT` or `isDraft` for a draft. An unknown JSON field makes the whole `gh` lookup fail, so the container image's `gh` must accept `mergeStateStatus` and `isDraft`.

**Investigation.** Host `gh` 2.102.0 lists both fields. The image installs `gh` from Debian's apt (`docker/Dockerfile:86`), unpinned, so its version follows the base image's Debian release; it was not checked here, because that needs a container run.

**Decisions.**

- **What run counts as a pass?**
  - **A throwaway private repository with a ruleset that requires one review and one status check, and four PRs (clean, review outstanding, failing non-required check, draft), read with the exact monitor lookup on the host and inside the current image (recommended).** Pass: the four expected values, and the image's lookup exits 0.
    - Pros: covers every mapped state and the image in one sitting; no risk to real repositories.
    - Cons: needs a second GitHub account or an approving reviewer setup for the review case; GitHub rulesets need a plan that supports them on private repositories, or a public repository.
  - **Observe the states on orkestrator-v2's own PRs in normal use.**
    - Pros: no setup.
    - Cons: slow and incomplete; a draft or `UNSTABLE` case may not occur.

## Current state

- `evaluatePrMergeReadiness` (`packages/protocol/src/pr-merge-readiness.ts:110`)
  is the one rule. It needs an open PR, no conflicts, merge state `clean`, no
  failing or pending check in the rollup, and a fresh reading.
- This machine's rows are fresh only when the monitor mirror is current, the
  monitor answered a check for this PR since polling last started or resumed,
  the latest check did not fail, and the environment can be polled.
- Another machine's rows never shimmer (task 2).

## Outstanding work

1. **Viewer permission.** The PR monitor's `gh pr view/list --json` lookup does
   not return whether the credential may merge, and nothing else polls it.
   Fetching it (`gh repo view --json viewerPermission`, or REST
   `permissions.push`) on every poll would add one repository query per
   environment every 20 s. A per-repository cache that is refreshed rarely would
   avoid that. Until then a read-only credential sees the shimmer and then gets
   an error from Merge. Orkestrator merges with the same credential the monitor
   reads with, which normally pushed the branch. Status: open (task 1).
2. **A leaf's monitor errors.** A command node receives another machine's
   persisted reading (`prMergeability`,
   `prState`, `hasMergeConflicts` in its node summary). The leaf's
   `consecutiveErrors` and its first-answered-check state are not relayed, so a
   leaf whose `gh` keeps failing cannot be distinguished from a healthy leaf.
   Remote sidebar, search and title readiness is now suppressed until monitor
   health is relayed. This machine's rows require confirmation since the latest
   start/resume and no monitor errors or conflicts. A future relay must tie
   confirmation to the leaf's current monitor lifetime, invalidate it on pause
   or detection failure, and reconcile missed events. Status: readiness safely
   suppressed; health relay open (task 2).
3. **Live evidence.** Confirm against real GitHub that `mergeStateStatus` is
   `CLEAN` for a mergeable PR, `BLOCKED` with a required review outstanding,
   `UNSTABLE` with a failing non-required check, and `DRAFT` or `isDraft` for a
   draft. Also confirm the container image's `gh` accepts the two fields: an
   unknown field makes the whole lookup fail. Status: open (task 3).

## Related

- [github-pull-requests.md](../../architecture/github-pull-requests.md#ready-to-merge):
  the rule and its known gaps.
