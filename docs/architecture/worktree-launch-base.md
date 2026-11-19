# Worktree launch base

A new local environment starts from one exact commit, chosen before the start
and shown to the user. The creation dialog refreshes the project's base branch
while it is open, resolves it to that commit, and sends it with the create
request. The start then creates the worktree from it without fetching first,
so the remote round trip, and its two-minute deadline, are no longer on the
path to a usable environment.

## The flow

1. The create dialog (`CreateEnvironmentDialog`) wants a base whenever it is
   open, Local is selected and the intent is a plain environment (not a
   feature build). `useLaunchBase` then calls `get_project_base_branch_tip`
   (coordinator domain) for the project; each time the base becomes wanted
   again it is read again, never reused from an earlier opening.
2. The backend (`ProjectGitService.baseBranchTip`) fetches the project's
   default branch into `refs/remotes/origin/<branch>`, with a per-branch
   cooldown and in-flight de-duplication, and answers the tip: `branch`,
   `commit`, `ref`, `fetched`, `fetchedAt` (the last successful refresh) and
   `fetchError` when the refresh failed. The checkout itself is never touched.
3. `classifyLaunchBaseTip` (`apps/web/src/lib/launch-base.ts`) turns the tip
   into what the dialog's **Base** row shows (`LaunchBaseRow`):

   | Tip | Shown | Pinned |
   | --- | --- | --- |
   | `origin/<branch>`, refreshed now or within the cooldown | `origin/main @ <commit>`, "fetched …" | yes |
   | `origin/<branch>`, refresh failed | amber, "last fetched … ; the remote could not be refreshed", Retry | yes, labelled as the last-fetched revision |
   | local `<branch>`, no remote | "local branch, no remote" | yes |
   | local `<branch>`, but the remote could not supply it | the reason, Retry | no: the start resolves and reports it, as before |
   | no commit, or the read failed | the reason, Retry | no |

4. On create, a pinned base travels as the create request's
   `delegationBaseBranch` and `delegationBaseCommit` (the same fields a
   coordinator launch and a fork use). A create made while the base is still
   resolving carries no pin.
5. `startEnvironmentOnce` passes `delegationBaseCommit` to
   `createLocalWorktree`. A full commit that exists in the repository is used
   as the start point directly; anything else falls back to
   `resolveRemoteWorktreeStartPoint`, which fetches the base branch first
   ([local-start-git-remote-failures.md](local-start-git-remote-failures.md)).

The whole commit is shown in the dialog, and afterwards in the environment's
settings ("Started from", `EnvironmentStartingCommit`, from
`createdFromCommit` and `delegationBaseBranch`), so the starting point can be
copied and reproduced.

## Scope

- **Local worktrees only.** A container clones the repository inside itself,
  so a pin would not remove a fetch from its path; its base is still resolved
  there. A feature build creates its environment in the backend and is not
  pinned by the dialog either.
- **Requests without a pin are unchanged.** The CLI, scheduled jobs and any
  other caller that omits a base still fetch at start, exactly as before.
- **Other preparation stays where it is.** After `git worktree add`, the
  start writes a few per-worktree Git settings and copies the Environment
  Files and files-to-copy. Those copies are inputs to the setup commands and
  the first agent turn, so they stay before the environment is marked running;
  the Git settings are local and take milliseconds.

## Measuring it

Each local worktree creation writes `[environment] worktree.created` with
`startPoint` (`pinned-commit`, `remote-fetch` or `local-branch`), `resolveMs`
(time spent finding the start point, the fetch included) and `durationMs`
(the whole creation). The entry carries the environment id and timings only,
never paths, branches or commits. Comparing `durationMs` for `pinned-commit`
against `remote-fetch` gives the saving on a given network.

## Related

- [local-start-git-remote-failures.md](local-start-git-remote-failures.md):
  what an unpinned start reports when the fetch fails.
- [version-compatibility.md](version-compatibility.md): `fetchedAt` is a new
  optional result field, so the coordinator domain version is unchanged. An
  older node without it shows the commit as fetched just now when that read
  fetched it, and as last fetched otherwise.
