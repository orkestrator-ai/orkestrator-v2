# E14: Docker logs

This file combines 2 reports into one batch to build together. Same log writer and bounds.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0740](#0740-keep-the-previous-docker-bridge-log-across-a-relaunch) | Medium | R6 and L4: keep the previous Docker bridge log across a relaunch and make it readable. |
| [0850](#0850-bound-docker-log-fallbacks-and-report-dropped-writes) | Low | R10's disk items (L9): the no-perl fallback, dropped-write markers and the driver fallback. |

## 0740: Keep the previous Docker bridge log across a relaunch

### Task analysis

#### Tasks

1. **Stop deleting the log on relaunch**: keep the crashed bridge's log. Status: open.
2. **Make the kept log readable**: retrieval includes it, and clients can call retrieval. Status: open (depends on 1).

#### 1. Stop deleting the log on relaunch

**Problem.** Every relaunch removes the log, so the log that explains a crash is gone exactly when it is needed.

**Context.** Rotated `.1` and `.2` files survive the `rm`, so an active file over 5 MiB leaves partial history and a small one leaves none.

**Investigation.** `rm -f` runs before each start: `commands-containers.ts:850` (OpenCode), `:948` (Claude); `commands-registry-servers.ts:419` (Codex), `:582` (Cursor and Grok), `:717` (Pi). `boundedBackgroundLaunch` (`container-log-bounds.ts`) sends output through `orkestrator-log-writer`, which opens with `O_APPEND` and reads the existing size (`docker/orkestrator-log-writer.sh`), so it would append and rotate correctly if the file stayed. An image without the writer uses `> ${logFile}`, which truncates.

**Decisions.**

- **Move, or just stop removing?**
  - **`mv -f x.log x.prev.log` at all five sites (recommended).**
    - Pros: the report's choice; works on old images too; the previous run is separate, one file, and the new log starts clean, so a startup failure's attached tail reads only the new attempt.
    - Cons: up to 5 MiB more per bridge in `/tmp`; a run of relaunches keeps only the last.
  - **Drop the `rm -f` and let the writer append.**
    - Pros: fewest moving parts; history spans relaunches with a 15 MiB bound.
    - Cons: an image without the writer still truncates; the startup failure tail at `commands-containers.ts:755-760` would mix old output into a new error.

#### 2. Make the kept log readable

**Problem.** Keeping the file does not help if nothing reads it.

**Context.** Report L4 says Cursor and Grok have no retrieval command. They do: `get_${provider}_server_log` (`commands-registry-servers.ts:655`), since `#492`. The gap is that no client calls them.

**Investigation.** `apps/web/src/lib/backend/docker-skills.ts` has getters for OpenCode, Claude and Codex only (`:282`, `:356`, `:372`). A search of `apps/web/src` and `packages/cli/src` finds no caller of the Cursor, Grok or Pi commands. All five commands read only the active file through `boundedTailCommand` and `boundDiagnosticTail`.

**Decisions.**

- **How does retrieval expose the previous log?**
  - **An optional `previous: true` argument on each `get_*_server_log`, using the same bounds and redaction (recommended).**
    - Pros: additive; the same 64 KiB and 200 line limits apply.
    - Cons: every client needs a small change to offer it.
  - **Prefix the previous run's tail to the normal answer.**
    - Pros: every existing caller gets it for free.
    - Cons: doubles the answer and blurs which run a line came from.
- **Add web getters for Cursor, Grok and Pi?**
  - **Yes, with [0780](0750-e15-health-and-diagnostics.md#0780-an-export-diagnostics-bundle) as their first consumer (recommended).**
    - Pros: a diagnostics bundle then covers every bridge.
    - Cons: dead code until that lands.
  - **Leave them backend-only.**
    - Pros: no client change.
    - Cons: the logs stay reachable only by hand-written commands.

### Current state

Bounded tails, retrieval commands for all five bridges, and redaction on the way out exist. The deletion on relaunch is unchanged since the report.

### Constraints and rationale

- The moved file keeps its 0600 mode. Container logs can hold JSON records with bounded fields but also raw output, so retrieval must stay behind `boundDiagnosticTail`.
- A container that has not been rebuilt runs the writer it shipped with; the launch script change applies at the next bridge start, whichever image it is.

## 0850: Bound Docker log fallbacks and report dropped writes

### Task analysis

#### Tasks

1. **Bound the no-perl fallback**: the writer's fallback must rotate or cap. Status: open.
2. **Mark dropped writes**: a failed write or rotation leaves a line saying so. Status: open.
3. **Log driver fallback**: a daemon without the `local` driver must not get an uncapped log. Status: open.

#### 1. Bound the no-perl fallback

**Problem.** The writer's fallback is an unbounded `cat >>`, and so is an image without the writer.

**Context.** The writer's own comment says perl-base is Essential on Debian, "so the image always has it". Impact is therefore limited to a custom image.

**Investigation.** `docker/orkestrator-log-writer.sh:35-40` is the fallback. `boundedBackgroundLaunch` uses a plain `>` when the writer is absent (`apps/backend/src/core/container-log-bounds.ts`, in the `else` branch).

**Decisions.**

- **How to bound it?**
  - **Cap with `head -c` to the writer's max size, then keep draining to `/dev/null` (recommended; the report's first option).**
    - Pros: small shell; the producer never sees a closed pipe.
    - Cons: output past the cap is lost rather than rotated.
  - **A shell loop that checks size per line and rotates.**
    - Pros: behaves like the real writer.
    - Cons: slow and easy to get wrong for a path almost nothing reaches.

#### 2. Mark dropped writes

**Problem.** On a full disk the writer silently drops data, and its size accounting runs ahead of what is on disk.

**Context.** The writer comments describe dropping as deliberate; the gap is that no one can tell it happened.

**Investigation.** In the Perl body, `put` clears `$out` when `sysopen` fails, and a failed `syswrite` closes and retries next time, dropping the rest. `line` adds to `$size` before any write. `rotate` returning 0 drops the line.

**Decisions.**

- **How to mark it?**
  - **Count dropped lines and write `[orkestrator-log-writer] dropped N lines` on the next successful write (recommended).**
    - Pros: the same idea as `entries.dropped` in the host's writer (`application-logging.ts`); no extra I/O while failing.
    - Cons: if the disk never recovers, the marker never appears.
  - **Also add the marker through Docker's own log via stderr.**
    - Pros: visible even with `/tmp` full.
    - Cons: a pipeline launched with `>/dev/null 2>&1` has no stderr to read today, so this needs launch changes.

#### 3. Log driver fallback

**Problem.** When a daemon lacks `local`, no log options are passed, so its default applies, often an uncapped `json-file`.

**Context.** Report: fail loudly, warn once, or pass bounded `json-file`, which every daemon supports.

**Investigation.** `logDriverArguments` returns `[]` when `local` is missing (`apps/backend/src/core/container-resources.ts:211-212`), used at `commands-containers.ts:350` and `:641`. `CONTAINER_LOG_OPTIONS` is 10 MB × 3 (`:204`). An existing container keeps its driver until rebuilt (comment at `:208`).

**Decisions.**

- **Which fallback?**
  - **Pass `json-file` with `max-size` and `max-file` (recommended).**
    - Pros: bounded on every daemon, with nothing for a user to do.
    - Cons: a daemon with another driver by policy (for example `journald`) is overridden for these containers.
  - **Warn once and leave the daemon's default.**
    - Pros: respects daemon policy, as the current comment says.
    - Cons: disk use stays unbounded on the machines at risk.

### Current state

The writer, its rotation and the `local` driver landed in `#877`. Nothing in this recommendation has changed since the report. The environment filter from R10 is in [0830](0720-e13-silent-failures.md#0830-stop-inherited-vendor-debug-variables-reaching-local-bridges), and the relaunch deletion from L9 is in [0740](#0740-keep-the-previous-docker-bridge-log-across-a-relaunch).

### Constraints and rationale

- The writer is part of the image contract (`bounded-logs=1`, `docker/image-manifest.ts`), so a change reaches a container only after a rebuild.
- It must keep draining whatever happens, so a producer never sees a closed pipe.

### Needs verification

- How many real daemons lack the `local` driver is unknown.
- Full-disk behaviour was read from the script, not run.

## Related

- [Logging and database report, R6](../2026-10-29-logging-and-database-efficiency.md#r6-an-always-on-essential-tier-that-closes-the-silent-gaps-l4) and [L4](../2026-10-29-logging-and-database-efficiency.md#l4-silent-failures-too-little-logging-high)
- [0720](0720-e13-silent-failures.md#0720-log-the-failures-that-are-still-silent), [0850](#0850-bound-docker-log-fallbacks-and-report-dropped-writes)
- [Logging and database report, R10](../2026-10-29-logging-and-database-efficiency.md#r10-docker-log-hygiene-l9) and [L9](../2026-10-29-logging-and-database-efficiency.md#l9-docker-container-logging-medium)
- [0022 container resource budgets](../../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md)
