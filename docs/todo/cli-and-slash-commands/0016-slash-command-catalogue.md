# Slash-command catalogue

Checked against `main` at `8454d18b` (2026-10-24).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

Code items 1 to 10 and both qualification items are done and on `main`
(`0014505c` #1215, `d723429d` #1223, `a3111c7c` #1207). What is left is one
upstream-blocked item and two small verification or hygiene points.

### Tasks

1. **Claude terminal marker** (code item 11): read a terminal marker from `SlashCommand` once the Agent SDK has one, and delete the remembered list. Status: blocked (on the Agent SDK; still absent at 0.3.311).
2. **Codex cold-settle wait in a slow container** (Needs verification): confirm two 1 s re-reads are enough where plugin loading is slower. Status: open.
3. **Real v2.21.0 pairings** (Needs verification): mixed-version run against real old builds. Status: open, owned by 0015 item 1.
4. **Stale OpenCode pin comment**: `opencode-commands.ts` still names 1.19.0 while the pin is 1.19.4. Status: open.

### 1. Claude terminal marker

**Problem.** On a Claude CLI version this bridge home has never run a turn on, the first tab lists terminal-only commands (for example `/focus`) as available; they answer "isn't available here yet" as local output.

**Context.** The bridge works around the missing marker by remembering `terminal_slash_commands` per CLI version (`bridges/claude-bridge/src/services/claude-terminal-commands.ts`, file name at `:23`, `recordTerminalSlashCommands` at `:107`). Documented in `docs/architecture/native-agent-commands.md:225` and `:258`.

**Investigation.** The pin is still Agent SDK `0.3.309` (`bridges/claude-bridge/package.json:16`). Its `SlashCommand` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:9678`) is `{ name, description, argumentHint, aliases?, builtin? }`; `terminal_slash_commands` exists only on the init frame (`sdk.d.ts:6220`). The latest published SDK, 0.3.311 (checked on the registry on 2026-10-27), has the same shape, so the item is still blocked. Nothing in `docs/development/upgrade-agents.md` tells a bumper to look for the marker, so the check depends on someone remembering this file.

**Decisions.**

- **Where should the upstream watch live?**
  - **Move it into the Claude section of `docs/development/upgrade-agents.md` as a per-bump check, then finish and delete this file (recommended).**
    - Pros: the check happens at the moment it can succeed (every SDK bump); the file stops being kept open by an external dependency; the gap is already described in `native-agent-commands.md`.
    - Cons: a one-line checklist entry is easier to skim past than an open todo.
  - **Keep item 11 open here.**
    - Pros: visible in the folder index.
    - Cons: the file never finishes on its own work; the index rating already calls it blocked upstream.
- **Is it worth asking upstream for the marker?**
  - **Yes, file a feature request for a `terminal` flag on `SlashCommand` (recommended).**
    - Pros: the only path that closes the first-tab gap without guessing.
    - Cons: no control over timing.
  - **No; accept the remembered list permanently.**
    - Pros: no external dependency.
    - Cons: the first-tab gap on each new CLI version stays.

### 2. Codex cold-settle wait in a slow container

**Problem.** The settle rule was measured only on a host worktree on Apple Silicon (plugin skills 200 to 400 ms after `initialize`); a slow container could load plugins after the list is judged settled, leaving the picker short of plugin skills until the 30 s TTL read.

**Context.** Decision 9; failure mode is bounded (a stale-looking but healing list, never a guessed row).

**Investigation.** `coldSettleMs: 1_000` and `maxSettleReads: 5` at `bridges/codex-bridge/src/commands/skill-inventory.ts:48` and `:50`. The rule needs two agreeing re-reads, so a slow load that is still changing extends the wait up to five rounds; only a load that pauses for longer than 1 s and then resumes would be missed. No container measurement has been recorded since 2026-10-24.

**Decisions.**

- **Measure, or accept the TTL heal?**
  - **Accept the TTL heal and close the item (recommended).** The two-agreeing-reads rule already adapts to slow loads, and a miss heals in 30 s.
    - Pros: no extra live run; the failure is cosmetic and self-healing.
    - Cons: no container number behind the claim.
  - **Measure `skills/list` timing in a container with plugins installed, and record it.**
    - Pros: evidence for the rule on the slower platform.
    - Cons: needs a container with the host's Codex plugins staged and a live Codex login; costs a run for a self-healing gap.

### 3. Real v2.21.0 pairings

**Problem.** The route retirement rests on the support-window decision plus a 2.16.3 ACP and Cursor run; no real v2.21.0 build has been paired with the current one.

**Context.** Owned by 0015 item 1 and 0034; listed here only as a cross-reference.

**Investigation.** Still open in 0015. Nothing in this file adds to it.

**Decisions.**

- **Keep the cross-reference here?**
  - **No; leave it only in 0015 (recommended).**
    - Pros: one owner; lets this file finish once tasks 1, 2 and 4 are settled.
    - Cons: a reader of this file loses a pointer (the Related section still links 0015).
  - **Keep it here as well.**
    - Pros: the retirement's remaining evidence is visible next to it.
    - Cons: two places to update when 0015 runs.

### 4. Stale OpenCode pin comment

**Problem.** The header comment in `apps/backend/src/core/opencode-commands.ts:9` says its facts come from "the pinned 1.19.0 SDK types", but the pin is `1.19.4` (`apps/backend/package.json:23`).

**Context.** Raised in "Current state" ("not re-checked here"); comment hygiene, not behaviour.

**Investigation.** Re-checked against the installed 1.19.4 v2 SDK: `Command` in `apps/backend/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` is unchanged (`{ name, description?, agent?, model?, source?: "command" | "mcp" | "skill", template, subtask?, hints }`), so the comment's type facts still hold. The server-behaviour facts (case-sensitive lookup, dispose semantics) were not re-read against 1.19.4 source.

**Decisions.**

- **How to fix it?**
  - **Update the comment to "1.19.0, type surface re-checked on 1.19.4" (recommended),** matching the Cursor comment's convention (`bridges/cursor-bridge/src/http.ts:952`).
    - Pros: honest about what was re-checked; one-line change.
    - Cons: still leaves the server facts dated to 1.19.0.
  - **Re-verify the server facts against 1.19.4 and relabel to 1.19.4.**
    - Pros: fully current comment.
    - Cons: needs a private `opencode serve` run for a comment.

The native composer's `/` menu lists only commands the provider reported and
that have a tested executor, and a selected command never turns into ordinary
prompt text. The core shipped in #827 and is described in
[`native-agent-commands.md`](../../architecture/native-agent-commands.md). This
file held the legacy catalogue surface (guessed Claude rows behind a 404
fallback) and a set of command classes left unavailable on purpose. On
2026-10-24 the legacy surface was retired, the deliberately unavailable classes
were decided, the Codex cold-catalogue gap was fixed, and the picker was
qualified live on Claude, Pi and Grok. The only item left is blocked upstream
(item 11).

## Current state

- Every bridge serves the version 1 catalogue (`GET /session/:id/commands`,
  `POST /session/:id/commands/refresh`, `commandRevision` on the session
  snapshot). Wire limits are `COMMAND_CATALOGUE_LIMITS` in
  `packages/protocol/src/agent-command-catalogue.ts`.
- The backend cache (`NativeAgentCommandCatalogueCache` in
  `apps/backend/src/core/native-agent-command-catalogue.ts`) has a TTL of
  30 s, 256 keys, 16 MiB, 4 concurrent provider reads and 5 s to 5 min retry
  backoff. Keys come from `commandCatalogueKey`.
- **No legacy surface.** `HttpBridgeCatalogAdapter.commandCatalogue`
  (`apps/backend/src/core/http-bridge-catalog.ts`) reads only the session
  route. Without a session it makes no request and answers `missing`. A 404
  (a bridge older than the 2.21.0 contract: before #599, or a pre-2.21 Pi,
  Cursor or Grok bridge that does not hold the session) throws with
  `catalogueErrorCode: "outdated-bridge"`, a new additive error code
  (`NATIVE_AGENT_COMMAND_CATALOGUE_ERROR_CODES`), so the catalogue reads
  `unavailable` with "restart the environment, or rebuild a container". The
  picker explains it (`useNativeCommandComposer.tsx`).
- Each such 404 is counted per agent (`outdatedBridgeCatalogueReadCounts`),
  and each provider instance logs one warning with the running count and no
  command names or session ids. Each read also records the persistent
  `slash-catalogue.outdated-bridge` counter exposed by 0034.
- Deleted: `bridges/claude-bridge/src/services/slash-commands.ts` (the
  filesystem scan and the 15-row `BUILTIN_COMMANDS` list) and its tests; the
  `GET /plugins/commands` routes on the Claude and Pi bridges; the
  `GET /global/slash-commands` routes on Codex (with `listGlobalCommandRows`
  and `listTemplateAndBuiltinRows`) and Cursor. `GET /plugins` (plugin
  discovery) is unchanged. All five now answer 404 on the retired paths, as
  the ACP bridge always did.
- `refreshProjectionCommands` (`native-agent-service.ts`) returns `failed`
  ("The agent session has not started yet…") with a `null` projection when no
  session is stored, without starting or reading the provider.
- A pre-2.21 bridge that answers the session route with rows and no
  `catalogueVersion` still works: its rows are non-enhanced `legacy:` rows that
  run as typed text.
- **Codex cold plugin skills.** `SkillInventory`
  (`bridges/codex-bridge/src/commands/skill-inventory.ts`) reports the first
  `skills/list` answer from each app-server generation unsettled; the
  catalogue reads `stale` for at least two re-reads, each sent 1 s after the
  preceding answer (`coldSettleMs`). The second or later re-read must agree
  with the answer that armed its delay (at most `maxSettleReads` rounds),
  which settles it and bumps `commandRevision`. An explicit refresh cannot
  replace that baseline. A read already in flight when
  the timer fires never settles it, and a failed settling read leaves it
  `stale`. A generation that dies first never marks its successor settled.
- Disabled by design, listed with a reason and never executed (now decided,
  see "Assumptions and decisions"):
  - Claude, in `bridges/claude-bridge/src/services/session-manager-commands.ts`:
    `SESSION_CHANGING_COMMANDS` (`/clear`, `/model`, `/permissions`,
    `/resume`), `INTERACTIVE_COMMANDS` (`/login`, `/logout`) plus the init
    `terminal_slash_commands`, and `UNQUALIFIED_COMMANDS`. The bridge also
    refuses these as typed text.
  - Codex templates containing inline shell spans: `requires-shell-execution`
    in `bridges/codex-bridge/src/prompts/template-discovery.ts`.
- Pi extension commands are listed with `busy: "idle"`
  (`bridges/pi-bridge/src/commands.ts`) and run headless: `ctx.hasUI` is
  `false` and every dialog answers at once with no answer. That is pinned
  against the real SDK runner at 1.4.0
  (`bridges/pi-bridge/src/extension-headless-ui.test.ts`). The turn always ends
  with an outcome row (`settleCommandRun`).
- Orkestrator's own shortcuts are `/steer` (reserved) and `/compact` (defers to
  a provider `/compact`), merged by `withSessionActionSlashCommands` in
  `packages/protocol/src/agent-slash-commands.ts`. No others are planned.
- The picker groups rows by `source` (`groupSlashCommandRuns` in
  `apps/web/src/lib/chat/slash-command-search.ts`, rendered by
  `SlashCommandMenu.tsx`), now also covered live by
  `e2e/agent-testing/slash-command-picker.spec.ts`.
- Owner comments as of 2026-10-24: Claude `session-manager-commands.ts` names
  Agent SDK 0.3.309 (the pin); Cursor's `http.ts` names 1.0.37, type surface
  re-checked on 1.0.40 (the pin); `opencode-commands.ts` names 1.19.0 while the
  pin is 1.19.4 (not re-checked here).

## Outstanding work

### Code

1. **Retire the legacy catalogue surface.** Done 2026-10-24.
   - Support window: the original path-specific decision (decision 1) is
     now covered by the shared window decided in
     [0034](../cross-cutting/0034-mixed-version-compatibility.md): published
     releases from v2.21.0 today. Pre-#599 and pre-#827 peers are outside it.
   - The 404 fallback is gone: a 404 reads `unavailable` with
     `outdated-bridge` (`http-bridge-catalog.ts`). Tests:
     `http-bridge-commands.test.ts` ("a 404 from a bridge older than the
     contract is outdated-bridge, counted, never a global list", and per
     bridge "a session-route 404 is outdated-bridge per read, never a global
     list, never sticky"), `http-bridge-provider.test.ts`,
     `native-agent-command-catalogue-scale.test.ts`.
   - `refreshProjectionCommands` skips the provider when no session is stored
     (`native-agent-service-commands.test.ts`: "a refresh before the session
     exists reads nothing and says so").
   - Rejected outdated-bridge reads are counted without command names
     (above), including the persistent `slash-catalogue.outdated-bridge` counter.
   - Deleted `services/slash-commands.ts`, the Claude and Pi
     `/plugins/commands` routes, the Codex and Cursor `/global/slash-commands`
     routes and the global fallback. Each bridge's route tests now assert the
     404 (`plugins.test.ts`, `pi-bridge/src/http.test.ts`,
     `codex-bridge/src/index-routes.test.ts`, `cursor-bridge/src/http.test.ts`).
   - `GET /plugins` kept.
2. **Claude session-changing commands.** Decided 2026-10-24: they stay
   unavailable (decision 5). No code change; the architecture doc says so.
3. **Codex inline-shell templates.** Decided 2026-10-24: kept disabled for
   good, no executor will be built (decision 6). `requires-shell-execution`
   stays.
4. **Pi extension commands.** Done 2026-10-24 (decision 7): the bounded
   "unsupported interaction" result is the answer, and it already existed
   (`settleCommandRun`). Pi 1.4.0 gives a command no "needs UI" marker, so
   labelling is impossible without guessing; `hasUI` is never faked. Pinned by
   `extension-headless-ui.test.ts`.
5. **Further Orkestrator shortcuts.** Decided 2026-10-24: none (decision 8).
6. **Stale pin comment.** Done 2026-10-23: the Cursor comment names 1.0.37,
   whose declarations were re-checked.
7. **CLI selection.** Owned by
   [0017-cli-command-surface.md](0017-cli-command-surface.md); nothing left
   here.
8. **Claude terminal-only commands before the first turn.** Done
   2026-10-17; see "Constraints and rationale".
9. **Codex plugin skills in a cold catalogue.** Done 2026-10-24 (decision 9).
   Measured live on Codex 0.164.0 with the host's plugins: the first reads
   after `initialize` returned 26 skills (8 from plugins) for 100-300 ms, then
   114 (96 from plugins), with no `skills/changed`; a first read at 1 s or
   later was already complete. Fix and tests: `skill-inventory.ts`,
   `codex-command-catalogue.test.ts` ("a cold app-server child").
10. **OpenCode command files added while the server runs.** Done
    2026-10-17; see "Constraints and rationale".
11. **Claude terminal marker (blocked upstream).** Re-checked 2026-10-24 at
    Agent SDK 0.3.309: `SlashCommand` is still `{ name, description,
    argumentHint, aliases?, builtin? }`, with no terminal marker. If the SDK
    adds one, read it from the probe's rows and delete the remembered list in
    `claude-terminal-commands.ts`, which closes the first-tab-on-a-new-CLI-
    version gap described in "Constraints and rationale".

### Qualification

- **Browser, on Claude, Pi and Grok.** Done 2026-10-24 with
  `e2e/agent-testing/slash-command-picker.spec.ts` (decision 11), profile
  `qa-picker-0016` (`--fixture --credential-source claude --credential-source
  pi --credential-source grok`), host worktrees with
  `projectResources: true`, this branch's code. Final run of all three: 3
  passed, 0 skipped, 34.2 s, no model turn (an earlier run that attached Pi
  with one short turn also passed).

  | Provider | Groups shown (rows) | Refresh after adding a file | New row after reload |
  | --- | --- | --- | --- |
  | Claude (CLI 2.1.309) | Orkestrator (1), Other (53): the cold probe reports no sources | `reread`; listed | Yes |
  | Pi (SDK and CLI 1.4.0) | Orkestrator (2), Templates (2), after the menu's "Refresh commands" attached the session | `reloaded`; listed | Yes |
  | Grok (1.0.67) | Other (14; 34 in an earlier run): Grok reports no sources | `reread`; listed by push within 4 s | Yes |

  Keyboard order passed on all three: arrows followed the rendered order
  across group boundaries and clamped at both ends. Found on the way: a new Pi
  tab lists no provider commands until its session attaches (first turn, or
  the menu's "Refresh commands"); tracked as
  [0069](0069-pi-commands-before-first-turn.md), fixed on 2026-10-25 (it now
  lists its templates and skills before attach). Not batched with the
  inactive-environment scenario in 0015 (decision 11).
- **Before deleting a legacy route.** Done as far as this machine allows
  (decisions 1 and 12): no production counts exist (none are collected
  anywhere; 0034 item 3), so the deletion rests on the window decision and on
  a real-build mixed-version run. The real ACP and Cursor bridges from
  `ff4026b4e^` (2.16.3) ran beside the current ones and were read through each
  side's real adapter. Current backend with old bridge: one request, 404,
  `unavailable` with `outdated-bridge`, counted, no legacy route read. Old
  backend with current bridge: an unknown session answered 200 with an empty
  list (no fallback); a read without a session got 404 from the retired
  global route, which the old backend shows as an error with no rows.

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
- Keep wire changes additive. A 404 on the session route never selects
  another route's rows: it means an older bridge, one that predates the route
  or a pre-2.21 bridge that does not hold the session, so it reads
  `outdated-bridge` and is re-checked on the next read.
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
    refresh before the session exists, which since 2026-10-24 reports
    `failed` without reading anything (Code item 1).
- What a pre-session tab shows was therefore not changed: nothing until the
  session exists, `loading` during the first read, then the session's own
  probed rows marked `stale` until a turn reads the live inventory. No rows
  are cached across sessions. `BUILTIN_COMMANDS` and the legacy route were
  deleted on 2026-10-24.
- The Claude Tmux tab's fixed `TMUX_BUILTIN_SLASH_COMMANDS` list is a
  separate surface: it forwards text to the real CLI's terminal UI, where those
  commands work (see `platform-inconsistencies.md`). It is not the native
  picker and is out of scope here.


## Open questions

- Both earlier questions are answered in "Assumptions and decisions": the
  legacy window (decision 1) and inline-shell templates (decision 6).
- None open.

## Needs verification

- Real v2.21.0 bridge, backend and renderer pairings remain open in
  [0015](0015-slash-command-qualification.md) item 1. The shared support
  window now excludes pre-#827 builds; the ACP and Cursor run remains
  additional evidence for the rejected 404 path.
- The Codex settle wait (2 s) was measured on a host worktree on Apple
  Silicon, where plugin skills arrived 200-400 ms after `initialize`. A slower
  container could take longer; the 30 s TTL read still heals it, as before.

## Assumptions and decisions

Made on 2026-10-24 while completing this file.

1. **Support window for the legacy catalogue path.**
   - Options: (a) wait for the shared window in 0034; (b) decide a window for
     this path alone and retire now; (c) keep the fallback but show its rows as
     display-only and unavailable.
   - Chosen: (b). The window is "the 2.21.0 contract plus seven minor
     releases": #827 shipped in 2.21.0 (2026-09-23) and `main` is 2.28.0-beta.
     The fallback and all four bridge routes were deleted.
   - Why: the fallback's rows were never the session's. A 404 meant an old
     bridge either without the route or without the session, so the old
     fallback showed a global list for a session the bridge did not hold, and
     0015 showed the Claude global shape survived only as bare names. Every
     bridge since #599 serves the session route, so the only new-backend
     pairing that lost anything is a container still running a pre-2.21
     image, which now gets a clear "restart or rebuild" message instead of
     guesses.
   - Pros: no guessed rows anywhere, one read path, less code (a scanner, four
     routes, two runtime methods). Cons: an old backend (2.20 or older) sharing
     the `orkestrator-v2:latest` image with a newer one loses its pre-session
     list (it errors instead); there is no production count behind the date;
     this was originally a path-specific decision. The shared window was
     subsequently decided in 0034, with v2.21.0 as its current floor.
2. **How a 404 is reported.**
   - Options: keep falling back; `unsupported`; `unavailable` with
     `provider-error`; `unavailable` with a new `outdated-bridge` code.
   - Chosen: `unavailable` with `outdated-bridge`.
   - Why: `unsupported` says the provider has no commands, and
     `provider-error` blames the provider; neither tells the user to restart.
     The code is additive.
   - Pros: an accurate, actionable message; the cache's per-read retry picks
     up a bridge upgraded in place. Cons: an older renderer shows the generic
     "Commands couldn't be loaded." with no detail for the unknown code.
3. **Counting legacy use.**
   - Options: production telemetry (none exists); a backend in-memory counter
     plus a log line; keeping the bridge routes only to count hits.
   - Chosen: a per-agent in-memory counter
     (`outdatedBridgeCatalogueReadCounts`) and one warning per provider
     instance with the running count, no command names, no session ids.
   - Why: content-free, bounded, and it counts the only pairing that still
     matters (new backend, old bridge).
   - Pros: evidence in the backend log of every affected install. Cons: resets
     on restart. The merged implementation also persists each rejected read
     as `slash-catalogue.outdated-bridge` through 0034's diagnostics command
     and metrics; an old backend hitting a new bridge is not counted here.
4. **Refresh before a session exists.**
   - Options: keep reading the global route; answer `reread`; answer
     `unsupported`; answer `failed` with a message and read nothing.
   - Chosen: `failed`, "The agent session has not started yet, so there are
     no commands to refresh.", projection `null`, provider not started. Agents
     without slash commands still answer `unsupported`.
   - Why: nothing was refreshed, and the projection is `null` anyway.
   - Pros: no wasted Claude filesystem scan or Grok 404, no provider start.
     Cons: none found; the renderer already shows a failed refresh's message.
5. **Claude session-changing commands.**
   - Options: keep them unavailable; let the bridge adopt the new conversation
     id and configuration after `/clear`, `/model`, `/permissions` or
     `/resume` and reconcile before the next submission.
   - Chosen: keep them unavailable.
   - Why: each has a native control already (model and permission pickers in
     the composer, a new tab, session history). Adopting a CLI-side session
     replacement would change the tab's identity under the transcript,
     dispatch journal and queue, and no qualified path supports that.
   - Pros: no new state machine, nothing can lose history. Cons: terminal
     users' muscle memory (`/model x`) is refused with a reason rather than
     honoured.
6. **Codex inline-shell templates.**
   - Options: build the policy-reviewed executor described in item 3; keep
     them disabled for good.
   - Chosen: disabled for good.
   - Why: templates are an Orkestrator compatibility feature, not a Codex
     one; an executor adds a shell surface (argument injection, approvals,
     at-most-once across retries) that skills already cover through Codex's
     own tool approvals. The original investigation recommended the same.
   - Pros: no new shell surface. Cons: templates written for the Codex CLI's
     `` !`cmd` `` stay listed but unusable here.
7. **Pi extension commands that need a UI.**
   - Options: label every extension command unavailable; guess from source
     (scan for `ctx.ui`); bind a recording UI context (fakes `hasUI`); patch
     Pi's private no-UI context; return a bounded result after the run.
   - Chosen: the bounded result, which `settleCommandRun` already writes, plus
     a pin test against the real SDK runner.
   - Why: Pi 1.4.0's `RegisteredCommand` has no "needs UI" marker (the test
     asserts its keys), so any label is a guess; binding any UI context flips
     `hasUI` to `true`.
   - Pros: headless-safe extension commands keep working (qualified live on
     1.2.0); a pin bump that changes the contract fails a test. Cons: a
     command that needed a dialog is only explained after it ran.
8. **Further Orkestrator shortcuts.**
   - Options: clear or new session, `/model`, `/permissions`, `/review`;
     none.
   - Chosen: none.
   - Why: each duplicates a composer control or a launcher, and a `/review`
     alias would run a workflow with a different scope from the provider's
     own command, which the constraints forbid. Any future shortcut needs its
     own todo with qualified semantics.
   - Pros: the menu keeps meaning "what the provider runs". Cons: no slash
     path to those actions.
9. **Codex cold plugin skills.**
   - Options: wait for a notification (none exists); force a disk rescan on
     the first read; report the first answer `stale` and re-read once after a
     delay; poll until two reads agree.
   - Chosen (revised 2026-10-24): each app-server generation's list is
     unsettled (`stale`) for at least two ordinary re-reads, each sent 1 s
     after the preceding answer. The second or later re-read must agree with
     the answer that armed its delay, at most five rounds. The first version
     re-read once after 2 s and trusted that answer; review found a read
     already in flight when the timer fired could stand in for it and settle
     the pre-plugin list, and a single fixed delay has no margin on a slow
     container.
   - Why: measured, the gap is time-based (a single first read at 1 s was
     complete), so in the measured case the list settles about 2 s after the
     child starts, as before, for two extra `skills/list` calls per child
     start. A changed list takes more rounds to confirm. Plugin loading after
     the list has settled or the five-round limit relies on the 30 s TTL
     (or a notification) for recovery.
   - Pros: the picker preserves at least a two-second observation window; the revision
     bump reaches unmounted tabs. Cons: about 2 s of "may be out of date"
     after a child starts even when the first list was complete. A typed
     `$skill` is unaffected (it checks `fresh`, not `settled`).
10. **Claude terminal marker.** No decision possible: re-checked at 0.3.309,
    still absent upstream. Item 11 stays open and blocked.
11. **How to qualify the picker.**
    - Options: extend `slash-command-inactive.spec.ts`; a new metadata-only
      spec.
    - Chosen: a new spec, `slash-command-picker.spec.ts`, sharing the
      profile, login, sidebar and worktree helpers with the inactive spec
      through `slash-command-live-support.ts`.
    - Why: the inactive scenario spends real model turns and supports only
      Codex and Claude; these checks need no turn, so they run in about 30 s
      for all three providers. The "batch with the inactive scenario" note is
      therefore not followed.
    - Pros: cheap to re-run on every pin bump. Cons: one more opt-in spec; the
      group check is weak on Claude and Grok, which report no sources.
12. **Mixed-version evidence before deleting the routes.**
    - Options: fakes only; a real old build of every bridge; a real old build
      of the bridges that need no credentials to answer the catalogue.
    - Chosen: real `ff4026b4e^` ACP and Cursor bridges against this backend's
      adapter, and the old adapter against the current bridges.
    - Why: those two exercise exactly the paths this change touches (the 404
      and the retired route) without provider sign-in; the old ACP bridge
      could not create a session against today's Grok CLI.
    - Pros: real processes on both sides. Cons: Claude, Codex and Pi old
      builds were not run.

Assumptions:

- Bridges reach containers only through the image (`/opt/*-bridge`), and the
  image tag `orkestrator-v2:latest` is shared by installs on one host; that is
  the only way an old backend meets a new bridge.
- No client outside the backend reads `/plugins/commands` or
  `/global/slash-commands`: a search of the renderer, CLI, `apps/web-public`,
  desktop and iOS sources found none.

## Related

- [0015-slash-command-qualification.md](0015-slash-command-qualification.md)
  for live probes, browser scenarios and performance.
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md)
  for the shared support-window policy and other compatibility paths awaiting
  retirement.
- [0017-cli-command-surface.md](0017-cli-command-surface.md) for selected
  commands from the CLI.
- [0069-pi-commands-before-first-turn.md](0069-pi-commands-before-first-turn.md)
  for the Pi gap the picker run found.
- [`native-agent-commands.md`](../../architecture/native-agent-commands.md#provider-support)
  for the per-provider support, unavailable-command and literal-suppression
  tables, and the catalogue lifecycle.

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
