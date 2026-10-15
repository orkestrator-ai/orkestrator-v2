# Container state observation

Checked against `main` at `2459b05c` (2026-10-15).

The backend observes state inside containers by running `docker exec` on fixed
timers. The Claude terminal-state poll alone is one exec per running container
per second, the largest remaining idle cost of containers. An open Files panel
on a container pays one status exec per read plus a tree walk every 10–15 s,
because a container worktree has no change signal the way a watched local
worktree does. The aim is to replace fixed-interval execs with a
container-side change signal, keep a slower authoritative safety read, and
lose no exact recovery.

## Current state

- Claude terminal state (inventory item B18):
  - `ClaudeStatePollManager` in `apps/backend/src/core/tmux-poll.ts`. Its
    `reconcile` (command `reconcile_claude_state_polling`) starts a poll for
    every running environment container, whether or not Claude runs in it.
  - Every `CLAUDE_STATE_POLL_INTERVAL_MS` (1 s), `claudeStateReadCommand`
    runs `docker exec <id> cat /tmp/.claude-state` with a
    `CLAUDE_STATE_READ_TIMEOUT_MS` (5 s) timeout.
  - The file is written by Claude Code hooks that `docker/entrypoint.sh`
    installs (`working`, `waiting`). They fire for Claude started in a
    terminal, not for bridge sessions (`ORKESTRATOR_NATIVE_AGENT_BRIDGE` set).
  - The manager emits `claude-state-<containerId>` only on change, rechecks
    retirement every `CLAUDE_STATE_RETIREMENT_CHECK_MS` (15 s), handles stale
    reads, and probes for an agent-created PR only on a turn-ending transition
    (`probeForAgentCreatedPullRequest`).
  - It is catalogue kind `tmux-poll` in `packages/protocol/src/recurring-work.ts`.
  - Measured: 60 execs per minute per container in live runs. In the
    deterministic harness it is 3,000 of about 3,300 execs per minute in the
    50-environment container scenario.
- Container Files panel:
  - The client polls every 5 s (`AUTO_REFRESH_INTERVAL` in
    `apps/web/src/hooks/useFilesPanel.ts`).
  - Container reads are bounded by `DIFF_CACHE_MAX_AGE_MS` (3 s,
    `diff-stats-tracking.ts`), so every panel read costs one local-only
    status exec (`buildContainerGitStatusScript`).
  - Tree walks use `CONTAINER_TREE_MAX_AGE_MS` (10 s, `diff-stats-service.ts`)
    only while the container's latest file list is complete, recent and
    successful (`treeMembershipDigest` in `worktree-snapshot-digest.ts`);
    otherwise 3 s. A quiet open panel went from 12 to 4 walks per minute.
  - Unwatched and container diff scans run every `DIFF_POLL_INTERVAL_MS`
    (15 s).
  - Git-invisible membership changes (ignored files, empty directories, paths
    past the untracked cap) can take about 15 s to appear; a manual refresh
    shows them at once.
  - Local worktrees use `startWorktreeWatcher` (`worktree-watcher.ts`) with a
    120 s safety scan (`DIFF_SAFETY_NET_INTERVAL_MS`). Containers have no
    watcher.
  - Ad hoc roots (`AdhocWorktreeReads`, `worktree-adhoc-reads.ts`) have a 3 s
    value cache keyed by `path.resolve`, not `realpath`, so two spellings of
    a symlinked root are separate entries.
- Container fetches: `ContainerGitFetchPolicy` (`container-git-fetch.ts`) owns
  network fetches for status scans (`observe`, `recover`,
  `buildContainerFetchScript`) and is registered with recurring diagnostics
  (`addFetchPolicy`). The exception is `containerRevertFileCommand`
  (`commands-files.ts`, used by `revert_container_file`). It still runs
  `git fetch origin "$branch" >/dev/null 2>&1 || true` inline, then uses
  `origin/<branch>` or, failing that, the local `<branch>` as the revert base.
- Quiescing a container for a rebuild stops its Claude state poll, and a
  replaced container is a new tracking lineage for diff and tree state.

## Outstanding work

### Code

1. Measure the real cost of one B18 exec (latency and backend CPU, Docker
   Desktop against Linux Engine) through the recurring-work recorder before
   designing the replacement.
2. Replace the 1 s Claude state poll with a pushed change signal, and demote
   the poll to a slow safety read. Candidates:
   - the hook that writes `/tmp/.claude-state` also notifies;
   - one long-lived exec per container streams state changes, restarted with
     the runtime's generation.

   Keep stale-read handling, change-only emits, retirement checks and the
   transition-only PR probe.
3. Add a container worktree change signal so a quiet container's Files-panel
   reads are served from valid state, as watched local worktrees are. It can
   share the transport chosen for item 2. Specify restart and generation
   handling (a new runtime generation or boot starts a new lineage), and make
   overflow force a full reconciliation. It must share `DiffStatsService`
   ownership rather than add a second scanner. Gate it on an image capability
   and keep the 3 s, 10 s and 15 s bounds as the fallback for images without
   it.
4. Route `containerRevertFileCommand`'s base resolution through
   `ContainerGitFetchPolicy` (recover when the base is missing), or document
   why it must fetch inline. The resolved revert base must stay the same as
   today.

### Qualification

- In an isolated profile with a container fixture
  (`mise run dev:test --profile <p> --fixture --fixture-environments local,container`),
  record before and after each change: idle execs per container per minute,
  background activity indicator latency (≤ 4 s), turn completion visible
  (≤ 3 s), and Files-panel change-to-visible (≤ 6 s, ≤ 1 s after an explicit
  action). The budgets are p95 targets from the recurring baseline.
- Before adopting a watcher, measure its process and memory cost per
  container against the current walk cost, on Linux Engine and Desktop.
- Regenerate a deterministic reference with the recurring-work harness
  (`apps/backend/scripts/recurring-baseline.ts`) first. The stored step
  artifacts no longer reproduce at this commit.

## Constraints and rationale

- A container-side signal adds lifecycle, authentication and recovery duties.
  Treat it as a measured experiment, not a cadence tweak.
- A longer age bound alone was rejected: with the 5 s panel poll, any bound
  of 5 s or more pushes change-to-visible to about 10 s, over the 6 s budget.
  Fewer execs need a signal, not a longer age.
- Never treat Git index or `HEAD` timestamps as proof that a tree is
  unchanged.
- Every missed event must still surface through the safety read, the age
  bound or a manual refresh. A failed read rejects; it is never cached and
  never shown as an empty tree.
- Never move container Git credentials to the host. Container-owned Git and
  SSH configuration stay outside the host `runRemoteGit` boundary.
- Never share fetch or scan identity across clones, containers or
  credentials. Fetch records are keyed by container generation and clone
  identity.
- A Docker events watcher was rejected for status sampling (see the
  benchmarks decision table). The signal here is about state inside the
  container, not about Docker objects.
- Images without the signal keep working on the current timers.

## Open questions

- Does Claude terminal state need 1 s fidelity, or is the 4 s activity budget
  met by an event plus a slower safety read?
- Which signal transport works in the bundled image and degrades cleanly on
  older images?
- Can polling be limited to containers where Claude runs in a terminal? The
  hooks also fire for Claude started by hand in a plain terminal tab, so the
  backend's own session list is not proof that none runs.
- Is the roughly 15 s worst case for Git-invisible changes acceptable against
  the 6 s Files-panel budget, or does it need the signal too?
- Should ad hoc roots key by `realpath`?

## Needs verification

- B18's per-exec cost on Docker Desktop has not been measured.

## Related

- [native-agent-idle-observation.md](native-agent-idle-observation.md) (idle
  observation of bridge sessions),
  [recurring-work-qualification.md](recurring-work-qualification.md)
  (container fetch failure-ladder tuning, app-level fetch qualification),
  [client-reconnect-and-freshness.md](client-reconnect-and-freshness.md)
  (`WorktreeSnapshotState.remote` is published but not rendered),
  [container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md)
  (Docker status sampler), [container-platform-qualification.md](container-platform-qualification.md).
- [Event and snapshot recovery](../architecture/event-snapshot-recovery.md)
  (worktree snapshot revisions).
- [Recurring-work inventory](../imrovements/recurring-processes.md) (B18) and
  [latency budgets and harness method](../improvements/recurring-processes/baseline/README.md).
- [Container benchmarks](../improvements/containers/benchmarks.md).

## Replaces

- `docs/imrovements/recurring-processes.md` (B18 and the F02 remainder; the
  inventory stays in place)
- `docs/improvements/recurring-processes/plan/04-container-git-fetch-policy.md`
  ("Not done": the inline revert fetch, the per-read container status exec)
- `docs/improvements/recurring-processes/plan/12-qualification-and-rollout.md`
  (B18 as the next measured candidate)
- `docs/improvements/recurring-processes/baseline/README.md` (attribution
  notes on container exec volume; budgets stay in place)
- `docs/improvements/efficiency/plan/18-file-tree-caching.md` (remaining
  limitations: no container watcher, ad hoc `path.resolve` keys)
- `docs/improvements/efficiency/frontend-and-workflows.md` (E12, container
  remainder)
