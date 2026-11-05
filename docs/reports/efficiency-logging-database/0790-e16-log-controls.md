# E16: Log controls

This file combines 3 reports into one batch to build together. Linked settings for log detail.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0790](#0790-renderer-diagnostics-a-user-can-turn-on) | Medium | R8's remainder (L7) and its control: a switch, DevTools and a persisted error ring. |
| [0890](#0890-log-detail-presets-auto-revert-and-a-privacy-sentence) | Low | User controls: presets, auto-revert and privacy text. |
| [0900](#0900-command-line-flags-for-log-levels) | Low | User controls: `--log-level` and `--log-category`. |

## 0790: Renderer diagnostics a user can turn on

### Task analysis

#### Tasks

1. **Settings switch for renderer debug**: sets `orkestrator:debug` and reloads. Status: open.
2. **Open Developer Tools from the menu**: in the packaged app, opt-in. Status: open.
3. **A persisted, content-free error ring**: renderer failures leave a trace. Status: open.

#### 1. Settings switch for renderer debug

**Problem.** Raising the renderer's level needs `localStorage["orkestrator:debug"]`, and a packaged app has no DevTools to set it with.

**Context.** The R1 renderer slice made this more pressing: `console.debug` sites now write nothing unless the key is set, and Verbose in DevTools no longer shows them. `logging.md:755-761` records that it "has no setting or UI".

**Investigation.** `apps/web/src/lib/debug-log.ts:16` names the key and `:44` reads it once at startup. Live policy excludes renderer areas (`packages/protocol/src/log-policy.ts:141`). `LogDetailSettings` lists only live areas.

**Decisions.**

- **Where does the setting live?**
  - **Per window in `localStorage`, as today, with a switch that writes it and reloads (recommended).**
    - Pros: the report's design; a level belongs to this browser, not the host; one small component.
    - Cons: a remote client must set it separately, and reload loses nothing durable but does interrupt the view.
  - **Add renderer areas to live policy.**
    - Pros: no reload; one control for everything.
    - Cons: a host setting would change every client's console, and `log-policy.ts` excludes them on purpose.

#### 2. Open Developer Tools from the menu

**Problem.** In a packaged app, DevTools never opens, so errors from `MessageRenderBoundary` and `RichBlockFrame` cannot be seen.

**Context.** The report wants this in Help, enabled while debug logging is on. Note Help exists only off macOS (`application-menu.ts:202-213`).

**Investigation.** `apps/desktop/electron/window.ts:133-135` opens DevTools only when `isDev`. `application-menu.ts` has no toggle. The artifact host disables DevTools (`artifact-host-session.ts:53`), and previews have their own (`browser-preview-manager.ts:860`). `docs/reports/2-26-10-27-security.md:426` notes that secrets in renderer memory are visible in DevTools.

**Decisions.**

- **Where and when is it offered?**
  - **In a Help menu added on every platform, shown only while renderer debug logging is on (recommended).**
    - Pros: explicit opt-in, matching the report's trade-off; invisible by default.
    - Cons: adds a Help menu on macOS.
  - **A button in Settings → Debug only.**
    - Pros: no menu change; sits next to the switch.
    - Cons: if the settings page is what is broken, it cannot be reached.

#### 3. A persisted, content-free error ring

**Problem.** Renderer errors are deliberately not saved, so a user's report of a renderer bug leaves nothing behind.

**Context.** `logging.md:747` says whether more may be saved is undecided. A bug report already includes `recentRendererErrors` (`apps/web/src/lib/bug-report/renderer-errors.ts`, at most 30, in memory), but those hold messages and are redacted by the agent, so they are not this.

**Investigation.** Only seven exact `[DesktopStartup]` markers cross to the log (`apps/desktop/electron/renderer-diagnostics.ts:59`). Boundaries already log a component name, an allowlisted error type and a fingerprint (the `RichBlockFrame` change in the R1 renderer addendum).

**Decisions.**

- **What does an entry hold?**
  - **Error class, boundary name, route pattern, count and fingerprint, about 100 entries (recommended).**
    - Pros: the report's list plus the existing fingerprint, which tells failures apart; holds no message or stack.
    - Cons: identifies less than a stack would.
  - **Include bounded stack frames.**
    - Pros: far more useful for a fix.
    - Cons: frames hold paths and function names, and the report says the ring must not include stacks to stay within the privacy rule.
- **Where is it kept?**
  - **Sent to the backend, into the essential log (recommended; [the essential log](../../architecture/logging.md#the-essential-event-log) is built).**
    - Pros: survives a renderer crash and appears in the export.
    - Cons: a new client-to-backend write that must be rate-bound and validated.
  - **`localStorage` only.**
    - Pros: no backend path.
    - Cons: lost with the profile; a renderer that never loads cannot read it.

### Current state

Done, so not tasks here:

- Lifecycle trace logs moved to `debug` through `rendererDebugLog`'s gate (`#1592`; the 14 sites are in the report's [renderer addendum](../2026-10-29-logging-and-database-efficiency.md#addendum-renderer-levels-changed-by-r1)).
- Per-keystroke warnings are throttled (`apps/web/src/hooks/useTerminal.ts:1125`, `:1139`).

Still true but minor: every renderer `console.*` raises a `console-message` event in main to be compared and dropped (`renderer-diagnostics.ts:59`). Lower volume now, since `debug` sites write nothing.

### Constraints and rationale

- The renderer never uses the `desktop.startup` area, and tests scan for it (`docs/architecture/logging.md:736-740`). An error ring must not route through the marker path.

### Open questions

- The report leaves the remote web client's ring and iOS (`os_log`, `isInspectable`) as considerations. The iOS shell has no logging at all. Whether either matters depends on who debugs those clients.

## 0890: Log Detail presets, auto-revert and a privacy sentence

### Task analysis

#### Tasks

1. **Quick presets**: named settings for common investigations. Status: open.
2. **Auto-revert**: raised detail returns to normal after a time. Status: open.
3. **Privacy text**: Settings states plainly what no level records. Status: open.

#### 1. Quick presets

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

#### 2. Auto-revert

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

#### 3. Privacy text

**Problem.** The report asks the UI to say no level records prompts, terminal output, file contents or credentials.

**Context.** Current copy does not. It says how much each part writes and that this does not decide saving.

**Investigation.** `LogDetailSettings.tsx` holds the header text. One exception needs care: raw output that is not a logger call is captured as text (`logging.md:583-584`), and `0830`, done in [E13](0000-index.md#closing-check-of-e13-silent-failures) ([the bridge hop](../../architecture/logging.md#the-bridge-hop)), removed the main way that could hold content.

**Decisions.**

- **How absolute can the sentence be?**
  - **"Logs are designed to leave out prompts, terminal output, file contents and credentials", with no "never" (recommended).**
    - Pros: true given that a string field and raw vendor output cannot be proved clean (`logging.md:211-213`).
    - Cons: weaker than the report's wording.
  - **The report's "no level ever records", now that `0830` has landed.**
    - Pros: clear.
    - Cons: a claim the code cannot enforce.

### Current state

The other controls in the report's table exist; see the disposition table. Names differ from the report's: **Save Logs to Disk** and **Log Detail**.

## 0900: Command-line flags for log levels

### Task analysis

#### Tasks

1. **Decide on `--log-level` and `--log-category`**: add them, or settle on the environment variable. Status: open.

#### 1. Decide on `--log-level` and `--log-category`

**Problem.** The report's control table lists both flags for headless hosts, and neither exists.

**Context.** The environment half landed under another name: `ORKESTRATOR_LOG_LEVEL` takes `warn`, `updater=debug` or `warn,updater=debug,desktop.dialog=trace` (`docs/architecture/logging.md:528-534`), which is the syntax the report proposed for `ORKESTRATOR_LOG`. A bridge the backend launches inherits it.

**Investigation.** `apps/backend/src/server-flags.ts` has no log flag, and `options.test.ts` fails if `options.ts` parses a flag missing from it. `packages/cli/src/client/argv.ts` has none either. `configureLoggerFromEnvironment` runs at the top of `apps/backend/src/main.ts:56`, before flags are parsed.

**Decisions.**

- **Add flags?**
  - **No: document the environment variable for `orkestrator serve` and stop there (recommended).**
    - Pros: one syntax, which already works everywhere including bridges; no new public surface to keep compatible.
    - Cons: a launcher with no way to set an environment is unserved, and flags appear in `--help` where a variable does not.
  - **Add `--log-level`, mapped to the variable before logging is configured.**
    - Pros: discoverable, and matches other service flags.
    - Cons: flags must be read before `main.ts:56`, and it is one more entry in the public CLI contract for no new ability.

## Related

- [Logging and database report, R8](../2026-10-29-logging-and-database-efficiency.md#r8-renderer-diagnostics-a-user-can-actually-turn-on-l7) and [L7](../2026-10-29-logging-and-database-efficiency.md#l7-renderer-diagnostics-are-unreachable-in-the-packaged-app-high-for-supportability)
- [Application logging](../../architecture/logging.md#the-renderer)
- [Logging and database report, Proposed user controls](../2026-10-29-logging-and-database-efficiency.md#proposed-user-controls)
- [Application logging, live settings](../../architecture/logging.md#live-settings)
- [Public CLI](../../architecture/public-cli.md)

## Outcome

Checked back item by item on 2026-11-05 against the finished work. Base commit `1a66d95c3`. Every finding was re-checked against that commit before building, and each still held: `debug-log.ts` named and read the key with no setting, `logDetailAreas` left out renderer areas, Help existed only off macOS, `window.ts` opened DevTools only when `isDev`, no preset or expiry existed, the Log Detail copy said nothing about privacy, and neither `server-flags.ts` nor `argv.ts` had a log flag.

| Part | Task or item | Outcome | Code, tests, evidence or to-do |
| --- | --- | --- | --- |
| 0790 | 1. Settings switch for renderer debug | Done, recommended option | Settings → Debug → **Renderer Debug Logging** (`RendererDebugSettings.tsx`) calls `setRendererDebugPreference` (`apps/web/src/lib/debug-log.ts`), which sets or clears `localStorage["orkestrator:debug"]` for this window and reloads. Tests: `RendererDebugSettings.test.tsx`, `debug-log.test.ts`. Seen live: the switch stored the key and showed "On in this window" after the reload. |
| 0790 | 2. Open Developer Tools from the menu | Done, recommended option | Help on every platform (the system Help menu on macOS) with **Open Developer Tools** only while a renderer reported debug logging on: `application-menu.ts`, `renderer-debug-tools.ts`, the trusted-sender IPC route `orkestrator:window:set-renderer-debug` (`ipc.ts`, `preload-api.ts`, `main.ts`), reported at start by `reportRendererDebugLogging`. The artifact host and previews are untouched. Tests: `application-menu.test.ts`, `renderer-debug-tools.test.ts`, `main-ipc.test.ts`, `preload-api.test.ts`. Added 2026-11-05: `log-controls-packaged-electron.spec.ts` drives the real switch and the item in the packaged Linux app (headless), and `application-menu-electron.spec.ts` covers the item on real Electron; `native-application-menu.yml` runs them on the other platforms. macOS, Windows and a drawn menu bar are not yet observed and stay in [6301](../../todo/cross-cutting/6301-log-controls-live-evidence.md) task 1; the repository has no Windows package target. |
| 0790 | 3. A persisted, content-free error ring: what an entry holds | Done, recommended option | Error class, boundary, route (the renderer surface: the app has no router), count and fingerprint, 100 entries, no message or stack: `packages/protocol/src/renderer-errors.ts`, `apps/web/src/lib/renderer-error-ring.ts`, fed by React's root callbacks (`react-root-errors.ts`) and the window's error events (`renderer-bootstrap.ts`). Tests: `renderer-errors.test.ts`, `renderer-error-ring.test.ts` (a message or stack is never stored), `react-root-errors.test.ts`, `renderer-bootstrap.test.ts`. |
| 0790 | 3. Where it is kept | Done, recommended option | Sent to the backend's essential log through the new `record_renderer_errors` (`renderer-error-recorder.ts`): every entry re-parsed, any other key refusing the write, 30 entries a minute, refused to workspace clients; the essential event `renderer-errors` `error.recorded` with label classifiers. Upload: `renderer-error-upload.ts`, a desktop window's own renderer only. Tests: `renderer-error-recorder.test.ts`, `log-essential.test.ts`, `log-vocabulary.test.ts`, `renderer-error-upload.test.ts`. Seen live: the command wrote the entry to a profile's `essential.jsonl`, and a write with a `message` was refused and stored nothing. The Electron leg end to end: [6301](../../todo/cross-cutting/6301-log-controls-live-evidence.md) task 2. |
| 0790 | Constraint: never through the `desktop.startup` marker path | Done | The ring never writes to the console or uses the area. Tests: `renderer-bootstrap.test.ts` (no marker for a recorded failure) and the unchanged `renderer-diagnostics.test.ts`. |
| 0790 | Current state: every renderer `console.*` raises a `console-message` in main | No longer a task | Recorded by the report as still true but minor; unchanged, and not a task. |
| 0790 | Open question: the remote web client's ring and iOS | To-do | [6300](../../todo/cross-cutting/6300-renderer-error-ring-for-realms-and-web-clients.md), with workspace realms. |
| 0890 | 1. Quick presets | Done, recommended option | `log-detail-presets.ts`: Normal, Quiet, Agent sessions, Crashes and stopped processes, Updates, Everything, each written as ordinary `level` and `areaLevels`; the matching preset or **Custom** shown in `LogDetailSettings.tsx`. Test: `LogDetailSettings.test.tsx`. |
| 0890 | 2. Auto-revert: where the timer lives | Done, recommended option | Backend-owned `logDetailExpiresAt` recomputed on every config write (`nextLogDetailExpiresAt`, `storage-config.ts`), checked at start and every minute (`LogPolicyService`, `reconcileLogDetailExpiry`), reverting through the normal config write; saving untouched; `logDetailKeepRaised` keeps it on, and an older client's save keeps the choice and still gets an expiry. Tests: `log-policy.test.ts`, `log-detail-expiry.test.ts`. Seen live: an expiry in the past at start reverted `bridge=debug` to `info`, left saving alone and wrote `policy.detail-expired`. The running one-minute check was seen reverting in the packaged Linux app on 2026-11-05 (`log-controls-packaged-electron.spec.ts`). |
| 0890 | 2. Auto-revert: the default | Done, recommended option | 24 hours, only above `info`; the settings show when it goes back and offer **Keep raised detail on**. Test: `LogDetailSettings.test.tsx`. |
| 0890 | 3. Privacy text | Done, recommended option | "Logs are designed to leave out prompts, terminal output, file contents and credentials." in the Log Detail header, with no "never". Test: `LogDetailSettings.test.tsx`. |
| 0900 | 1. `--log-level` and `--log-category` | Done, recommended option | No flags. `ORKESTRATOR_LOG_LEVEL` for `orkestrator serve` documented in [public-cli.md](../../architecture/public-cli.md#log-levels-for-serve) and the logging guide. |
| All | `logging.md` saying the renderer key has no setting | Done | The renderer section now describes the switch and the Help menu item. |


### Review repair boundary (2026-11-05)

The review repair restores this report with its existing outcome table before
deleting it in the final commit. History through validated commit 740ea0f0f is
retained. Developer Tools now falls back to an opted-in background renderer,
debug state is reported before the backend startup check, and dropped renderer
error entries are summarized at the end of each rate window. Targeted tests and
a real Electron caught-error-to-essential-log scenario passed.

The unrelated sidebar changes were preserved on local branch
fixes/e16-federation-preserved and reverted from this logging branch. The
three existing federation fork tests fail again after that separation; their
repair belongs to that separate change. This remains a validation limitation.
The recorded broad browser and Electron failures are still undetermined; no
claim is made that those checks are green.

### Evidence round (2026-11-05)

The report was restored once more so this table stays in the version just before
deletion. This round added no product code: it added the packaged and real-Electron
tests named above, extended the workflow, closed 6301's timer task, narrowed its
menu task, and recorded the `CodexHostRules` failure's demonstrated cause as
[6302](../../todo/cross-cutting/6302-codex-host-rules-fixture-startup-line.md). The
recorded `test:agent:electron` failures were not rerun: this host has no disposable
display, and they remain undetermined.
