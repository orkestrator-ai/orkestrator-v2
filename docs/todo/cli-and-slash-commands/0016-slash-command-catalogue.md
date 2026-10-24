# Slash-command catalogue

Checked against `main` at `9da80451` (2026-10-17).

The native composer's `/` menu lists only commands the provider reported and
that have a tested executor, and a selected command never turns into ordinary
prompt text. The core shipped in #827 and is described in
[`native-agent-commands.md`](../../architecture/native-agent-commands.md). What
remains is the legacy catalogue surface, which still shows guessed Claude rows
when a bridge answers the session route with a 404 (a bridge older than the
contract), and a set of command classes that were left unavailable on purpose
and need a decision. A new tab on a current bridge never sees those rows (see
"Constraints and rationale").

## Current state

- Every bridge serves the version 1 catalogue (`GET /session/:id/commands`,
  `POST /session/:id/commands/refresh`, `commandRevision` on the session
  snapshot). Wire limits are `COMMAND_CATALOGUE_LIMITS` in
  `packages/protocol/src/agent-command-catalogue.ts`.
- The backend cache (`NativeAgentCommandCatalogueCache` in
  `apps/backend/src/core/native-agent-command-catalogue.ts`) has a TTL of
  30 s, 256 keys, 16 MiB, 4 concurrent provider reads and 5 s to 5 min retry
  backoff. Keys come from `commandCatalogueKey`; a session without a
  `providerSessionId` uses the key `global`.
- `HttpBridgeCatalogAdapter.commandCatalogue`
  (`apps/backend/src/core/http-bridge-catalog.ts`) reads the session route
  when it has a session ID, falls back to a legacy global route on 404, and
  reads the global route directly when it has no session ID. Only
  `refreshProjectionCommands` for a tab with no stored session reads without
  one (`native-agent-service.ts`), and its projection is `null`, so those
  rows are cached under `global` but never shown. Codex and Cursor
  map to `/global/slash-commands`; Claude, Pi and Grok map to
  `/plugins/commands`. Legacy rows are normalised as non-enhanced rows with a
  `legacyCommandId` and run as typed text, never as an enhanced selection.
- What each legacy route answers today:
  - Claude: `GET /plugins/commands` (`bridges/claude-bridge/src/routes/plugins.ts`)
    calls `discoverSlashCommands` in `services/slash-commands.ts`, a
    filesystem scan plus the fixed 15-row `BUILTIN_COMMANDS` list. That list
    includes `/clear`, `/model`, `/permissions`, `/logout`, `/doctor` and
    `/vim`, which the session catalogue marks unavailable.
  - Pi: `GET /plugins/commands` (`bridges/pi-bridge/src/http.ts`) answers an
    empty list.
  - Codex: `GET /global/slash-commands` (`bridges/codex-bridge/src/index.ts`)
    answers templates and bridge built-ins from `listGlobalCommandRows`
    without starting Codex.
  - Cursor: `GET /global/slash-commands` (`bridges/cursor-bridge/src/http.ts`)
    answers the unsupported catalogue.
  - Grok: the ACP bridge (`bridges/acp-bridge/src/acp-http.ts`) serves no
    legacy route.
- Disabled by design, listed with a reason and never executed:
  - Claude, in `bridges/claude-bridge/src/services/session-manager-commands.ts`:
    `SESSION_CHANGING_COMMANDS` (`/clear`, `/model`, `/permissions`,
    `/resume`), `INTERACTIVE_COMMANDS` (`/login`, `/logout`) plus the init
    `terminal_slash_commands`, and `UNQUALIFIED_COMMANDS` (`/config`,
    `/doctor`, `/exit`, `/ide`, `/quit`, `/statusline`, `/terminal-setup`,
    `/theme`, `/vim`). The bridge also refuses these as typed text.
  - Codex templates containing inline shell spans: `requires-shell-execution`
    in `bridges/codex-bridge/src/prompts/template-discovery.ts`.
- Pi extension commands are listed with `busy: "idle"`
  (`bridges/pi-bridge/src/commands.ts`). Their behaviour without Pi's terminal
  UI is unqualified.
- Orkestrator's own shortcuts are `/steer` (reserved) and `/compact` (defers to
  a provider `/compact`), merged by `withSessionActionSlashCommands` in
  `packages/protocol/src/agent-slash-commands.ts`.
- The picker groups rows by `source` (`groupSlashCommandRuns` in
  `apps/web/src/lib/chat/slash-command-search.ts`, rendered by
  `SlashCommandMenu.tsx`). This is covered by component tests only.
- The Cursor (`bridges/cursor-bridge/src/http.ts`, 1.0.37), OpenCode
  (`opencode-commands.ts`, 1.19.0) and Claude (`session-manager-commands.ts`,
  0.3.296) owner comments match the pins (re-checked 2026-10-17 and
  2026-10-23).

## Outstanding work

### Code

1. **Retire the legacy catalogue surface.**
   - Agree the mixed-version support window. Done 2026-10-24 by
     [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md):
     published releases from v2.21.0 today
     ([`version-compatibility.md`](../../architecture/version-compatibility.md)).
     Pre-#599 and pre-#827 peers are outside it, so the 404 fallback may go;
     `slash-catalogue.legacy-route` counts its use.
   - Stop the 404 fallback showing guessed rows: mark legacy rows
     display-only and unavailable, or drop the fallback, so the Claude picker
     never shows `BUILTIN_COMMANDS` even against an old bridge. (Pre-session
     tabs on a current bridge already never see them.)
   - Make `refreshProjectionCommands` skip the provider read when no session
     is stored, instead of reading the global route for a projection that is
     `null` (a wasted filesystem scan on Claude, a 404 on Grok).
   - Count legacy-route use without logging command names.
   - After the window, delete `services/slash-commands.ts`, the Claude and Pi
     `/plugins/commands` routes, the Codex and Cursor `/global/slash-commands`
     routes, and the global fallback in `HttpBridgeCatalogAdapter.commandCatalogue`.
   - Keep unrelated plugin discovery (`GET /plugins`).
2. **Claude session-changing commands.** Either keep them unavailable, or make
   the bridge adopt the new conversation ID and configuration after `/clear`,
   `/model`, `/permissions` or `/resume`, and reconcile before the next
   submission. Never implement `/clear` by deleting history.
3. **Codex inline-shell templates.** Decide whether to keep them at all. If
   yes, build a policy-reviewed executor that:
   - parses executable spans before substituting arguments, and never
     interpolates arguments into a span;
   - has an explicit cwd and environment, a deadline, cancellation, and count
     and byte limits;
   - persists preparation identity before side effects, never repeats on
     retry, and never auto-approves.

   Until then, keep `requires-shell-execution` unavailable.
4. **Pi extension commands.** Label extensions that need a UI as unavailable,
   or return a bounded "unsupported interaction" result. Never fake `hasUI`.
5. **Further Orkestrator shortcuts** beyond `/steer` and `/compact`: clear or
   new session, model and permission changes, review. Each needs its own
   qualified semantics.
6. **Stale pin comment.** Done 2026-10-23: the Cursor comment names 1.0.37,
   whose declarations were re-checked.
7. **CLI selection.** `session commands` and `session command` are tracked in
   [0017-cli-command-surface.md](0017-cli-command-surface.md).
8. **Claude terminal-only commands before the first turn.** Done
   2026-10-17; see "Constraints and rationale".
9. **Codex plugin skills in a cold catalogue.** Found live on 2026-10-17
   (0.162.1). The first `skills/list` after the app-server child starts
   answers before plugin skills load: 6 skills, reported `ready`. A forced
   reload, or the next TTL read, gives 92. Report the first read `stale`
   until plugin loading settles, or re-read once after a short delay. Today it
   heals within one 30 s TTL.
10. **OpenCode command files added while the server runs.** Done
    2026-10-17; see "Constraints and rationale".
11. **Claude terminal marker (blocked upstream).** If the Agent SDK adds a
    terminal marker to `SlashCommand`, read it from the probe's rows and
    delete the remembered list in `claude-terminal-commands.ts`, which closes
    the first-tab-on-a-new-CLI-version gap described in "Constraints and
    rationale".

### Qualification

- Browser, on Claude, Pi and Grok fixtures: open the picker and check the
  source groups and keyboard order. Edit a fixture command or template file on
  disk, refresh the catalogue, check the new row appears, then reload and
  check it persists. Batch this with the inactive-environment scenario in
  [0015-slash-command-qualification.md](0015-slash-command-qualification.md).
- Before deleting a legacy route: legacy-route use counts from the support
  window, and a mixed-version run (new backend with an old bridge, old backend
  with a new bridge).

## Constraints and rationale

- **Claude terminal-only commands before the first turn (code item 8).**
  Root cause: only a turn's `system/init` frame names the terminal-bound
  commands (`terminal_slash_commands`). `SlashCommand` has no such marker at
  SDK 0.3.296 (checked live on CLI 2.1.296: `/focus` arrives as
  `{ name, description, argumentHint, builtin }`), and a tab with no turn is
  served from the control-only probe, which never sees an init frame.
  - Decision: the bridge remembers the newest list each CLI version reported
    (`bridges/claude-bridge/src/services/claude-terminal-commands.ts`),
    persists it in `~/.claude/orkestrator/terminal-slash-commands.json`
    (newest four versions, atomic rename, last writer wins), and applies it to
    probe rows until the session's own init arrives. The probe reads the
    version from `initializationResult().claude_code_version`, which sends no
    extra request. The session's own init always wins, even when it omits the
    list.
  - Rejected: holding every `builtin` row unavailable until the first turn
    (also blocks `/context`, `/compact` and the rest); a fixed name list
    (guessing, and it rots with each CLI release); spending a real model turn
    at tab open (cost, and a session file the user never asked for).
  - Accepted gap: a CLI version this bridge home has never run a turn on gets
    no list, so its very first tab still lists these rows as available. The
    CLI answers them as local output ("isn't available here yet") with no
    model turn, as recorded in the qualification. If the Agent SDK adds a
    terminal marker to `SlashCommand`, use it and delete the remembered list.
- **OpenCode command files added while the server runs (code item 10).**
  Root cause: OpenCode 1.19.0 reads command files once per directory
  instance, and `command.list` serves that copy until the instance is
  disposed. Reproduced on an isolated `opencode serve`: a file added after
  start was missing from `GET /command` until `POST /instance/dispose`, and
  listed right after it.
  - `instance.dispose` aborts what the instance is running. Observed on the
    same server: a busy session's Bash call ended "User aborted the command"
    and its side effect never happened.
  - Decision: an explicit refresh disposes the directory's instance only when
    `session.status` shows no busy or retrying session and no dispatch or
    session action from this provider is open. Dispatches wait while the reload
    runs. Otherwise the refresh answers `deferred`, the catalogue reads
    `stale`, and the reload is retried at the next `session.idle` or idle
    `session.status` event, and when this provider's last open dispatch ends
    (`session.command` answers only after its whole turn, so that turn's idle
    edge arrives while the dispatch is still open). A reload bumps the provider's catalogue revision,
    which session snapshots carry, so the backend cache re-reads at once
    (`apps/backend/src/core/opencode-command-reload.ts`).
  - Only an explicit refresh reloads. TTL reads never dispose: disposal also
    restarts the instance's MCP servers and LSP clients and reconnects the
    event stream.
  - Rejected: a "restart OpenCode" message only (leaves the user to restart
    the environment); watching command folders (a container's files are not
    visible to the backend, and global config folders vary); restarting
    `opencode serve` (stops every session at once).
  - A refused disposal still re-reads the list and reports `failed` with a
    message. A failed deferred reload is dropped rather than retried on every
    idle edge.
  - Limit: the gate is per provider instance. A turn started on the same
    server by another client in the few milliseconds between the status read
    and the disposal is not covered; Orkestrator holds one provider per
    environment.
- Never seed or guess rows. A successful empty list stays empty.
- Bindings (skill paths, template bodies, command defaults) stay private to
  the executor; no public payload carries them.
- Catalogue reads are metadata only: no `lastAccessed` touch, no transcript
  hydration, no reattach.
- Keep wire changes additive, and never treat a 404 as proof that a bridge is
  merely old.
- Do not promise parity with a provider's terminal or editor menu. Some of its
  entries run prompts; others drive a terminal, open an editor, change
  settings or replace the session.
- Never alias `/clear` to history deletion, or `/review` to a workflow with a
  different scope from the provider command.
- Out of scope: terminal keystroke injection, re-implementing provider TUIs, a
  generic extension UI host, cross-provider skill conversion, installing
  commands or plugins, and destructive session reset.
- A new tab never shows legacy or guessed rows before its first query.
  Verified against `9906db30` (2026-10-16); the earlier premise that a
  persisted session can lack `providerSessionId` was wrong:
  - The renderer creates the provider session when the tab opens
    (`ensureNativeAgentSession`, `apps/web/src/hooks/useNativeAgentSession.ts:2602`),
    and the Claude bridge's `createSession` makes it without a query
    (`bridges/claude-bridge/src/services/session-manager-core.ts:1576`).
  - A persisted mapping always carries `providerSessionId`
    (`apps/backend/src/core/models.ts:648`). Without one there is no
    projection at all (`resolveProjectionSession` in `native-agent-service.ts`), so the picker
    is empty, and every projection catalogue read passes the session ID
    (`NativeAgentCatalogCache.commandCatalogue` in `native-agent-catalog-cache.ts`, called from `native-agent-transcript-projection.ts`).
  - On the session route, a Claude session with no turn yet gets one
    control-only CLI probe, reported `stale` ("may be out of date"); while that read is in
    flight the picker shows `loading` (`native-agent-command-catalogue.ts:228`).
    Bridge test: "a cold read runs one probe configured like the session's
    turns" (`session-manager-catalog-transport.test.ts`).
  - Backend regression test: "a new tab's catalogue comes from its own session
    before the first prompt, never the global list"
    (`apps/backend/src/core/native-agent-service-commands.test.ts`).
  - Grok follows the same path, so a Grok tab never reads its catalogue
    without a session ID for display. The only read without one is an explicit
    refresh before the session exists; it fails on the ACP bridge's 404 and
    reports `failed` with a `null` projection (see Code item 1).
- What a pre-session tab shows was therefore not changed: nothing until the
  session exists, `loading` during the first read, then the session's own
  probed rows marked `stale` until a turn reads the live inventory. No rows
  are cached across sessions, and `BUILTIN_COMMANDS` is left in place only for
  the legacy route until that route is retired.
- The Claude Tmux tab's fixed `TMUX_BUILTIN_SLASH_COMMANDS` list is a
  separate surface: it forwards text to the real CLI's terminal UI, where those
  commands work (see `platform-inconsistencies.md`). It is not the native
  picker and is out of scope here.

## Open questions

- How long is the legacy window, and does a remote-backend support policy
  constrain it?
- Should inline-shell template compatibility survive at all? The original
  investigation recommended keeping it disabled.

## Needs verification

- Old-backend/new-bridge and old/new renderer projections are now tested with
  transport-level fakes (the `mixed-version:` blocks listed in
  [0015-slash-command-qualification.md](0015-slash-command-qualification.md)).
  They found that a session-route 404 on Claude does not show the 15
  `BUILTIN_COMMANDS` rows: the old global shape (`"/name - description"`) keeps
  only bare names, so every built-in row is dropped and the list is marked
  truncated. A run against a real pre-#827 build is still open there.

## Related

- [0015-slash-command-qualification.md](0015-slash-command-qualification.md) for live
  probes, browser scenarios and performance.
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md) for the
  support-window policy and other compatibility paths awaiting retirement.
- [0017-cli-command-surface.md](0017-cli-command-surface.md) for selected commands from
  the CLI.
- [`native-agent-commands.md`](../../architecture/native-agent-commands.md#provider-support)
  for the per-provider support, unavailable-command and literal-suppression
  tables, and when the legacy route is read ("Lifecycle").

## Replaces

- `docs/improvements/slash-commands.md` (legacy pre-session rows, the
  terminal-menu and aliasing rationale, the inline-shell decision)
- `docs/improvements/slash-commands/plan/00-index.md` (out-of-scope list,
  architectural decisions on additive wire changes and shell templates)
- `docs/improvements/slash-commands/plan/02-command-contract-and-resolution.md`
  (done; contract in `native-agent-commands.md`)
- `docs/improvements/slash-commands/plan/03-dispatch-intent-and-recovery.md`
  (done)
- `docs/improvements/slash-commands/plan/04-catalogue-lifecycle.md` (done)
- `docs/improvements/slash-commands/plan/05-claude.md` (legacy scanner
  retirement, session-changing commands)
- `docs/improvements/slash-commands/plan/06-codex-skills-and-actions.md` (done)
- `docs/improvements/slash-commands/plan/07-codex-template-compatibility.md`
  (inline-shell executor decision)
- `docs/improvements/slash-commands/plan/08-opencode.md` (done)
- `docs/improvements/slash-commands/plan/09-pi.md` (headless extension
  commands)
- `docs/improvements/slash-commands/plan/10-grok-and-cursor.md` (done; the Grok
  re-send probe moves to [0015-slash-command-qualification.md](0015-slash-command-qualification.md))
- `docs/improvements/slash-commands/plan/12-validation-and-rollout.md`
  (mixed-version rollout and legacy retirement)
- `docs/plans/sdk-coverage/06-commands-skills-and-templates.md` (retiring
  `/plugins/commands` and the Claude filesystem scanner, browser QA of picker
  groups and template refresh)
