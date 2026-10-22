# Container state observation

Checked against `main` at `9906db30` (2026-10-16).

The backend observes state inside containers by running `docker exec` on fixed
timers. The Claude terminal-state poll was one exec per running container per
second, the largest idle cost of containers; on images with the
`claude-state-signal` capability it is now a pushed doorbell plus a 30 s safety
read, and only older images keep the 1 s poll. An open Files panel
on a container pays one status exec per read plus a tree walk every 10–15 s,
because a container worktree has no change signal the way a watched local
worktree does. The aim is to replace fixed-interval execs with a
container-side change signal, keep a slower authoritative safety read, and
lose no exact recovery.

## Current state

- Claude terminal state (inventory item B18), described in
  [container-lifecycle.md](../../architecture/container-lifecycle.md#claude-terminal-state-signal-claude-state-signal2):
  - `ClaudeStatePollManager` in `apps/backend/src/core/tmux-poll.ts`. Its
    `reconcile` (command `reconcile_claude_state_polling`, every 2 s) starts
    a poll for every running environment container, whether or not Claude
    runs in it. Each read uses one `docker exec` to read at most 256 bytes of
    `/tmp/.claude-state-snapshot`, falling back to `/tmp/.claude-state` on
    older images (`claudeStateReadCommand`, 5 s timeout).
  - The file is written by Claude Code hooks that `docker/entrypoint.sh`
    installs (`working`, `waiting`). They fire for Claude started in a
    terminal, not for bridge sessions (`ORKESTRATOR_NATIVE_AGENT_BRIDGE` set).
    On `claude-state-signal=2` images `orkestrator-state-signal` serializes
    writers and atomically persists state, revision and completion counters
    before sending a detached curl POST to the agent tools server. A lost
    working-to-waiting pair is recovered from the completion counter.
  - A poll starts at 1 s. Once per lineage it arms the doorbell
    (`claude-state-signal.ts`: capability check, host alias and service
    port, config written from stdin, one probe ring). A probe ring and a valid
    counter snapshot move it
    to `CLAUDE_STATE_SAFETY_READ_INTERVAL_MS` (30 s); each ring requests one
    coalesced read. A safety read that finds a change no ring announced
    revokes the credential and returns to 1 s. Arming is retried at most every
    `CLAUDE_STATE_SIGNAL_RETRY_MS` (5 min).
  - The manager emits `claude-state-<containerId>` only on change, rechecks
    retirement every `CLAUDE_STATE_RETIREMENT_CHECK_MS` (15 s; in practice
    every safety read), handles stale reads, and probes for an agent-created
    PR only on a turn-ending transition (`probeForAgentCreatedPullRequest`).
  - It is catalogue kind `tmux-poll` in `packages/protocol/src/recurring-work.ts`.
  - Measured in the deterministic harness (`env50-container-c1-pr` against
    `env50-container-c1-pr-signal`): state reads drop from 3,000 to 100 execs
    per minute (60 to 2 per container), all idle execs from 3,296 to 396 per
    minute, and storage stats from 200 to 100. Arming costs about 4 execs per
    container once.
  - Measured live on Docker Desktop 29.8.1 (Apple M5 Pro, 2026-10-16, a
    stock `orkestrator-v2:latest` container with the script copied in): one
    state read takes 42 ms p50 and 55 ms p95 and about 20 ms of host CPU in
    the `docker` CLI (32 MB peak RSS per CLI process), so the 1 s poll costs
    about 2 % of a core per container on the CLI side alone. Daemon and VM
    CPU were not measured. Arming took 310 ms including the probe ring; a
    hook's ring reached the backend within its own `docker exec` (about
    50 ms); a revoked credential was refused; the token appeared in no
    process argv.
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

1. Measure one B18 exec on Linux Engine (latency and backend CPU), and the
   Docker Desktop daemon and VM side, which the live measurement above left
   out. It matters now only for images without the signal.
2. Report Claude state signal health per container (armed, confirmed,
   demoted, unsupported) in recurring diagnostics. Today a demotion is only a
   backend log line, so a container stuck on the 1 s poll is invisible.
3. Add a container worktree change signal so a quiet container's Files-panel
   reads are served from valid state, as watched local worktrees are. It can
   share the Claude state doorbell: a second route, or a kind on the same
   one, issued by `AgentToolsServer` per poll lineage and armed the same way,
   with an in-container watcher in place of the hook. Specify restart and generation
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

- With an image built from this branch, confirm on Docker Desktop and Linux
  Engine that a terminal Claude turn arms and confirms the signal, shows
  working and waiting within budget, and costs 2 state execs per container
  per minute when idle.
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

### Claude state signal decisions (2026-10-16)

- **Transport: the hooks ring an HTTP doorbell on the agent tools server.**
  Alternatives: one long-lived `docker exec` per container streaming changes
  (one blocked `docker` CLI process, about 32 MB, per container on the host,
  all stalled together when Docker Desktop hangs); reporting through a bridge
  (bridges run only for native sessions, never for terminal Claude); a FIFO
  or socket on a mount (named volumes are not host-visible on Desktop, and
  host mounts are being retired). The agent tools server is already reachable
  from containers through the host alias and firewall service-port rule that
  bridges prepare.
- **The doorbell carries no state.** The backend still reads the file, so
  the existing stale-read handling, change-only emits, retirement checks and
  transition-only PR probe are unchanged, and a late or reordered POST cannot
  report an old value. Cost: one exec per transition instead of none.
- **Trust is earned and can be lost.** A poll stays at 1 s until the
  install's probe ring proves the whole path. A safety read that finds a
  change with no ring since the previous read began demotes it to 1 s. A
  ring that lands between that read and the hook's write can cause a false
  demotion; it costs one re-arm, and is rare (one hook-to-ring window per
  transition against a 30 s read).
- **Gating.** Image capability `claude-state-signal=2`, declared by the
  marker in `docker/orkestrator-state-signal.sh`. Legacy and invalid
  manifests keep the 1 s poll for the container's life; an unreadable
  manifest is asked again after the retry window.
- **Credential.** Per poll lineage, random, held only in backend memory,
  scoped to ringing one poll: `/mcp` refuses it and the doorbell refuses MCP
  tokens. Written to a 0600 file from stdin, never on a command line. The
  agent can already write `/tmp/.claude-state`, so ringing grants it nothing
  new. A container that rings more than 30 times in a minute
  (`CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE`; a turn rings twice) is
  demoted and its credential revoked, so a flood never makes the host run
  more reads than the 1 s poll did.
- **Safety read: 30 s.** 60 s would save one exec per minute per container
  but double the worst case for a missed signal. Stale marking after three
  failed reads now takes about 90 s instead of 3 s on a signalled container.
- **No polling limited to terminal Claude.** Not done: the hooks also fire
  for Claude started by hand, so the backend's session list proves nothing,
  and a confirmed container already costs only the safety read. Containers
  that never ran Claude cost 2 reads a minute.
- **Measurement.** Deterministic: the harness scenario
  `env50-container-c1-pr-signal`. Live: the Docker Desktop numbers under
  Current state. Linux Engine and the real built image are under Outstanding
  work and Qualification.

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

- Is the roughly 15 s worst case for Git-invisible changes acceptable against
  the 6 s Files-panel budget, or does it need the signal too?
- Should ad hoc roots key by `realpath`?

## Needs verification

- B18's per-exec cost on Linux Engine, and the Docker Desktop daemon and VM
  share, have not been measured (the Desktop CLI side is under Current state).

## Related

- [0049-native-agent-idle-observation.md](../transcripts-and-observation/0049-native-agent-idle-observation.md) (idle
  observation of bridge sessions),
  [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md)
  (container fetch failure-ladder tuning, app-level fetch qualification),
  [0051-client-reconnect-and-freshness.md](../transcripts-and-observation/0051-client-reconnect-and-freshness.md)
  (`WorktreeSnapshotState.remote` is published but not rendered),
  [0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md)
  (Docker status sampler), [0019-container-platform-qualification.md](0019-container-platform-qualification.md).
- [Event and snapshot recovery](../../architecture/event-snapshot-recovery.md)
  (worktree snapshot revisions).
- [Recurring-work inventory](../../architecture/recurring-work.md#inventory) (B18),
  [latency budgets](../../architecture/recurring-work.md#latency-budgets) and the
  [harness method](../../development/testing-guide.md#recurring-work-harness).
- [Container benchmarks](../../development/container-qualification.md#benchmarks).

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
