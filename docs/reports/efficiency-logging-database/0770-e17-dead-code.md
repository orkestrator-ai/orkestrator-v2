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

## Outcome

Checked item by item on 2026-11-05 against the finished work. Base commit `af2e566e5`. Every finding still held at the base, though the report's line numbers had moved: the writer is at `bridges/codex-bridge/src/index.ts:453`, the key at `models.ts:1239` and `types/index.ts:634`, the allowlist at `global-settings-patch.ts:59` and `:97`, the toggle at `GlobalSettings.sections.tsx:2470`, the default at `app-config-defaults.ts:94`. No to-do was needed.

| Part | Item | Outcome | Code, evidence or to-do |
| --- | --- | --- | --- |
| 0770 | 1. Remove the toggle, default, types and allowlist entries | Done | Gone from `GlobalSettings.sections.tsx`, `GlobalSettings.tsx`, `global-settings-patch.ts`, `types/index.ts`, `models.ts` and `app-config-defaults.ts`. Tests: `renders every settings section` in `GlobalSettings.test.tsx` now asserts the heading is absent; `uses the shared section defaults rather than copies` (`app-config-defaults.test.ts`); `a new install does not write it` (`storage-config-patch.test.ts`). |
| 0770 | 1. Remove the unreachable writer | Done | `writeCodexRawLog`, `ORKESTRATOR_CODEX_RAW_LOG_DIR`, and the helpers only it used (`normalizeOptionalEnvPath`, `sanitizeLogFileComponent`, `normalizeLogPayload`) are gone from `bridges/codex-bridge/src/index.ts`, with their two tests in `index-coverage.test.ts`. |
| 0770 | 1. Remove `raw-log.write-failed` | Done | Gone from `log-vocabulary/bridge.ts`. |
| 0770 | Decision: remove or reconnect | Done, recommended option | Removed. |
| 0770 | Decision: the stored key | Done, recommended option | Not read and not stripped. Test: `an existing config.json holding it still loads and keeps it through a save` (`storage-config-patch.test.ts`). The form never sends or unsets it: `a retired key left in the stored config is neither sent nor unset` (`global-settings-patch.test.ts`). |
| 0770 | Constraint: an older client's save is not refused | Done, and it found a refusal the report did not name | A direct save was already safe: `a save from an older client that still sends it is not refused` (`storage-config-patch.test.ts`, both commands). A workspace client's was not: an older form always sends the key, so against a machine storing none, `isGlobalConfigEcho` would see a change and answer 403. `RETIRED_GLOBAL_SETTING_KEYS` (`nodes/workspace-grant-scope.ts`) leaves the key out of that comparison, with a row in the [version compatibility register](../../architecture/version-compatibility.md#register). Tests: `the retired Codex raw event logging key says nothing about a change` (`workspace-grant-scope.test.ts`) and `answers an older client's save carrying the retired raw logging key without writing` (`gateway-workspace-grant-scope.test.ts`); both fail with the fix disabled. |
| 0770 | Beyond the report: the Experimental page on another machine | Done | That view showed only the removed block, so it would have gone blank. It now says the settings belong to this window's machine. Test: `a command window with a leaf selected only offers scheduling on the window machine` (`SettingsPage.machine-routing.test.tsx`). |
| 0770 | `CODEX_BRIDGE_RECORD_NOTIFICATIONS` stays | Holds | `notification-recorder.ts` is unchanged and `notification-recorder.test.ts` passes. [Logging](../../architecture/logging.md) now says it is the only capture of raw Codex events. |
| 0770 | Needs verification: does any other tool read `<logs>/codex-raw` | Answered: no | A repository-wide search finds the name only in four tests, as an example nested directory: `log-storage.test.ts`, `commands-registry-environments-logs.test.ts`, `application-logging.test.ts` and `essential-log.test.ts`. Tools outside the repository were not searched. A directory left by an old install gets no special handling: the size report counts it, and the age sweep and **Clean up logs** treat it like any other. |
| 0930 | 1. Remove `cursorDebugEnabled` | Done | The function and its assertions are gone from `run-diagnostics.ts` and `run-diagnostics.test.ts`; the file's other diagnostics are unchanged. The `CURSOR_BRIDGE_DEBUG` variable stays as the documented fallback in the shared `bridgeDebugEnabled`, covered by `bridge-diagnostics.test.ts`. |
| 0930 | 2. Correct comments naming `/api/metrics` | Done | `/__orkestrator/metrics` in `commands-registry-system.ts` (two), `compatibility-path-usage.ts` (`:115`, not the report's `:81`) and `recurring-diagnostics.ts`, plus three places the report did not list: `version-compatibility.md`, to-dos 0023 and 0232. Only the review's own M2 finding, which reports the wrong name, still contains it. |
| 0930 | Current state: the rest of L10 | Re-checked, holds | Fixed areas in `logging.md`; `flushBufferedDebugLoggers` in `bridge-diagnostics.ts`; raw stderr has no level; `dropInheritedVendorDebug` in `commands-servers.ts` (E13). |
