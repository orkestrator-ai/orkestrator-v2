# Setup approval for local environments

A local environment's `setupLocal` commands come from `orkestrator-ai.json`
in the environment's own worktree, so from whatever branch it was created on,
and they run in the user's login shell (`$SHELL -ilc`) on the host. Without a
check, a branch a container agent pushed, or a stranger's pull request, turns
"contained in Docker" into "runs on the host" (security review finding M5,
[2-26-10-27-security.md](../reports/2-26-10-27-security.md)).

Container environments are not gated: their setup runs inside the container.
Project-home environments never run setup.

## When setup runs without asking

`startEnvironmentSetupAfterPreparation` (`commands-environment.ts`) asks
`evaluateEnvironmentSetupTrust` (`setup-approval.ts`) before spawning a local
setup terminal. The commands run unasked when their list is exactly one of:

1. **The default branch's.** `setupLocal` read from the project checkout at
   `refs/remotes/origin/<defaultBranch>`, else `refs/heads/<defaultBranch>`
   (a `project init` project has no remote). It is read without fetching and
   with `core.fsmonitor` and hooks off. A ref without the file means the
   default branch runs no setup; an unreadable ref or file is no trust source.
2. **A list the user approved for the project on this machine**
   (`storage.setupApprovals`, store `setup-approvals`: one row per project, at
   most 20 hashes, oldest out first, deleted with the project).
3. **The list the user just approved for this run** (`approvedSetupHash`,
   passed by `approve_environment_setup`).

A list is identified by `setupCommandsHash`: SHA-256 of the JSON array, so
order and exact text count. Whoever can push the default branch is trusted by
(1); branch protection is what limits that.

`orkestrator-ai.json` is opened with `O_NOFOLLOW` and must be a regular file
no larger than 256 KiB, so a branch cannot point it at another file.

## A held setup

Otherwise `holdEnvironmentSetupForApproval` records the environment as
`setupPhase: "failed"` with `setupApprovalRequired: true` and a
`lifecycleError` explaining why. Recording it as failed is deliberate: every
reader that waits on setup (agent launch, prompt queues, pull request flows,
the public API's launch result, startup recovery) already stops on `failed`,
and nothing re-runs a failed setup on its own. A retry (`run_environment_setup`)
asks the same question and holds again.

It also:

- closes the preparation session, writing the reason into it;
- marks the environment unread with reason `setup_approval` (attention key
  `setup-approval:<hash>`), which the sidebar toast names;
- mails the coordinator that launched the environment on this node
  (`CoordinatorService.noteWorkerSetupApproval`), telling it the worker is
  blocked until the user decides. A coordinator cannot approve.

The environment stays running and usable; a pending agent launch waits for
setup to complete or be skipped.

## The user's decision

The setup overlay (`SetupPendingOverlay`) shows `SetupApprovalPanel` instead
of "Retry setup" for a held setup. It reads `get_environment_setup_approval`
(the commands, their hash, and the default branch's commands to compare) and
offers:

| Action | Command | Effect |
| --- | --- | --- |
| Run once | `approve_environment_setup` (`remember: false`) | Runs these commands now; nothing is stored |
| Approve for this project | `approve_environment_setup` (`remember: true`) | Stores the hash on this machine, then runs |
| Approve on every machine | `approve_setup_commands_on_nodes` on the command node, then `approve_environment_setup` | Stores the hash on every machine with the project, then runs here |
| Skip setup | `override_environment_setup` | Marks setup ready without running it |

`approve_environment_setup` re-reads the worktree's commands and refuses when
their hash is not the one the user was shown, so a file changed after the
panel loaded is never approved by mistake.

## Several machines

Approvals are per machine: each node owns its own trust and is written only
through its own commands. "Approve on every machine" is shown when the window
has a command node with other machines. The command node finds every copy of
the project by repository identity (`repositoryHint`, as the project file
tools do), including its own, and calls each node's
`approve_project_setup_commands` (`nodes/node-setup-approvals.ts`). It reports
each machine as approved, without the project, not connected, outcome
unknown (connection lost mid-call), or needing an update (an older
Orkestrator without the command). A project without a parseable remote cannot
be matched elsewhere; approve it per machine.

Default-branch trust needs no syncing: each machine reads its own clone, so a
setup change merged to the default branch is trusted everywhere once fetched.

## Who can approve

Only the user. None of the commands has a Control MCP tool or public action,
and the coordinator invoker denies all three, also when wrapped in
`invoke_on_node`. `approve_project_setup_commands` is node-link only (refused
for workspace grants and the relay); `approve_setup_commands_on_nodes` never
leaves the command node. `approve_environment_setup` stays reachable through a
workspace grant, because the user approving in a leaf's workspace view acts
through one.

## Known limits

- A coordinator on a command node that launched the environment on a leaf is
  not mailed: no backend notice travels from a leaf to its command node yet.
  It sees the setup failure in the environment's state.
- Default-branch trust uses the last fetched remote-tracking ref; a stale
  clone may ask about a change that is already merged.
