# Keep the previous Docker bridge log across a relaunch

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Stop deleting the log on relaunch**: keep the crashed bridge's log. Status: open.
2. **Make the kept log readable**: retrieval includes it, and clients can call retrieval. Status: open (depends on 1).

### 1. Stop deleting the log on relaunch

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

### 2. Make the kept log readable

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
  - **Yes, with [0780](0780-r11-export-diagnostics.md) as their first consumer (recommended).**
    - Pros: a diagnostics bundle then covers every bridge.
    - Cons: dead code until that lands.
  - **Leave them backend-only.**
    - Pros: no client change.
    - Cons: the logs stay reachable only by hand-written commands.

## Current state

Bounded tails, retrieval commands for all five bridges, and redaction on the way out exist. The deletion on relaunch is unchanged since the report.

## Constraints and rationale

- The moved file keeps its 0600 mode. Container logs can hold JSON records with bounded fields but also raw output, so retrieval must stay behind `boundDiagnosticTail`.
- A container that has not been rebuilt runs the writer it shipped with; the launch script change applies at the next bridge start, whichever image it is.

## Related

- [Logging and database report, R6](../2026-10-29-logging-and-database-efficiency.md#r6-an-always-on-essential-tier-that-closes-the-silent-gaps-l4) and [L4](../2026-10-29-logging-and-database-efficiency.md#l4-silent-failures-too-little-logging-high)
- [0720](0720-r6-silent-failure-logging.md), [0850](0850-r10-docker-log-bounds.md)
