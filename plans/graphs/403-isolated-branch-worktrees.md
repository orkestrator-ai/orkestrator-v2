---
id: 403
title: "Isolated branch worktrees"
phase: 4
plan: "Phase 4"
status: in-progress
depends_on: [205, 210]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-403-worktrees"
pr: ""
updated: 2026-10-29
---

# 403 · Isolated branch worktrees

- **Plan:** [Phase 4: extensions](../composable-graphs.md#phase-4-extensions)
- **Decisions:** D3
- **Depends on:** [205](205-replication-and-collection.md), [210](210-restart-and-rewind.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Several branches can write code in parallel, for example competing implementations.

## Work

- [x] Write the design note in this file's Notes and get it agreed before building. (Per the user's standing Phase 4 instruction the note is reviewed in the pull request; see Notes.)
- [x] One worktree per replicated writer branch, created from the input snapshot.
- [x] `select` and agent `merge` nodes. (`select` is the `select-workspace` system action; an agent merge is an ordinary builder node over `list<workspace@1>`; see Notes.)
- [x] Worktree lifecycle and cleanup, disk accounting (`docs/development/disk-usage.md`), container environments.
- [x] Update D3 in the plan.
- [x] Compiler diagnostics, guards per worktree, restart/rewind and mock runs for isolated branches.
- [x] Designer: the Isolation choice and the Select branch node; run inspector shows a branch's worktree.

## Tests

- [x] Competing implementations run, one is selected, and the others are cleaned up.
- [x] Container path at unit level (the environment command runner's Docker seam), real Git integration (slow tier), janitor, guards, scheduling, mock run, disk report.

## Done when

- [x] Parallel writers ship, and D3 is updated.

## Notes

**2026-10-29 · Design note (written first, per the user's standing Phase 4
instruction: design, then build, reviewed in the pull request).**

*Problem.* D3 keeps version 1 to one writer per workspace: a replicated node
must be read-only or have no workspace access, so "three competing
implementations, a judge picks one" (report §6.7, §9.3) cannot be drawn.

*Opt-in per node.* An agent node gains `isolation: "worktree"`. The compiler
accepts a replicated writer only with it (`replicated-writer` otherwise), and
refuses it anywhere it means nothing: on a node that is not replicated
(`isolation-not-replicated`), that does not write (`isolation-not-writer`),
without exactly one single `workspace@1` input to start from
(`isolation-unpinned`), or with more than 8 branches
(`isolation-branch-limit`, `GRAPH_ISOLATION_BOUNDS.maxBranches`). For the
workspace rules an isolated writer is a *reader* of the run's workspace (it
must stay unchanged under it), so it may run beside readers and other
isolated writers, never beside a writer of the run's workspace. The plan node
carries `isolation: "worktree"` only when set, so existing plan digests do not
change.

*One worktree per branch.* Each isolated activation (one branch, one
iteration) gets a Git worktree of the environment's repository at
`.orkestrator/graph-branches/<run>/<node>/i<iteration>/<branch>` inside the
environment root, on its own branch
`orkestrator-graph/<run>/<node>/i<iteration>/<branch>` (`:` in a branch key
becomes `_`), created with `git worktree add -B` from the commit its
`workspace@1` input names. The same path works for both environment kinds,
because Git runs at the environment root through the backend's existing
command runner: on the host in the worktree, in a container through
`docker exec -w /workspace` (`createEnvironmentCommandRunner`), so a container
branch lives at `/workspace/.orkestrator/graph-branches/…`. `.orkestrator/` is
already Git-excluded (`ensureWorkspaceArtifactIsGitExcluded`), so the run's
own worktree never sees the branches as changes.

Deviation from the brief, on purpose: local branches are *not* placed in the
environments' worktree folder (`worktreeBaseDir`). Inside the environment root
they are inside the agent's working directory, which is what every provider's
own write sandbox allows (Codex's workspace-write, Claude's sandbox), and the
one relative path works on both kinds. The cost: a tool run at the root that
ignores `.git/info/exclude` (some test runners) can see the branch checkouts
while they exist. They exist only while their activation runs (below).

*Sessions run in the environment's bridge.* Bridges hold one working
directory per process (Claude's `CWD`, Codex's `cwd`, …) and a container
publishes one port per bridge, so a per-branch bridge is not available for
containers at all. The branch's prompt therefore carries a locked system frame
naming its worktree (absolute path, branch, base commit): work, run commands
and commit only there; leave the run's checkout and other branches alone;
never push. Confinement is *guarded*, not enforced (report §6.4 point 3):

- the run's checkout gets the read-only guard (item 209) for the branch's
  whole turn, including the correctable submit-time refusal;
- a new `worktree` guard certifies the branch: its worktree still exists, is
  on its own branch, descends from its base commit and has no uncommitted
  changes (a correctable `worktree_changed` refusal at submit time first);
- the remote-ref guard reads the commits the activation created in its own
  worktree (`base..HEAD` and that worktree's reflog).

Per-session working directories in every bridge would raise this to
provider-enforced; that is bridge work on five providers and stays a
follow-up (Notes, "Follow-up").

*Locks (D3 per worktree).* An admitted isolated activation holds a reader on
the run's workspace and its own worktree as the one writer of it. The
environment-wide lock table also counts live branch worktrees: at most 16 are
admitted at once per environment (`maxLiveWorktreesPerEnvironment`); a branch
over it waits (admission block `worktree-limit`). A branch never needs another
branch's worktree, only its commit, so this cannot deadlock.

*Outputs.* A branch's `workspace@1` output names its own branch, its commit
(read from its worktree after the turn) and its base. `push-branch` and
`open-pull-request` refuse it (they already require the run's branch), so a
branch reaches the remote only through `select` or a merge.

*`select-workspace`.* A system action (not a new node kind: system actions
already have specs, effects, mock support and designer forms). Inputs:
`list<workspace@1>` candidates (fan-in from an isolated node) and the
`decision@1` naming the winner (from a judge agent; a person picks by
putting a human `edit` node on the decision). The choice matches a
candidate's branch key exactly (`sample.2`, `lens.security`), its last part
(`2`, `security`) when that is unique, or its Git branch name. `fallback:
"first"` takes the first successful candidate in branch order when the choice
names none; the default `fail` fails the node. Effect (journaled, once per
slot and commit): with the run's worktree clean, fast-forward the run's branch
to the chosen commit (`git merge --ff-only`). A run branch that moved past the
branches' base is refused (use an agent merge), except when the run branch is
exactly a commit an earlier attempt of the same select put there (a restart
upstream), which is reset with a backup ref. Then every candidate's worktree
and branch is removed. Output: `workspace@1` on the run's branch. Compile:
`select-without-isolated-branches` when its candidates are not fed by an
isolated node.

*Agent `merge`.* No new kind: an ordinary agent node (`builder`, writes the
run's workspace) whose `list<workspace@1>` input receives the branches; the
branches stay reachable by name until the run ends, so it merges them with
Git in the run's checkout and its `workspace@1` output is the merged commit.

*Lifecycle and cleanup.* Worktree *directories* live only while their
activation does: a janitor (`graph-branch-worktrees.ts`) runs under the run's
lock after every saved record and removes the directory of every isolated
activation that is terminal (complete, failed, cancelled, superseded),
unless a newer live attempt of the same position already recorded its own.
Branch *refs* stay until the run ends (consumers merge or select by name),
then the janitor deletes them and prunes. Removal is idempotent; at startup
the janitor sweeps finished runs that still list branches. Environment
deletion removes every branch worktree and ref of the environment's runs
before the worktree or container goes (next to the graph artifact step).
Disk: the directories are inside the environment, so Settings > Disk usage
counts them with it (container: its storage volume); `mise run disk:report`
gets a row for them with an orphan count.

*Restart and rewind (210).* A restarted branch is a new attempt and gets a
fresh worktree from its input commit (the old directory is removed). A code
rewind of an isolated activation is refused: its restart already starts from
its input commit (`graphRunCodeRewindBlocker`).

*Mock runs (213).* No Git: a mock isolated branch answers a `workspace@1` on
its branch name with a fake commit; a mock `select-workspace` picks with the
same choice rule, answers the chosen commit on the run's branch and records
"would have run" (fast-forward, worktrees removed).

*Designer (212).* The capabilities form gets an "Isolation" choice (shared or
a worktree per branch) next to workspace access; `select-workspace` appears
in the palette's system actions with its parameter form from the spec.

*D3.* The D3 row in the plan records that Phase 4 adds isolated per-branch
worktrees for replicated writers, with this date and reason.

**2026-10-29 · What was built (implementation record).**

- *Protocol.* `graphs/isolation.ts` (exported as `@orkestrator/protocol/graphs/isolation`
  and re-exported from `graphs/run`): `GRAPH_ISOLATION_BOUNDS`
  (`maxBranches` 8, `maxLiveWorktreesPerEnvironment` 16),
  `graphBranchWorktreePath`, `graphBranchWorktreeRef`,
  `graphRunBranchWorktreeDirectory`, `graphRunBranchRefPrefix`,
  `parseGraphBranchWorktreePath`, `graphNodeIsolated`,
  `graphMainWorkspaceAccess`, `resolveGraphSelectChoice`,
  `graphBranchWorktreeInstruction`, type `GraphActivationWorktree`.
  `graphs/isolation-template.ts`: `graphCompetingImplementationsTemplate()`.
  Template: `GraphAgentNode.isolation?: "worktree"`
  (`GRAPH_WORKSPACE_ISOLATION`); plan: `GraphPlanAgentNode.isolation` only when
  set. Run record: `NodeActivation.worktree`, guard kind `worktree`
  (`GRAPH_GUARD_LABELS.worktree`). System action `select-workspace` (spec,
  param `fallback: fail|first`, `GRAPH_SELECT_FALLBACKS`, workspace access
  `write`). System contract and `renderGraphNodePrompt` take `worktree`
  (`GraphBranchWorktreeFrame`). `graphRunCodeRewindBlocker` refuses isolated
  activations when given the plan. The describe-a-graph prompt explains
  isolation.
- *Diagnostic codes.* `isolation-not-replicated`, `isolation-not-writer`,
  `isolation-unpinned`, `isolation-branch-limit`,
  `select-without-isolated-branches`; `replicated-writer` now tells the
  author to add isolation.
- *Backend.* `graph-branch-worktrees.ts`: `GraphBranchWorktrees`
  (`create`, `list`, `removeWorktrees`, `deleteBranches`, `removeRun`),
  `GraphBranchWorktreeJanitor` (`wants`, `reconcile`),
  `graphBranchWorktreesToRemove`, `graphBranchAbsolutePath`,
  `graphBranchRoot`, `parseGraphBranchWorktreeList`,
  `removeEnvironmentGraphBranchWorktrees` (called from environment deletion
  in `commands-servers.ts`, after the graph artifact step).
  `graph-system-select.ts`: `selectWorkspaceAction`. Agent executor:
  `branchWorktrees` dependency; worktree made before the baseline;
  `GraphActivationFacts.worktree`; host fills `workspace@1` from the
  worktree. Guards: isolated nodes get the read-only guard on the run's
  checkout plus the `worktree` guard; remote-ref reads the branch's commits.
  Scheduler: `GraphWorkspaceHold.worktrees`, admission block
  `worktree-limit`. Run service: option `branchWorktrees` (the janitor), run
  under the run lock after every saved record and for finished runs at
  discovery. System deps: `branchWorktrees`; `GraphSystemActionContext.inputList`.
  Mock: isolated branches answer on their branch name; mock select picks and
  records "would have run".
- *Web.* Capabilities form "Isolation" select; `PORT_NAMES` for the select's
  ports; designer inspector shows "worktree per branch"; run inspector
  "Worktree" section and "Worktree guard" label.
- *Disk.* `scripts/disk-report.ts` `graphBranchWorktreeRow` (row "isolated
  graph branches"); `docs/development/disk-usage.md` rows;
  `docs/architecture/environment-deletion.md` step 7.

**2026-10-29 · Merged with graphs-integration (402, 208, 213, 214, 404, 405).**
An inlined sub-graph's plan node id holds `/` (`bake/implement`); worktree
paths and branch names write it as `--` (`graphBranchNodeSegment`), one path
segment and a valid ref component, reversible because a graph id never holds
`--`. An isolated node inside a sub-graph compiles and keeps its isolation
(`isolation.test.ts`).

**2026-10-29 · Deviations and limits.**

- Local branch worktrees live inside the environment root, not in
  `worktreeBaseDir` (reason in the design note: provider write sandboxes and
  one relative path for both environment kinds).
- Confinement to the branch's worktree is guarded, not enforced: bridges keep
  one working directory per process. Follow-up: a per-session working
  directory in every bridge (Claude `cwd`, Codex `thread/start` `cwd`, Pi and
  Cursor SDK `cwd`, ACP `session/new` `cwd`) would make it provider-enforced;
  not started here because it is bridge work on five providers with their own
  persistence rules (rollouts keyed by folder).
- A person picks the winner through a human `edit` node on the judge's
  `decision@1`; a human `choose` node's outlets cannot feed `select-workspace`
  directly.
- Branch refs are deleted when the run ends (or by select at once), so a
  losing implementation is reachable only through its `workspace@1`
  artifact's commit until Git prunes unreachable objects.
- Not run: a real-stack check with a live provider in a local or container
  environment (`dev:test` profile). The container path is covered at unit
  level through `createEnvironmentCommandRunner`'s Docker seam, and real Git
  by `graph-branch-worktrees.integration.test.ts` (slow tier).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Design note, then built isolation (protocol, compiler, executor, guards, scheduler locks, `select-workspace`, janitor, deletion, mock, designer, run view, docs, D3); tests in `graph-isolated-branches.test.ts`, `graph-branch-worktrees.test.ts`, `isolation.test.ts`. · complete; awaiting PR
