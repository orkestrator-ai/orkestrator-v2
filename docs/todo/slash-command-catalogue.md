# Slash-command catalogue

Checked against `main` at `2459b05c` (2026-10-15).

The native composer's `/` menu lists only commands the provider reported and
that have a tested executor, and a selected command never turns into ordinary
prompt text. The core shipped in #827 and is described in
[`native-agent-commands.md`](../architecture/native-agent-commands.md). What
remains is the legacy catalogue surface, which still shows guessed Claude rows
to old clients and possibly to pre-session tabs, and a set of command classes
that were left unavailable on purpose and need a decision.

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
  reads the global route directly when it has no session ID. Codex and Cursor
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
- Owner comments quote old pins: `apps/backend/src/core/opencode-commands.ts`
  says OpenCode 1.18.31 (now 1.19.0), `session-manager-commands.ts` says Claude
  Agent SDK 0.3.276 (now 0.3.296), and the comment in
  `bridges/cursor-bridge/src/http.ts` says Cursor SDK 1.0.31 (now 1.0.37).

## Outstanding work

### Code

1. **Retire the legacy catalogue surface.**
   - Agree the mixed-version support window (see
     [mixed-version-compatibility.md](mixed-version-compatibility.md)).
   - Stop pre-session tabs showing guessed rows. Either give them a catalogue
     from an enhanced source, or mark legacy rows display-only and
     unavailable, so the Claude picker never shows `BUILTIN_COMMANDS`.
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
6. **Stale pin comments.** After re-qualification in
   [slash-command-qualification.md](slash-command-qualification.md), update
   the pin facts in the three owner comments above.
7. **CLI selection.** `session commands` and `session command` are tracked in
   [cli-command-surface.md](cli-command-surface.md).

### Qualification

- Browser, on Claude, Pi and Grok fixtures: open the picker and check the
  source groups and keyboard order. Edit a fixture command or template file on
  disk, refresh the catalogue, check the new row appears, then reload and
  check it persists. Batch this with the inactive-environment scenario in
  [slash-command-qualification.md](slash-command-qualification.md).
- Before deleting a legacy route: legacy-route use counts from the support
  window, and a mixed-version run (new backend with an old bridge, old backend
  with a new bridge).

## Constraints and rationale

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

## Open questions

- How long is the legacy window, and does a remote-backend support policy
  constrain it?
- Should inline-shell template compatibility survive at all? The original
  investigation recommended keeping it disabled.

## Needs verification

- Whether a new Claude tab, before its first query, shows the
  `/plugins/commands` rows (including `BUILTIN_COMMANDS`) in the picker. The
  projection reads the `global` key when the persisted session has no
  `providerSessionId`, which suggests it does.
- Whether a Grok tab ever reads the catalogue without a session ID. If it does,
  the adapter requests `/plugins/commands`, which the ACP bridge does not
  serve, so the read fails rather than returning an empty list.
- Whether old-backend/new-bridge and old/new renderer projections are tested.
  Only the backend 404-fallback test in `http-bridge-commands.test.ts` was
  found.

## Related

- [slash-command-qualification.md](slash-command-qualification.md) for live
  probes, browser scenarios and performance.
- [mixed-version-compatibility.md](mixed-version-compatibility.md) for the
  support-window policy and other compatibility paths awaiting retirement.
- [cli-command-surface.md](cli-command-surface.md) for selected commands from
  the CLI.
- [`native-agent-commands.md`](../architecture/native-agent-commands.md#provider-support)
  for the per-provider support, unavailable-command and literal-suppression
  tables, and the pre-session legacy read ("Lifecycle").

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
  re-send probe moves to [slash-command-qualification.md](slash-command-qualification.md))
- `docs/improvements/slash-commands/plan/12-validation-and-rollout.md`
  (mixed-version rollout and legacy retirement)
- `docs/plans/sdk-coverage/06-commands-skills-and-templates.md` (retiring
  `/plugins/commands` and the Claude filesystem scanner, browser QA of picker
  groups and template refresh)
