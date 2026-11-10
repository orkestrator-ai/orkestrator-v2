# Idle tab cleanup: five `docker exec` a minute per container environment

## Task analysis

Analysed 2026-11-06 against `main` at `ee2cc8423`. Found by
to-do 1202 (retired 2026-11-10) task 1's idle
before-and-after on macOS: on an idle profile with one container
environment, `main`'s `tab-cleanup` job ran 5 `docker exec`, 1 `tmux` and 1
other process a minute, and read 50–93 KB a minute of command output; on
`0bd214ee` it charged none (Docker's own count on 2026-11-10 shows base ran
the same execs without charging them; see Investigation).

### Tasks

1. **Find what the idle tab cleanup execs, and whether it needs to**: Status: open.

### 1. Find what the idle tab cleanup execs, and whether it needs to

**Problem.** An idle container environment with no tabs costs `main` 5
`docker exec` a minute in `tab-cleanup` alone (300 an hour per environment),
where the 2026-11-01 base cost none. The report's BG-8 was about exactly this
kind of container polling.

**Context.** Measured 2026-11-06 with `scripts/recurring-live-ab.ts
--fixture-environments local,container` (one 6-minute window per side, idle,
no tabs; method in 1202 task 1). `tab-cleanup` covers two jobs in
`apps/backend/src/core/index.ts`: `reconcileTabTeardowns` and
`reconcile_orphaned_tab_resources` (`commands-registry-teardown.ts`), which
reaps orphaned terminal sessions, native sessions and, through
`claude_tmux_reconcile_orphans` (`tmux-commands.ts`), tmux sessions: per
environment one `tmux list-sessions`, in the container through `docker exec`,
and when that fails `confirmTmuxSessionGone`'s further probes. The sweep is
gated to once a minute (`ORPHAN_SWEEP_INTERVAL_MS`, 60 s), on both commits.

| Per minute, idle | `0bd214ee` | `ee2cc8423` |
| --- | --- | --- |
| `tab-cleanup` starts | 2 | 2 |
| `docker-exec` | 0 | 5 |
| `tmux-spawn` | 0 | 1 |
| `process-spawn` | 0 | 1 |
| Command output bytes | 0 | 93,656 |
| Storage reads | 5 | 7 |

The local-only profile showed the same pattern without the container: 1
`tmux` and 0.5–1 other process a minute on `main`, none on base.

**Investigation.** Not traced. The tmux orphan sweep and its 60 s gate are
the same on both commits, so base's zero means either its sweep returned
before listing (for example `loadPaneLayoutsForReconciliation` reporting the
layouts unavailable on a fresh profile) or its execs were not charged to
`tab-cleanup`. Five execs for one container is more than one `list-sessions`
a minute, so something else in the job, or `confirmTmuxSessionGone` on a
container with no tmux server, adds the rest. The output volume (about 94 KB
a minute) is more than an empty `tmux list-sessions` prints; what produces it
was not checked. Since to-do 7020 task 1 (2026-11-09), a census that lists any
tmux process is followed by one more exec, an `sh` probe of `/proc`
(`tmux-socket-owner.ts`), so a measurement after that date can count one more
`process-spawn` or `docker-exec` per unreachable socket.

Counted from Docker on 2026-11-10 (1202 task 1, Linux, `docker events` for
the container during 120 s windows with no tab open): `0bd214ee` made the
same cleanup execs a minute as `main` at `c98b20e6f`, `rm` 2, `tmux
list-sessions` 1, `ps` 1 and `test` 1, but charged none of them to
`tab-cleanup`. So base's zero was the second case above: the execs ran and
were not counted. Whether `main` needs all five is still the open question.

**Decisions.**

- **How to find the execs?**
  - **Run one idle container profile with the backend's command logging at debug for `tab-cleanup`, and count the commands by argv (recommended).**
    - Pros: names each exec directly; no code change.
    - Cons: needs a profile run and a log area that records argv without content.
  - **Bisect `0bd214ee..ee2cc8423` with the idle A/B.**
    - Pros: finds the commit that added them.
    - Cons: about ten profile runs of 10 minutes each.
- **What to do once found?**
  - **Skip environments with no tmux server or no claude-tmux tab history, as the other polls skip stopped environments (recommended, if the execs are the orphan sweep).**
    - Pros: an idle environment with no tmux tabs costs nothing.
    - Cons: a tmux session started outside Orkestrator's knowledge is reaped later.
  - **Leave it.**
    - Pros: no change.
    - Cons: 300 execs an hour per idle container environment.

## Related

- to-do 1202 task 1 (retired 2026-11-10) (the measurement) and task 8 (BG-1, BG-2, BG-8).

## Replaces

- Number 7530, renumbered on 2026-11-06. 7530 (#1960, closed and deleted 2026-11-10) merged first and kept it.
