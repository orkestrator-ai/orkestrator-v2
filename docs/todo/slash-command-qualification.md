# Slash-command qualification

Checked against `main` at `2459b05c` (2026-10-15).

Every slash-command executor was qualified from installed SDK declarations and
source, then exercised through each integration's real execution path with
transport-level fakes. No live provider session, isolated profile or real
browser was used, and every recorded pin has since moved. This file collects
the provider and UI evidence needed before the feature can be called complete.
Failures found here become code items in
[slash-command-catalogue.md](slash-command-catalogue.md).

## Current state

- The per-provider support, unavailable-command and literal-suppression tables
  are in [`native-agent-commands.md`](../architecture/native-agent-commands.md#provider-support).
  They were qualified on 2026-09-23 from source and fakes, and the pins they were
  read from are stale:

  | Provider | Recorded pin | Current pin |
  | --- | --- | --- |
  | Claude | Agent SDK 0.3.276 / CLI 2.1.276 | Agent SDK 0.3.296 / CLI 2.1.296 |
  | Codex | app-server 0.155.0 | 0.162.1 |
  | OpenCode | SDK and CLI 1.18.31 | 1.19.0 |
  | Pi | SDK and CLI 0.85.1 | 1.2.0 (major upgrade) |
  | Grok | build 1.0.34 / ACP SDK 1.4.0 | build 1.0.52 / ACP SDK 1.8.0 |
  | Cursor | SDK 1.0.31 | SDK 1.0.37 |

  Current pins come from `bridges/claude-bridge/package.json`,
  `bridges/pi-bridge/package.json`, `bridges/acp-bridge/package.json`,
  `bridges/cursor-bridge/package.json`, `apps/backend/package.json`
  (`@opencode-ai/sdk`) and the `*_VERSION` build arguments in
  `docker/Dockerfile`.
- The composer is covered by component tests only:
  `apps/web/src/components/chat/SlashCommandMenu.test.tsx`,
  `apps/web/src/hooks/useSlashCommandMenu.test.tsx`,
  `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` and
  `apps/web/src/hooks/useNativeAgentSession.commands.test.tsx`.
- No e2e spec runs a slash command in a native tab.
  `e2e/ComposerMenuPlacement.spec.ts` checks only the menu's height on a
  fixture page, and the steering test in
  `e2e/agent-testing/browser-gateway.spec.ts` covers build-pipeline steering
  (#919), not `/steer` from the composer.
- `dev:test` starts Electron and needs a display. The 2026-09-23 attempt failed
  with "Missing X server or $DISPLAY".

## Outstanding work

### Qualification

1. **Live probes at current pins**, for every provider, with synthetic project
   and user commands in a disposable isolated profile:
   - cold discovery before the first turn and after one turn;
   - invocation through the real path, with proof that the command ran (a
     model's claim is not proof);
   - one command with no model output and one unavailable command: completion,
     hang, or an unintended model turn;
   - an inventory change while the session exists: push, explicit refresh,
     idle read, detach and reattach, and restart.

   Provider-specific questions:
   - Claude: does the probe configuration (MCP servers, plugins) match the live
     query? Probe results are reported `stale` because they lack the live
     query's MCP servers. What are the `/compact` and local-output command
     lifecycles?
   - Codex: what are the enabled, disabled and duplicate skill semantics? Does
     a cold `skills/list` work without resuming threads?
   - OpenCode: how long does a `session.command` response take (it answers only
     after the whole turn), do command agent and model defaults interact
     correctly with explicit selections, and does the server still substitute
     `$ARGUMENTS` before running a template's `` !`cmd` `` spans?
   - Pi 1.2.0: extension-before-template precedence, headless extension
     completion, whether `reload()` is still unsafe mid-turn, and the literal
     opt-out (`expandPromptTemplates: false`).
   - Grok: does it re-send `available_commands_update` after `session/load`,
     and does the slash text reach `session/prompt` unchanged?
   - Cursor 1.0.37: confirm there is still no discovery or invocation API.
2. **Inactive-environment browser scenario** (required before calling the
   feature complete):
   - Create sessions A and B. Start a fixture command in A, then switch to B
     before it is accepted.
   - While A is inactive, change its inventory, let the command complete or
     ask a question, and interrupt the event stream long enough to need
     reconciliation.
   - Return to A and check the result, the new inventory, stale-draft handling
     and enabled controls. Then reload.
   - Repeat with a bridge or backend restart at a controlled dispatch
     boundary. No command may run twice.
   - Check that a catalogue refresh does not keep an idle session attached or
     load its transcript.
   - Run on local worktrees and, where available, containers. Check desktop
     and narrow viewports.
3. **Containers.** Check that skill and template paths resolve inside the
   provider's environment, not on the host or in the renderer.
4. **Mixed-version matrix.** New backend with an old bridge, old backend with
   a new bridge, and old and new renderer projections, within the support
   window decided in [slash-command-catalogue.md](slash-command-catalogue.md).
5. **Performance**, with synthetic large inventories:
   - cold and warm discovery latency (p50 and p95);
   - refresh coalescing;
   - retained catalogue bytes against the 16 MiB cache budget
     (`COMMAND_CATALOGUE_MAX_BYTES`);
   - provider probe count.

   Opening the picker must not trigger a provider process or filesystem scan
   per keystroke. Report measured numbers; do not set latency claims in
   advance.
6. After a pass, update the qualification paragraph and tables in
   `native-agent-commands.md` "Provider support" (pins, and drop the "no live
   session" caveat for what passed), and the owner comments listed in
   [slash-command-catalogue.md](slash-command-catalogue.md).

## Constraints and rationale

- Mocks do not confer support. A category that is not qualified stays
  unavailable with a reason.
- Use disposable provider homes and the profile's fixture project, never this
  repository or production sessions.
- Do not commit raw provider recordings. Codex recordings go through
  `scripts/scrub-codex-recording.ts` and a manual review.
- Diagnostics may record operation class, provider, counts, latency and
  allowlisted error codes. Never log command names, arguments, skill or
  template paths, prompts or file contents.
- Do not describe a release as "full slash-command parity"; name the provider
  surfaces that were qualified.

## Open questions

- Should qualified rows be re-probed after every agent SDK or CLI upgrade? See
  [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).

## Needs verification

- Whether any of these runs happened informally after #827. No artifacts or
  records were found.

## Related

- [slash-command-catalogue.md](slash-command-catalogue.md) for code items and
  the legacy-route retirement this matrix gates.
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
  for credentials, profiles and batching with other provider runs.
- [mixed-version-compatibility.md](mixed-version-compatibility.md).
- [`native-agent-commands.md`](../architecture/native-agent-commands.md),
  [`agent-testing.md`](../development/agent-testing.md),
  [`testing-guide.md`](../development/testing-guide.md).

## Replaces

- `docs/improvements/slash-commands/plan/01-qualify-provider-contracts.md`
  (live probes, items 4 to 7, and the provider questions)
- `docs/improvements/slash-commands/plan/11-composer-and-command-feedback.md`
  (the real-browser cycle; the composer work is done)
- `docs/improvements/slash-commands/plan/12-validation-and-rollout.md`
  (inactive-environment scenario, containers, mixed versions, performance)
- `docs/improvements/slash-commands/plan/10-grok-and-cursor.md` (the Grok
  `session/load` re-send probe)
- `docs/improvements/slash-commands/qualification.md` (support, unavailable
  and literal-suppression tables and design findings moved to
  `native-agent-commands.md`; blocked live probes are items 1 and 2 above;
  the branch validation run was dropped)
