# Container state observation

Checked against `main` at `a5d78cfcd` (2026-10-24).

The backend observes state inside containers by running `docker exec`. Both
of the largest idle costs now have a container-side change signal with a
slower safety read, and images built from this change carry both. Claude
terminal state (`claude-state-signal=2`) is read when its hooks ring, plus a
30 s safety read. The Files panel and diff counts (`container-worktree-signal=1`)
are served from the last scan until an in-container inotify watcher rings,
plus a 60 s safety scan. Both report their health in recurring diagnostics,
and images without them keep the old timers. What remains is evidence this
machine cannot produce: Linux Engine numbers, and a real terminal Claude turn.

## Current state

How both signals work, their constants and failure handling are described in
[container-lifecycle.md](../../architecture/container-lifecycle.md#claude-terminal-state-signal-claude-state-signal2)
and
[container-lifecycle.md](../../architecture/container-lifecycle.md#container-worktree-signal-container-worktree-signal1).
Cadences are in the [recurring-work inventory](../../architecture/recurring-work.md#inventory)
(B03, B04, B18, F02).

- **Claude terminal state (B18).** `ClaudeStatePollManager`
  (`apps/backend/src/core/tmux-poll.ts`) reads `/tmp/.claude-state-snapshot`
  on each ring and every 30 s once the doorbell is confirmed. A container
  where terminal Claude never ran has no state file. That read is now an
  answer (`CLAUDE_STATE_ABSENT_MARKER`), not a failure: before this change
  such a container stayed on the 1 s poll even with a confirmed doorbell
  (60 execs a minute, seen live on 2026-10-24); now it costs 2.
- **Container worktree signal.** `orkestrator-worktree-signal`
  (`docker/orkestrator-worktree-signal.sh`, inotify-tools) rings
  `/worktree-signal` on the agent tools server.
  `ContainerWorktreeSignals` (`container-worktree-signal.ts`) turns rings into
  the same hints a local watcher sends, through
  `DiffStatsService.startContainerWatcher`, so `DiffStatsService` stays the only
  scan owner. The status scan is now read-only (`GIT_OPTIONAL_LOCKS=0`,
  `diff.autoRefreshIndex=false`, stat-only rows filtered by numstat, as in the
  local scan), so a scan never rings for its own index write.
- **Signal health.** `recurringWorkDiagnostics().signals` (the
  `get_recurring_work_diagnostics` command and `/__orkestrator/metrics`) has
  one entry per signal: containers per state (`unarmed`, `arming`, `armed`,
  `confirmed`, `demoted`, `unsupported`), how many run their fallback cadence,
  demotions by reason and accepted rings. It is content-free, so it has no
  container ids; the demotion log line still names the container.
- **Revert base.** `revert_container_file` (`revertContainerFile` in
  `commands-files.ts`) fetches through
  `ContainerGitFetchPolicy.refreshForAction` in the container's admission
  slot, then runs the revert script. The script no longer fetches.
  Resolution is unchanged: `origin/<branch>`, then `<branch>`.
- **Fallback.** Images without `container-worktree-signal`, and lineages that
  are not confirmed or were demoted, keep the 3 s file-list bound, the 3/10 s
  tree bounds and the 15 s scan.

### Evidence (Docker Desktop 29.7.2, Apple M5 Max, 2026-10-24)

Image `orkestrator-v2:dev-8540c28917b1`, built from this branch, declares
`claude-state-signal=2,container-worktree-signal=1` and contains
`inotifywait` 4.23.

| What | Result | Source |
| --- | --- | --- |
| One B18 state read, Docker Desktop VM side | dockerd 9.5–10.8 ms, containerd 5.2–5.7 ms, shim with `runc` and the command 24.7–29.1 ms; whole VM 54–61 ms busy CPU per exec | `container-exec-cost.ts`, 2 runs × 200 execs |
| Same read, host side | `docker` CLI 18.7–19.0 ms CPU p50, 30 MB peak RSS; `com.docker.backend` about 20 ms; wall 46–54 ms p50, 64–83 ms p95 | same |
| So the 1 s poll per container | about 9–10 % of one core (CLI 19 ms + `com.docker.backend` 20 ms + VM guest 54–61 ms per read; hypervisor overhead not separated), now paid only by images without the signal | derived |
| Status scan / tree walk (this repo's HEAD) | 151 / 130 ms VM CPU, 93 / 102 ms wall p50 | same, 50 execs each |
| Watcher on the same workspace | 513 watches, set up in 254 ms, 7 MB RSS for its three processes, 0 s CPU over 30 s idle, about 0.5 MB kernel memory | same, `--watcher` |
| Live watcher, real image | arm to confirmed 0.5–0.85 s; file change to completed scan 0.45–0.47 s; `node_modules` writes ring nothing; a pause and resume leaves one watcher; a killed `inotifywait` demotes (`watcher-lost`) | `container-worktree-signal-docker.test.ts`, 4 runs |
| Live Claude hooks, real image | the entrypoint's hook commands arm, confirm and show `working`/`waiting`; dropped rings recovered by the safety read | `claude-state-signal-docker.test.ts` |
| Real stack, restricted fixture container | both signals `confirmed` through the firewall's service-port rule; a demoted lineage re-armed exactly 5 min later | `wtsig-qa` profile, `/__orkestrator/metrics` |
| Real stack, signal confirmed | idle: Claude reads 2/min, container diff scans 1/min, tree walks 0; Files panel open: plus about 1–2 tree walks/min (the safety tick); change announced in 411–448 ms and visible to a client reading on announcement in 420–469 ms (2 runs × 5) | `container-signal-profile-sample.ts` |
| Real stack, fallback (watcher stopped) | idle: 4 diff scans/min; panel open: about 11 status scans and 6 tree walks a minute; change visible on the client's 5 s poll in 1.0–6.6 s (median 1.6 s); with no reader a change waits for the 15 s scan (9–11 s observed) | same, `--demote` |
| Deterministic, 50 containers, one panel | idle execs 396 → 231 a minute; diff scans 2,080 → 500 and tree walks 40 → 10 per 10 min; every existing scenario identical to `main` | `recurring-baseline.ts`, `env50-container-c1-pr-signal` → `-signals` |

## Outstanding work

### Code

1. ~~Measure one B18 exec on Linux Engine and the Docker Desktop daemon and
   VM side.~~ Docker Desktop's daemon, VM and host-side backend are measured
   (Evidence). **Still open: Linux Engine.** No Linux Engine host is
   available to this node: the only Linux machines reachable over SSH and
   the tailnet are the user's own servers, not test hosts. Run
   `mise exec -- bun apps/backend/scripts/container-exec-cost.ts --image <dev image> --execs 200 --repo . --watcher`
   on a Linux Engine host and add the numbers here. It matters only for
   images without the signals.
2. ~~Report Claude state signal health per container in recurring
   diagnostics.~~ Done: `ClaudeStatePollManager.status()` registered as
   `claude-state-signal`, with `fallback` counting containers on the 1 s poll
   (`tmux-poll-signal.test.ts`, `host-suspend-detector.test.ts`). It found the
   absent-state-file gap described under Current state on its first live run.
3. ~~Add a container worktree change signal.~~ Done
   (`container-worktree-signal.ts`, `container-worktree-signal-install.ts`,
   `docker/orkestrator-worktree-signal.sh`, `DiffStatsService.attachContainerWatcher`).
   Restart and generation handling: one lineage per tracking lineage, replaced
   in the container by the next install. Overflow and every ring force a
   full rescan of both views. The 3 s, 10 s and 15 s bounds stay as the
   fallback. Tests: `container-worktree-signal.test.ts`,
   `diff-stats-container-signal.test.ts`, `container-worktree-signal-install.test.ts`,
   `agent-tools-state-signal.test.ts`, the live Docker test and the harness
   scenario.
4. ~~Route `containerRevertFileCommand`'s base resolution through
   `ContainerGitFetchPolicy`.~~ Done (`refreshForAction`, `revertContainerFile`).
   Real-Git tests show the same base as the old inline fetch: a moved remote
   is fetched and used, an unreachable remote falls back to the local
   `origin/<branch>`, a branch without a remote uses the local branch, and a
   missing ref fails with the same message (`container-git-fetch-git.test.ts`).

### Qualification

- With an image built from this branch, confirm on Docker Desktop and Linux
  Engine that a terminal Claude turn arms and confirms the signal, shows
  working and waiting within budget, and costs 2 state execs per container
  per minute when idle. **Docker Desktop: done except a real `claude` turn.**
  The built image's own hook commands, run in a container, arm, confirm and
  report `working`/`waiting` (live test), and the real stack confirms the
  signal at 2 reads a minute. **Still open:** a real `claude` turn in a
  container terminal (it needs a Claude login and a UI-driven terminal tab:
  CLI sessions run through the bridge, where the hooks deliberately do not
  fire), the ≤ 4 s activity-indicator budget measured from that turn, and all
  of it on Linux Engine.
- In an isolated profile, record before and after each change: idle execs
  per container per minute and Files-panel change-to-visible. **Done on
  Docker Desktop** (Evidence; `container-signal-profile-sample.ts` with and
  without `--demote`). **Still open:** the background activity indicator
  latency (≤ 4 s) and turn completion (≤ 3 s), which need the real Claude
  turn above, and a Linux Engine run.
- Before adopting a watcher, measure its process and memory cost per
  container against the current walk cost. **Done on Docker Desktop**
  (Evidence). **Still open on Linux Engine**, where `max_user_instances` is
  shared per uid with the host user's own tools (see Constraints).
- ~~Regenerate a deterministic reference with the recurring-work harness.~~
  Done: `origin/main` and this branch produce identical counters for every
  existing scenario; the new `env50-container-c1-pr-signals` scenario carries
  the worktree signal (Evidence), and `recurring-baseline.test.ts` pins a
  quiet signalled container to one scan a minute.

## Assumptions and decisions

### Signal health: aggregate counts, not a per-container list (item 2)

- **Options.** (a) Counts per state, a fallback count and demotion reasons in
  recurring diagnostics. (b) A per-container list with container or
  environment ids, in diagnostics or a new command. (c) Log lines only, as
  before.
- **Chosen:** (a).
- **Why.** The diagnostics surface promises to be content-free ("never a key,
  target, path or identifier"). A stuck container shows up as `fallback > 0`
  or `demoted > 0`, and the existing demotion log line names it.
- **Pros:** keeps the surface's contract; cheap; covers both signals with one
  shape. **Cons:** to find *which* container you still read the log.

### Worktree watcher: inotify-tools in the image (item 3)

- **Options.** (a) `inotifywait` driven by a bash loop. (b) A Node or Bun
  script using recursive `fs.watch`. (c) One long-lived `docker exec` per
  container streaming events. (d) A polling `find -newer` loop inside the
  container.
- **Chosen:** (a).
- **Why.** Measured at 7 MB RSS and no idle CPU. A Node or Bun process would
  idle at roughly 30–50 MB, and recursive `fs.watch` on Linux has no
  overflow event. (c) is the transport the Claude signal already rejected (a
  blocked 30 MB host CLI process per container, all stalling together when
  Docker Desktop hangs). (d) spends CPU forever.
- **Pros:** tiny, explicit `Q_OVERFLOW`, follows new directories. **Cons:**
  a new apt package; one inotify instance per container counts against the
  uid's `max_user_instances` (8192 on this Desktop VM; on Linux Engine shared
  with the host user's own tools), and a refusal only drops to the fallback.

### Transport and trust: the Claude doorbell pattern again (item 3)

- **Options.** (a) A second route on the agent tools server with its own
  credential kind. (b) Reuse `/claude-state-signal` with a kind field.
  (c) Ship paths with each ring and rescan per path.
- **Chosen:** (a), with no paths in the ring.
- **Why.** A credential valid on one route only cannot ring the other
  signal. A ring without content cannot make the backend trust a stale or
  forged view: every ring is a full rescan, which also makes an overflow
  free to handle. The reason header can only add work (`ready` confirms,
  `lost` demotes).
- **Pros:** same audit story as the Claude signal; nothing to parse. **Cons:**
  a ring always rescans the whole worktree, not just the touched paths.

### Cost bounds: 300 ms settle, 1 s max wait, 2 s hint gap, 60 s safety scan

- **Options.** Hint gap 0, 2 or 3 s; safety scan 30, 60 or 120 s.
- **Chosen:** the watcher rings at most once a second (300 ms quiet or 1 s
  from a burst's start). Rings become hints at most every 2 s
  (`CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS`). Confirmed containers get a
  60 s safety scan (`CONTAINER_SAFETY_NET_INTERVAL_MS`). More than 120 rings
  a minute demote.
- **Why.** A 2 s gap caps an agent writing constantly at 30 status execs a
  minute while keeping worst-case change-to-visible near 3.3 s, inside the
  6 s budget; measured typical latency is 0.45 s. The safety scan is the
  bound for what the watcher cannot see (`node_modules`, Git's object store)
  and for a watcher killed by the agent or a restart. 120 s matches local
  watchers but doubles that bound; 30 s would halve the idle saving.
- **Pros:** idle drops from 4 to 1 scan a minute, and an open panel from
  about 17 execs a minute to about 2. **Cons:** a busy container can now
  cost up to 30 scans a minute instead of 4 with no panel open (bounded,
  and it buys about 0.5 s badge updates instead of 15 s).

### Missed-change detection with a grace window

- **Options.** (a) Demote on the first safety scan that sees an unannounced
  change, as the Claude signal does. (b) Wait 3 s for a ring before
  demoting. (c) Never demote and rely on the safety scan.
- **Chosen:** (b) (`CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS`).
- **Why.** A file signal settles for up to 1 s in the container, so during
  active editing a safety scan often lands inside a settle window; (a) would
  demote busy containers for 5 minutes for no reason. (c) would hide a dead
  watcher forever.
- **Pros:** a false demotion needs a ring delayed by more than 3 s.
  **Cons:** a real miss is acted on 3 s later; the view itself was already
  corrected by the scan that found it.

### Read-only container status scan

- **Options.** (a) `GIT_OPTIONAL_LOCKS=0` plus `diff.autoRefreshIndex=false`
  and the local scan's numstat filter for stat-only rows. (b) Exclude
  `.git/index` from the watcher. (c) Leave the scan writing the index.
- **Chosen:** (a).
- **Why.** (c) makes every scan ring for its own index refresh. (b) would
  miss real staging changes (`git add` of a new file). (a) matches the local
  scan's documented behaviour, and the filter keeps its output identical.
- **Pros:** no self-ring, and no `index.lock` contention with the agent's own
  Git commands. **Cons:** a stale stat cache is rehashed on every scan until
  the agent's own Git refreshes it. This applies to fallback images too,
  where it is harmless.

### Absent Claude state file is a reading at revision 0

- **Options.** (a) Treat "no file" as a successful observation (revision 0,
  no completions) that emits nothing. (b) Treat it as `idle` and persist it.
  (c) Leave it a failed read.
- **Chosen:** (a).
- **Why.** (c) is the bug the new diagnostics exposed (60 reads a minute per
  container that never ran Claude). (b) would write an activity source for
  every such container. (a) keeps today's stale marking after three reads and
  lets a lost first turn be recovered from the counters.
- **Pros:** 2 reads a minute for every confirmed container. **Cons:** a
  first change after "absent" never counts as a missed ring, so it cannot
  demote. It is still surfaced by the safety read.

### Revert fetch: an explicit inline fetch through the policy (item 4)

- **Options.** (a) Recover only when the base is missing (the base could then
  be up to the fetch cooldown old). (b) Treat a revert like a manual
  refresh: `refreshForAction` invalidates unless an attempt ran in the last
  15 s, then fetches inline. (c) Keep the inline `git fetch` and document
  why.
- **Chosen:** (b).
- **Why.** "The resolved revert base must stay the same as today", and today
  it fetches right before resolving. (b) keeps that within 15 s, gives the
  fetch the policy's identity keying, admission slot, metrics and failure
  classification, and never blocks the revert on a failing fetch, matching
  the old `|| true`.
- **Pros:** one owner for container fetches; the old resolution order is
  proven by real-Git tests. **Cons:** a revert costs an identity probe exec
  when no scan has reported the clone yet, and up to two execs instead of
  one. An explicit invalidation overrides the failure cooldown, as a manual
  refresh does, so a dead remote is retried at most every 15 s of reverts.

### Open questions answered

- **Git-invisible changes (about 15 s).** With the signal they ring like any
  other change, except inside `node_modules`, which the tree skips anyway.
  For fallback images the 15 s worst case stays, accepted: they are the
  degraded path, and a manual refresh shows the change at once.
- **Ad hoc roots by `realpath`.** Not changed. Two spellings of one root are
  two valid cache entries; the cost is at most one extra walk per alias per
  3 s for untracked roots, and tracked environments already share physical
  work through `PhysicalKeyResolver`.

### Assumptions

- Docker Desktop's VM is a fair stand-in for daemon-side costs, but not for
  Linux Engine's host-side CPU accounting; that stays open.
- `/workspace` is the clone root and `node` the workspace owner in every
  image that declares `container-worktree-signal`.
- Evidence uses this repository's HEAD (513 directories) as the workspace. A
  much larger tree costs about 1 KiB of kernel memory per watched directory
  and a longer set-up time; neither was measured beyond that.

## Constraints and rationale

### Claude state signal decisions (2026-10-16)

- **Transport: the hooks ring an HTTP doorbell on the agent tools server.**
  Alternatives: one long-lived `docker exec` per container streaming changes
  (one blocked `docker` CLI process, about 32 MB, per container on the host,
  all stalled together when Docker Desktop hangs); reporting through a bridge
  (bridges run only for native sessions, never for terminal Claude); a FIFO
  or socket on a mount (named volumes are not host-visible on Desktop, and
  host mounts are being retired).
- **The doorbell carries no state.** The backend still reads the file, so a
  late or reordered POST cannot report an old value.
- **Trust is earned and can be lost.** A probe ring confirms the path; a
  safety read that finds a change with no ring since the previous read began
  demotes to 1 s.
- **Gating.** Image capability `claude-state-signal=2`. Legacy and invalid
  manifests keep the 1 s poll for the container's life; an unreadable
  manifest is asked again after the retry window.
- **Credential.** Per poll lineage, random, held only in backend memory,
  written from stdin, never on a command line. More than 30 rings a minute
  demotes, so a flood never costs more than the 1 s poll.
- **Safety read: 30 s.** 60 s would save one exec per minute per container
  but double the worst case for a missed signal.

### General

- A container-side signal adds lifecycle, authentication and recovery duties.
  Both signals were treated as measured experiments, not cadence tweaks.
- A longer age bound alone was rejected: with the 5 s panel poll, any bound
  of 5 s or more pushes change-to-visible to about 10 s, over the 6 s budget.
- Never treat Git index or `HEAD` timestamps as proof that a tree is
  unchanged.
- Every missed event must still surface through the safety read, the age
  bound or a manual refresh. A failed read rejects; it is never cached and
  never shown as an empty tree.
- Never move container Git credentials to the host. Container-owned Git and
  SSH configuration stay outside the host `runRemoteGit` boundary.
- Never share fetch or scan identity across clones, containers or
  credentials.
- A Docker events watcher was rejected for status sampling (see the
  benchmarks decision table). The signals here are about state inside the
  container, not about Docker objects.
- Images without a signal keep working on the old timers.
- inotify instances and watches are counted per uid of the init user
  namespace, so every container's `node` (uid 1000) shares them, and on
  Linux Engine so does the host's own uid 1000. Exhaustion makes
  `inotifywait` exit, which rings `lost` and drops that container to the
  fallback.

## Open questions

None; see "Open questions answered" above.

## Needs verification

- Linux Engine: B18 per-exec cost (latency, CLI, dockerd/containerd/shim
  CPU), the watcher's cost against the walk cost, and both signals on a
  Linux Engine host (`container-exec-cost.ts`,
  `container-signal-profile-sample.ts`, the two live Docker tests).
- A real terminal `claude` turn in a container: arming, `working`/`waiting`
  within the ≤ 4 s activity budget and ≤ 3 s turn-completion budget, on
  Docker Desktop and Linux Engine.

## Related

- [0049-native-agent-idle-observation.md](../transcripts-and-observation/0049-native-agent-idle-observation.md) (idle
  observation of bridge sessions),
  [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md)
  (container fetch failure-ladder tuning, app-level fetch qualification),
  [0051-client-reconnect-and-freshness.md](../transcripts-and-observation/0051-client-reconnect-and-freshness.md)
  (`WorktreeSnapshotState.remote` is rendered on the Files panel's Changes tab;
  its real-browser check is still owed),
  [0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md)
  (Docker status sampler), [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
  (Linux Engine and rootless hosts).
- [Event and snapshot recovery](../../architecture/event-snapshot-recovery.md)
  (worktree snapshot revisions).
- [Recurring-work inventory](../../architecture/recurring-work.md#inventory) (B03, B04, B18, F02),
  [latency budgets](../../architecture/recurring-work.md#latency-budgets) and the
  [harness method](../../development/testing-guide.md#recurring-work-harness).
- [Container benchmarks](../../development/container-qualification.md#benchmarks)
  (the exec-cost and profile-sample scripts).

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
