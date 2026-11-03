# Log Detail presets, auto-revert and a privacy sentence

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Quick presets**: named settings for common investigations. Status: open.
2. **Auto-revert**: raised detail returns to normal after a time. Status: open.
3. **Privacy text**: Settings states plainly what no level records. Status: open.

### 1. Quick presets

**Problem.** Log Detail offers about a level per area, which is more than most users can choose from.

**Context.** The report says presets matter more than per-area toggles, and should match `docs/debugging/`. That directory holds one file, `process-crashes-and-kills.md`, so only part of the scenarios exist to match.

**Investigation.** `apps/web/src/components/settings/LogDetailSettings.tsx` has a default level and collapsible areas, and no preset. `parseLogDetail` and `logDetailAreas` come from `packages/protocol/src/log-policy.ts`. The per-minute bridge stream and levels are documented in `docs/architecture/logging.md:472-483`.

**Decisions.**

- **Stored or client-side?**
  - **A client-side list that writes ordinary `level` and `areaLevels` (recommended).**
    - Pros: no config or protocol change; older clients see plain values; the highlighted preset is derived by comparison.
    - Cons: a preset's meaning is frozen in the client that applied it.
  - **A stored `preset` name that the backend expands.**
    - Pros: a preset can be changed in one place.
    - Cons: a new config key and a second source of truth.

### 2. Auto-revert

**Problem.** Someone turns on debug for one issue and forgets it. That is the report's main way debug costs disk.

**Context.** Saving and detail are now separate settings, so reverting detail leaves saving alone. `ORKESTRATOR_LOG_LEVEL` stays on top of any setting (`logging.md:528-534`).

**Investigation.** `LogPolicyService` (`apps/backend/src/core/log-policy-service.ts:104`) owns policy changes, pushes them to bridges and writes the `policy.changed` audit line. A settings save rewrites `logDetail`, and a client predating it keeps the stored value (`logging.md:527`).

**Decisions.**

- **Where does the timer live?**
  - **In the backend: `logDetailExpiresAt` beside `logDetail`, checked on a timer and at start, reverting through the normal config write (recommended).**
    - Pros: survives a restart; applies to bridges and the audit line automatically; no client needs to be open.
    - Cons: a new key; a user must be able to turn it off for a long investigation.
  - **In the renderer.**
    - Pros: no backend change.
    - Cons: needs an open client at the moment it is due, which a headless host may not have.
- **The default?**
  - **24 h, only when detail is raised above `info` (recommended; the report's figure).**
    - Pros: a default level of `info` never expires.
    - Cons: a multi-day intermittent bug loses detail unless the user extends it.
  - **Off by default.**
    - Pros: no surprise.
    - Cons: does not fix the forgetting it exists for.

### 3. Privacy text

**Problem.** The report asks the UI to say no level records prompts, terminal output, file contents or credentials.

**Context.** Current copy does not. It says how much each part writes and that this does not decide saving.

**Investigation.** `LogDetailSettings.tsx` holds the header text. One exception needs care: raw output that is not a logger call is captured as text (`logging.md:583-584`), and [0830](0830-r10-vendor-debug-environment.md) addresses the main way that could hold content.

**Decisions.**

- **How absolute can the sentence be?**
  - **"Logs are designed to leave out prompts, terminal output, file contents and credentials", with no "never" (recommended).**
    - Pros: true given that a string field and raw vendor output cannot be proved clean (`logging.md:211-213`).
    - Cons: weaker than the report's wording.
  - **The report's "no level ever records" after [0830](0830-r10-vendor-debug-environment.md) lands.**
    - Pros: clear.
    - Cons: a claim the code cannot enforce.

## Current state

The other controls in the report's table exist; see the disposition table. Names differ from the report's: **Save Logs to Disk** and **Log Detail**.

## Related

- [Logging and database report, Proposed user controls](../2026-10-29-logging-and-database-efficiency.md#proposed-user-controls)
- [Application logging, live settings](../../architecture/logging.md#live-settings)
- [0790](0790-r8-renderer-diagnostics.md), [0900](0900-controls-log-cli-flags.md)
