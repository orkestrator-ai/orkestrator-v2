# Remove or reconnect "Codex Raw Event Logging"

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Remove the no-op setting**: the toggle, its default and the unreachable writer. Status: open.

### 1. Remove the no-op setting

**Problem.** Settings shows a toggle, on by default, saying extra raw Codex events are captured. Nothing is. Users are told something false, and whoever wires it up later inherits a raw-payload capture that is on by default.

**Context.** The report recommends removal unless subagent transcript validation is still active. A search of `docs/todo` finds no item using this capture. The Codex bridge has a separate developer tool for recordings, `CODEX_BRIDGE_RECORD_NOTIFICATIONS`, which warns loudly (`docs/architecture/logging.md:906-909`).

**Investigation.** The bridge reads `ORKESTRATOR_CODEX_RAW_LOG_DIR` (`bridges/codex-bridge/src/index.ts:382`), and no backend code sets it. `writeCodexRawLog` (`:454`) is reachable only as `writeCodexRawLogForTesting` (`:974`). The key is defaulted at `packages/protocol/src/app-config-defaults.ts:91`, typed at `apps/backend/src/core/models.ts:1229` and `apps/web/src/types/index.ts:632`, allowlisted at `apps/web/src/components/settings/global-settings-patch.ts:58` and `:94`, held in `GlobalSettings.tsx` and rendered at `GlobalSettings.sections.tsx:2363`. The `raw-log.write-failed` event (`log-vocabulary/bridge.ts`) goes with it.

**Decisions.**

- **Remove or reconnect?**
  - **Remove (recommended; the report's choice).**
    - Pros: the UI is honest; no privacy exception; `CODEX_BRIDGE_RECORD_NOTIFICATIONS` remains for a developer who needs raw events.
    - Cons: a future validation pass needs that recorder rather than a user-visible switch.
  - **Reconnect, default off, with a byte cap, retention and its own category.**
    - Pros: a working capture a user can turn on.
    - Cons: raw provider events hold prompts and tool content, so this is a deliberate exception to AGENTS.md invariant 12; it needs a separately labelled control, and two recorders for one purpose.
- **What happens to the stored key?**
  - **Stop reading it and leave it in old configs (recommended).**
    - Pros: a downgrade still works; `version-compatibility.md` asks for additive contract changes; no migration.
    - Cons: a dead key stays in `config.json`.
  - **Strip it during config normalisation.**
    - Pros: a clean file.
    - Cons: a downgraded older client gets the on default back, harmlessly but needlessly.

## Current state

Unchanged since the report. Its line numbers have moved: the default is now in `app-config-defaults.ts`, not `storage-shared-config.ts`.

## Constraints and rationale

- A client older than this change may still send the key. Check that a settings save from it is not refused once the backend stops knowing it.

## Needs verification

- Whether any other tool reads `<logs>/codex-raw`. The only reference found is a nested-directory test (`apps/desktop/electron/application-logging.test.ts:459`).

## Related

- [Logging and database report, R9](../2026-10-29-logging-and-database-efficiency.md#r9-remove-or-reconnect-codex-raw-event-logging-l8) and [L8](../2026-10-29-logging-and-database-efficiency.md#l8-codex-raw-event-logging-does-nothing-medium-user-visible)
- [Version compatibility](../../architecture/version-compatibility.md)
