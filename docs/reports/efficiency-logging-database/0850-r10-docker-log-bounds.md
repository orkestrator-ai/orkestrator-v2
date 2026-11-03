# Bound Docker log fallbacks and report dropped writes

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Bound the no-perl fallback**: the writer's fallback must rotate or cap. Status: open.
2. **Mark dropped writes**: a failed write or rotation leaves a line saying so. Status: open.
3. **Log driver fallback**: a daemon without the `local` driver must not get an uncapped log. Status: open.

### 1. Bound the no-perl fallback

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

### 2. Mark dropped writes

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

### 3. Log driver fallback

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

## Current state

The writer, its rotation and the `local` driver landed in `#877`. Nothing in this recommendation has changed since the report. The environment filter from R10 is in [0830](0830-r10-vendor-debug-environment.md), and the relaunch deletion from L9 is in [0740](0740-r6-docker-bridge-log-rotation.md).

## Constraints and rationale

- The writer is part of the image contract (`bounded-logs=1`, `docker/image-manifest.ts`), so a change reaches a container only after a rebuild.
- It must keep draining whatever happens, so a producer never sees a closed pipe.

## Needs verification

- How many real daemons lack the `local` driver is unknown.
- Full-disk behaviour was read from the script, not run.

## Related

- [Logging and database report, R10](../2026-10-29-logging-and-database-efficiency.md#r10-docker-log-hygiene-l9) and [L9](../2026-10-29-logging-and-database-efficiency.md#l9-docker-container-logging-medium)
- [0022 container resource budgets](../../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md)
