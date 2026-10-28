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
- The reading is fresh. For this machine: the PR monitor mirror is `current`,
  the backend has answered a check for this exact PR since polling last started
  or resumed (the first answered check is announced once for this), the latest
  check did not fail, both monitor and environment report no conflicts, and the
  environment can be polled (local, or a running container). For
  another machine: readiness is suppressed until summaries relay the leaf's
  current monitor confirmation and error state. Transport freshness alone
  cannot establish PR-reading freshness.

The PR monitor already asks `gh` for `mergeStateStatus,isDraft` in its normal
lookup, so readiness costs no extra GitHub request. It persists the result as
`prMergeability` on the environment, in the viewer's vocabulary above. Storage
clears it whenever `prUrl` changes. Node summaries relay `prState`,
`prHasMergeConflicts` and `prMergeability`, never the PR URL, so a command node
can display a leaf's last persisted PR state.

Known gaps:

- The viewer's permission to merge is not checked. The `gh` lookup does not
  return it, and a repository query on every poll would double the cost.
  Orkestrator merges with the same credential the monitor reads with.
- A leaf's own monitor health is not relayed. Remote sidebar, search and title
  readiness stays off, including for a connected leaf with current summaries.

The effect is the shared `.text-shimmer` utility (`apps/web/src/index.css`) with
the `.merge-ready-name` colours. The name keeps its own colour and the band
passes over it. Under `prefers-reduced-motion` the name holds the band's colour
still and a small merge icon appears. Under forced colours the sweep is removed.
The row's `aria-describedby` reads "Ready to merge", and so does its hover card.
