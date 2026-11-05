# E17: Dead code

This file combines 2 reports into one batch to build together. Low-risk removals. Goes before E15, which names six of the same files.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0770](#0770-remove-or-reconnect-codex-raw-event-logging) | Medium | R9 (L8): remove the no-op toggle. |
| [0930](#0930-small-logging-and-metrics-hygiene-left-over) | Low | L10 and M2 leftovers that no recommendation covers. |

## 0770: Remove or reconnect "Codex Raw Event Logging"

### Task analysis

#### Tasks

1. **Remove the no-op setting**: the toggle, its default and the unreachable writer. Status: open.

#### 1. Remove the no-op setting

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

### Current state

Unchanged since the report. Its line numbers have moved: the default is now in `app-config-defaults.ts`, not `storage-shared-config.ts`.

### Constraints and rationale

- A client older than this change may still send the key. Check that a settings save from it is not refused once the backend stops knowing it.

### Needs verification

- Whether any other tool reads `<logs>/codex-raw`. The only reference found is a nested-directory test (`apps/desktop/electron/application-logging.test.ts:459`).

## 0930: Small logging and metrics hygiene left over

### Task analysis

#### Tasks

1. **Remove `cursorDebugEnabled`**: dead code with no production caller. Status: open.
2. **Correct comments naming `/api/metrics`**: the route is `/__orkestrator/metrics`. Status: open.

#### 1. Remove `cursorDebugEnabled`

**Problem.** A function reads `CURSOR_BRIDGE_DEBUG` and nothing uses it.

**Context.** No recommendation covers it; L10 lists it. The per-bridge flags were replaced by `ORKESTRATOR_BRIDGE_DEBUG` and live policy.

**Investigation.** `bridges/cursor-bridge/src/run-diagnostics.ts:12` defines it, and the only other references are its tests (`run-diagnostics.test.ts:8`, `:62-63`).

**Decisions.** None: delete the function and its test.

#### 2. Correct comments naming `/api/metrics`

**Problem.** Comments send a reader to a route that does not exist.

**Context.** M2 notes this. No recommendation covers it.

**Investigation.** `API_PREFIX` is `/__orkestrator` (`apps/backend/src/gateway-support-core.ts:195`). `/api/metrics` appears in comments at `commands-registry-system.ts:66`, `:76`, `compatibility-path-usage.ts:81` and `recurring-diagnostics.ts:14`.

**Decisions.** None: mechanical comment edits.

### Current state

The rest of L10 is done or no longer applies:

- **Tag variants** went with the migration to fixed areas (`docs/architecture/logging.md:794-884`).
- **Buffered debug logger** aggregates and flushes (R4; `bridge-diagnostics.ts:684`, `:696`).
- **Bridge stderr at `error`** stays by design for raw text, which has no level (`logging.md:604`, `:824`).
- **Unfiltered environment** was `0830`, done in [E13](0000-index.md#closing-check-of-e13-silent-failures) ([the bridge hop](../../architecture/logging.md#the-bridge-hop)).

## Related

- [Logging and database report, R9](../2026-10-29-logging-and-database-efficiency.md#r9-remove-or-reconnect-codex-raw-event-logging-l8) and [L8](../2026-10-29-logging-and-database-efficiency.md#l8-codex-raw-event-logging-does-nothing-medium-user-visible)
- [Version compatibility](../../architecture/version-compatibility.md)
- [Logging and database report, L10](../2026-10-29-logging-and-database-efficiency.md#l10-consistency-low) and [the metrics findings, M2](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
