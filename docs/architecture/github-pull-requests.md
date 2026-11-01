# GitHub pull request viewer (backend)

Status: Living — `apps/backend/src/core/github-pull-requests.ts`,
`apps/backend/src/core/github-pull-request-files.ts`,
`apps/backend/src/core/github-pull-request-timeline.ts`,
`apps/backend/src/core/github-pull-request-actions.ts`,
`apps/backend/src/core/github-graphql.ts`,
`apps/backend/src/core/commands-registry-github-pull-requests.ts`,
`packages/protocol/src/github-pull-requests.ts`.

The in-app pull request viewer reads and changes pull requests through the
GitHub REST and GraphQL APIs directly from the backend. It does not run `gh`
and does not need a container, so it works the same for worktree, project-home
and container environments, and for pull requests outside the current project.

## Credential

Every command uses the GitHub credential selected in Settings
(`resolveGitHubToken` in `github-credentials.ts`): the host `gh auth login`
token by default, or the stored personal access token when host credentials
are off. `requireGitHubToken` (in `commands-validation.ts`) and
`requireGitHubProject` share the "GitHub is not configured" message. Errors
pass through `sanitizeGitHubError` with the token, and nothing logs tokens,
PR bodies, comments or file contents.

## Commands

All commands except the list address a pull request by `{ owner, repo,
number }`, validated with `isGitHubPullRequestRef` (owner/repo of `.` or `..`
are refused) and `assertOnlyKeys`. Argument shapes match
`apps/web/src/lib/backend/github-pull-requests.ts`.

| Command | API |
| --- | --- |
| `list_github_pull_requests { projectId, filter, query? }` | One GraphQL `search(type: ISSUE)` for the project's repository, `sort:updated-desc`, first 100. Filters: `open` → `is:open`; `closed` → `is:closed`; `mine` → `is:open author:@me`; `review-requested` → `is:open review-requested:@me`. Free text is appended; `repo:`/`org:`/`user:`/`owner:`/`sort:` tokens are dropped and results from other repositories are filtered out. `hasMore` comes from `issueCount`. |
| `get_github_pull_request` | REST `/pulls/{n}`, `/pulls/{n}/reviews`, `/issues/{n}/comments`, `/repos/{o}/{r}`, `/user`, then `/commits/{sha}/check-runs` and `/commits/{sha}/status` for the head commit, all in parallel. |
| `get_github_pull_request_timeline` | REST `/issues/{n}/timeline` (capped at 500 items → `truncated`), plus `/pulls/{n}/commits` for commit authors and `/pulls/{n}/comments` for per-review inline comment counts. A synthetic `opened` event is first. |
| `get_github_pull_request_files` | REST `/pulls/{n}/files` (GitHub stops at 3000 files → `truncated`) plus one paged GraphQL query for `viewerViewedState` per path and every review thread. |
| `merge_github_pull_request` | REST `PUT /pulls/{n}/merge` (`sha` = `expectedHeadSha`), then `DELETE /git/refs/heads/{ref}` when asked and the head is in the same repository. |
| `update_github_pull_request_state` | `close`/`reopen`: REST `PATCH /pulls/{n}`; `ready-for-review`/`convert-to-draft`: GraphQL mutations with the PR node id. Returns the re-fetched detail. |
| `add_/update_github_pull_request_comment` | REST issue comments; an edit checks the comment's `issue_url` belongs to this PR and that the viewer authored it or has write access. |
| `submit_github_pull_request_review` | REST `POST /pulls/{n}/reviews` with inline comments (`start_line`/`start_side` for ranges). |
| `add_github_pull_request_review_comment` | REST `POST /pulls/{n}/comments`. |
| `reply_github_pull_request_review_thread`, `set_github_pull_request_thread_resolved` | GraphQL `addPullRequestReviewThreadReply`, `resolveReviewThread`/`unresolveReviewThread`, after a `node(id:)` check that the thread is on this PR. |
| `set_github_pull_request_file_viewed` | GraphQL `markFileAsViewed`/`unmarkFileAsViewed`. |
| `set_github_pull_request_reviewers` | REST `DELETE` then `POST /pulls/{n}/requested_reviewers`; `org/slug` entries are teams and must belong to the repository owner. Returns the re-fetched detail. |
| `set_github_pull_request_labels` | REST `PUT /issues/{n}/labels`. |
| `list_github_repository_assignable_users`, `list_github_repository_labels` | REST `/assignees` (cap 300) and `/labels` (cap 1000). |

GraphQL is used only where REST has no equivalent: search with head/base refs
and check rollups in one request, viewed state, review threads, draft
toggles, thread replies and resolution. `githubGraphql` turns the `errors`
array of an HTTP 200 into a `GitHubApiError` with a REST-style code.

## Mapping rules

- **Reviewers.** Reviews are read oldest first. A user's state is their latest
  approval, change request or dismissal; otherwise `commented`, or `pending`
  for an unsubmitted review. The PR author is skipped. Users and teams still
  in `requested_reviewers`/`requested_teams` have `requested: true`.
- **Checks.** Check runs and legacy statuses are merged one per name (check
  runs win). The rollup is `failure` if any check failed, timed out, was
  cancelled or needs action; then `pending`, `success`, `neutral`, or `none`.
  A token that cannot read checks yields an empty list, not an error.
- **Mergeability.** `mergeable_state` maps directly (`has_hooks` → `clean`,
  missing → `unknown`); closed, merged and draft PRs are `unavailable`.
- **Files.** GitHub's bare-hunk `patch` is parsed with `parseUnifiedPatch`.
  A file is `patchAvailable: false` when GitHub omits the patch (binary or
  too large), when it renders more than 3000 rows, or once the response has
  used 40 000 rows. Pure renames and copies with no changes are available
  with no hunks.

## Conditional-request cache

The viewer polls the visible pull request about once a minute. REST GETs used
by detail, timeline, repository lists and the PR record go through a bounded
LRU cache of ETag plus parsed body (200 entries, 16 MB, 1 MB per entry). A
revalidation sends `If-None-Match`; a 304, which GitHub does not count against
the rate limit, returns the cached body. Keys are a SHA-256 of the token and
URL, so the raw token is never stored. File pages and GraphQL requests are not
cached. `resetGitHubPullRequestCache()` clears it, and every function accepts
`{ fetchImpl, cache }` so tests inject their own.

## Environments

After a merge, close or reopen from the viewer, the backend asks the PR
monitor (`requestPrMonitorRefresh`) to re-check every environment whose stored
`prUrl` is the same pull request. This is detached and best effort; it never
delays or fails the GitHub action.

## The Resolve button

The action bar's Resolve button, its configure dialog and the `⌘⇧U` shortcut all
call `launch_native_agent_job` with `tabReuse`. The backend, not the renderer,
chooses the tab (`native-agent-job-tab-reuse.ts`), because it owns the layout, the
session and the queue:

- A Resolve tab is one whose job recorded the completion action. Every job launch
  with a `completionAction` writes it to the tab as `jobCompletionAction`. A title
  is not evidence: tabs can be renamed, and any tab can be called "Resolve".
- Of several, the session updated last is the one considered. If it cannot take a
  prompt, the button opens a new tab; it does not fall back to an older one.
- An idle tab gets the prompt straight away, under the same exactly-once dispatch
  as a new launch. A provider refusal opens a new tab. An `unknown` outcome does
  not, because the prompt may be running.
- A running or blocked tab, or one with prompts already waiting, gets it through
  the durable prompt queue, so it runs when that work ends and overtakes nothing.
  It never steers or interrupts. A second plain press adds nothing while an
  identical prompt still waits. A draft in that tab's composer holds the queue, as
  it does for any queued prompt.
- `NativeAgentService.promptReadiness` answers `unavailable` for a missing
  session, a tab being closed, a parked dispatch or queue, and a failed provider
  session. All of them open a new tab.
- A plain press (`any-agent`) keeps the tab's own agent and model. The dialog
  (`same-agent`) only reuses a tab on the agent it chose, and sends its model,
  reasoning and speed with the prompt, as the composer's picker does. A different
  agent opens a new tab, because a conversation cannot change provider.
- The tab limit stops Resolve only when no Resolve tab is open. If the open one
  turns out unusable on a full tab bar, the new tab is refused with the limit error.

The PR refresh needs nothing specific to reuse. Arming is per environment and
stays armed while GitHub reports conflicts, and an accepted dispatch records
`working`, so the turn that follows has its own completion edge whether it came
from a new tab, a resend or the queue. A queued prompt can run after the turn
before it already cleared the conflicts. That disarms the refresh, and only the
regular PR poll sees the extra turn, which is fine because there is no stale
conflict state left to clear.

`pr.resolve` and `resolve_conflicts` do not pass `tabReuse`: their receipt names a
new tab and a run, so they always open one. They still record the marker, so the
button can reuse a tab they opened. Tabs opened before the marker existed have
none, so the next press opens one more tab and reuses that from then on.

## Ready to merge

An environment whose pull request waits only for the user to merge it has a
shimmering name in this machine's sidebar row, search results, and the mobile
title, which is the only title that names the
environment. The desktop title bar names only the project, so it has nothing
to shimmer. One rule decides "ready" for every surface:
`evaluatePrMergeReadiness` in `packages/protocol/src/pr-merge-readiness.ts`.

Ready means all of:

- The PR is `open`, and `mergeable` reported no conflicts.
- GitHub's merge state is `clean` (`mergeStateStatus` `CLEAN` or `HAS_HOOKS`,
  not a draft). GitHub derives it from branch protection, so it already covers
  required reviews, required checks and an up-to-date base. `unstable` (a
  non-required check failing or still running) is not ready.
- If the monitor has a check rollup, nothing in it is failing or pending.
- The credential Orkestrator merges with is not known to lack push, maintain
  or admin on the repository (`viewerCanMerge`, below). An unknown permission
  does not block.
- The reading is fresh. For this machine: the PR monitor mirror is `current`,
  the backend has answered a check for this exact PR since polling last started
  or resumed (the first answered check is announced once for this), the latest
  check did not fail, both monitor and environment report no conflicts, and the
  environment can be polled (local, or a running container). The monitor half
  of that is `isPrReadingConfirmedByMonitor`. For another machine: the machine
  is connected, its summaries are `current`, and the summary carries
  `prMonitorConfirmed`, which the leaf computes with the same
  `isPrReadingConfirmedByMonitor` against its own monitor. Transport freshness
  alone cannot establish PR-reading freshness, so a leaf that predates the
  field never shimmers on a command node.

The PR monitor already asks `gh` for `mergeStateStatus,isDraft` in its normal
lookup, so readiness costs no extra GitHub request. It persists the result as
`prMergeability` on the environment, in the viewer's vocabulary above. Storage
clears it whenever `prUrl` changes. Node summaries relay `prState`,
`prHasMergeConflicts` and `prMergeability`, never the PR URL, so a command node
can display a leaf's last persisted PR state.

### Merge permission

The `gh pr view/list --json` lookup has no viewer permission field, so the
monitor asks `gh api --hostname github.com repos/{owner}/{repo} --jq
.permissions` through the environment's own runner (host `gh` in the worktree,
or `gh` inside the container), the credential Merge uses. "May merge" is push,
maintain or admin, as in `loadViewerIdentity`. `PrViewerPermissionCache`
(`apps/backend/src/core/pr-viewer-permission.ts`) keeps one answer per
credential scope (the host login, or one container) and repository for an hour,
so an open PR costs at most one extra request per repository per hour. A failed
lookup is unknown and is retried after ten minutes. A merge that fails with a
permission-shaped error (`HTTP 403`, "does not have the correct permissions")
clears that entry, so the next check asks again. The answer is runtime monitor
state (`viewerCanMerge` on the monitor entry), not persisted.

Push access does not prove a ruleset lets this user merge, and a revoked
permission keeps the shimmer for up to an hour.

### Relayed monitor health

`get_environment_snapshots` with `includePrMonitorHealth: true`
(`NODE_SUMMARY_ENVIRONMENT_READ_ARGS`, sent by the command node's summary
reads) adds `prMonitorConfirmed` and `prViewerCanMerge` to each environment
from the node's announced monitor state. That form is never answered
`unchanged`, because the environment manifest revision does not cover runtime
state. When the monitor-side inputs change (first answered check, a failing
check, recovery, a different PR, conflicts, permission, removal) the node
announces a content-free `environment-pr-health` resource change for the
environment and its project; the command node re-reads that project's
summaries. Inputs on the environment record announce themselves when written.
Reconnects and the 60 s summary reconcile cover a missed hint. The PR URL
never leaves the node.

With confirmation relayed, another machine's rows show both the green ready
and the red conflicts signal in the remote sidebar; search and the mobile
title show ready.

### Name shimmer colours

The same names shimmer in one of three colours, chosen by
`environmentNameSignal` (`apps/web/src/lib/environment-name-signal.ts`):

- **Yellow** (`.needs-answer-name`): the agent is `waiting` on the user, the
  state that also pulses the row's status marker yellow. It outranks both pull
  request colours, because the agent stays blocked until answered. Remote
  sidebar rows show it from the leaf's live relayed activity.
- **Red** (`.merge-conflicts-name`): `evaluatePrMergeReadiness` reports
  `conflicts`. Freshness is the same as for ready, except that monitor and
  environment must both report conflicts, so a stale reading shows no red.
  Another machine's rows show it once the leaf confirms the reading.
- **Green** (`.merge-ready-name`): ready to merge, as above.

The effect is the shared `.text-shimmer` utility (`apps/web/src/index.css`)
with each signal's colours (`EnvironmentNameShimmer`). The name keeps its own
colour and the band passes over it. Under `prefers-reduced-motion` the name
holds the band's colour still and a small icon appears (merge, merge conflict,
or question). Under forced colours the sweep is removed. The row's
`aria-describedby` reads "Ready to merge", "Merge conflicts to resolve" or
"Waiting for your answer", and so does its hover card.

## Auto-merge

The **Auto-merge** toggle in the action bar's PR section (shown while the PR is
open) sets the environment's durable `autoMerge` flag through
`set_environment_auto_merge`. While the flag is on, the sidebar row shows a
white merge icon to the right of the environment name. Turning it off stores an
explicit `false`, because renderers merge environment records field by field.

The merging is done by the backend, not the renderer, so it keeps working with
no window open and resumes after a restart. `PrAutoMergeController`
(`apps/backend/src/core/pr-auto-merge.ts`) subscribes to the PR monitor's
in-process events and re-evaluates an environment on each announced reading,
and once more when the toggle is switched on (after asking the monitor for a
fresh check). `decideAutoMerge` uses `evaluatePrMergeReadiness` with the same
freshness rule as the green shimmer (`isPrReadingConfirmedByMonitor`):

- **Ready**: it runs `merge_environment_pr` exactly as the Merge PR button does
  (squash, delete the branch, no environment cleanup).
- **Conflicts**: it launches the Resolve agent through `launch_native_agent_job`
  with the `resolve` action default, the PR's base branch, and the
  `refresh-pr-after-agent-completion` completion action, without taking focus.
  That action arms `prRecheckAfterAgentCompletionArmedAt`, which the monitor
  clears only once GitHub stops reporting conflicts. While it is armed no
  second Resolve is launched, so a manual Resolve also counts, and a Resolve
  that finishes with conflicts still present is left for the user rather than
  relaunched.
- **Anything else** (stale, mergeability unknown, draft, blocked, behind,
  no merge permission, and checks pending or failing when checks are
  required): it waits for the next reading.

Settings → Version control → Auto-merge → **Require checks to pass**
(`global.autoMergeRequireChecks`, on when absent) decides whether checks
GitHub does not require hold a merge back. Off, `decideAutoMerge` passes
`requireChecks: false` to `evaluatePrMergeReadiness`, so an `unstable` PR and a
failing or pending check rollup count as ready and the PR merges as soon as
GitHub allows it. On, it uses the shimmer's rule unchanged. Checks required by
branch protection always block, because GitHub reports them as `blocked`. The
setting is per machine and is read on every decision, so a change applies at
the next monitor reading. The shimmer is unaffected and still stops on any
failing check.

A failed merge or launch is retried after 60 s, doubling up to 15 minutes. A
successful attempt also holds the same PR for 60 s, because a merge GitHub has
accepted but not completed still reads as open and clean. Coordinators cannot
call `set_environment_auto_merge`, as they cannot call `merge_environment_pr`.
