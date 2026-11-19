# Worktree launch base

A new local environment starts from one exact commit, chosen before the start
and shown to the user. The creation dialog refreshes the project's base branch
while it is open, resolves it to that commit, and sends it with the create
request. When the commit is ready, the start creates the worktree without a
second base fetch. Create can also accept the environment while the refresh is
still pending, so the dialog does not wait for the network.

## The flow

1. The create dialog (`CreateEnvironmentDialog`) wants a base whenever it is
   open, Local is selected and the intent is a plain environment (not a
   feature build). `useLaunchBase` then calls `get_project_base_branch_tip`
   (coordinator domain) for the project. Reopening the dialog, switching
   projects, and changing the backend each invalidate its previous answer.
2. The backend (`ProjectGitService.baseBranchTip`) fetches the project's
   default branch into `refs/remotes/origin/<branch>`, with a per-branch
   cooldown and in-flight deduplication. The fetch leaves `FETCH_HEAD` and
   the working tree alone. Retry bypasses a completed failed attempt inside the
   cooldown and still joins an active fetch. The reported `fetchedAt` names the
   last successful refresh of the returned commit and is omitted if another
   operation moved the tracking ref to a different commit.
3. `classifyLaunchBaseTip` (`apps/web/src/lib/launch-base.ts`) turns the tip
   into what the dialog's **Base** row above Create shows on desktop and
   across the mobile tabs (`LaunchBaseRow`):

   | Tip | Shown | Pinned |
   | --- | --- | --- |
   | `origin/<branch>`, refreshed now or within the cooldown | `origin/main @ <commit>`, "fetched …" | yes |
   | `origin/<branch>`, refresh failed | amber, "last fetched … ; the remote could not be refreshed", Retry | yes, labelled as the last-fetched revision |
   | local `<branch>` in a local-only project without `origin` | "local branch, no remote" | yes |
   | remote-backed project whose origin is missing or whose remote reports the branch missing | the reason, Retry | no |
   | no commit, or the read failed | the reason, Retry | no |

4. Create stores a ready base in `worktreeBaseBranch` and `worktreeBaseCommit`.
   The repository's PR base remains the comparison target for ordinary worktrees.
   If the refresh is pending, Create records the configured default branch and
   the first start joins the active refresh or uses its completed result.
5. `startEnvironmentOnce` persists the resolved pin before worktree creation.
   `createLocalWorktree` uses the commit directly and reports a missing object
   by SHA. If the base is unavailable, the unpinned start resolves the branch
   through [the existing Git start path](local-start-git-remote-failures.md).

The whole commit is shown in the dialog, and afterwards in the environment's
settings ("Started from", `EnvironmentStartingCommit`, from
`createdFromCommit` and `worktreeBaseBranch` or the delegation base branch), so the starting point can be
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
(worktree provisioning). The event is written after the worktree is durably
marked running. `creationToWorktreeReadyMs` measures from the creation
timestamp through that transition, including branch-name allocation. It is
wall-clock elapsed time and includes any delay before starting or retrying
the environment. Use it to compare automatically started worktrees on the
same network. The fields contain no paths, branches or commits.

## Related

- [local-start-git-remote-failures.md](local-start-git-remote-failures.md):
  what an unpinned start reports when the fetch fails.
- [version-compatibility.md](version-compatibility.md): `launchEligible` is
  an optional result field. An older node that omits it uses the unpinned
  start. The exact commit is a critical create argument, so a receiver that
  does not understand it cannot silently launch from a different commit.
