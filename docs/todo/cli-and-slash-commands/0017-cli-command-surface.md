# CLI command surface

Checked against `main` at `2459b05c` (2026-10-15).

The published `orkestrator` client reaches the backend only through versioned
public actions, all entering the single `public_action` registry command. The
first release left several capabilities out on purpose and advertises them as
unavailable in `capabilities.features`. This file covers adding them without
weakening admission, request keys, receipts or request-specific completion.
One item is a behaviour gap rather than a missing feature: CLI prompt text is
currently treated as typed slash-command intent, so a prompt whose first word
names a provider command runs that command.

## Current state

- Contract: `packages/protocol/src/public-api.ts` (`PUBLIC_ACTIONS`, envelope,
  error codes, `PublicCapabilities`) and `public-api-resources.ts`. Handlers
  are registered in `apps/backend/src/core/public-api/registry.ts`
  (`registerPublicApiCommands`, `publicActionHandlers`). Shipped behaviour is
  documented in [`public-cli.md`](../../architecture/public-cli.md).
- `publicFeatures()` in `registry.ts` returns `transcriptFollow: "poll"`,
  `exec: { local: true, container: true }`, and hard-codes
  `projectCascadeRemove`, `localProjectInit`, `promptAttachments`,
  `selectedSlashCommands` and `enqueue` to `false`.
- `PublicCapabilities["features"]` types those five as the literal `false`,
  and `transcriptFollow` as `"poll" | "unavailable"`. Enabling any of them is
  a protocol type change as well as a registry change.
- `project remove` refuses a project that still has environments (`not-empty`,
  "no cascade") in `public-api/actions-projects.ts`. `project create` wraps
  `createProjectFromScratch` (`apps/backend/src/core/commands-projects.ts`),
  which always creates a private GitHub repository and pushes `main`.
- `session prompt` (`sessionPrompt` in `public-api/actions-sessions.ts`)
  refuses a busy session (`busy`, exit 8) and calls
  `dispatch_native_agent_intent` without `command` or `allowProviderCommands`.
- `planDispatchCommand` in `apps/backend/src/core/native-agent-service.ts`
  treats absent intent on an `interactive-native` session as `typed`. Job tabs
  created by `launch_native_agent_job` (`commands-registry-control.ts`), which
  `session start` uses, are `interactive-native`. So both `session start` and
  `session prompt` send typed intent, and the CLI has no `--literal` option.
- `session transcript --follow --jsonl` polls snapshot pages by cursor. No
  event stream is used.
- There is no `session commands` or `session command` action, no shell
  completion, no declarative apply, and no worker-scoped credential. The
  client never starts a backend.

## Outstanding work

### Code

1. **Selected slash commands from the CLI.**
   - Add `session commands SESSION`, which lists the session's
     `slashCommandCatalogue` (descriptor ID, name, availability, argument
     policy; never private bindings).
   - Add `session command SESSION --command ID|NAME [-- ARGS]`, which submits
     `NativeAgentCommandIntent` `{ kind: "selected", commandId, bindingRevision }`
     through the existing `dispatch_native_agent_intent` path.
   - Add an explicit `--literal` to `session prompt` and `session start`, sent
     as `allowProviderCommands: false`.
   - A stale or unavailable selection fails before dispatch with a stable
     error code and never falls back to prompt text.
   - Done when `selectedSlashCommands` is flipped in the protocol type and
     `publicFeatures()`, `public-cli.md` documents it, and a scenario covers it.
     The command contract itself is in
     [`native-agent-commands.md`](../../architecture/native-agent-commands.md).
2. **Durable enqueue for busy sessions.** Add an explicit `--enqueue` that
   wraps the existing backend-drained native prompt queue
   (`enqueue_prompt_queue_message` in `commands-registry-prompts.ts`, drained
   by `drainPromptQueue` in `native-agent-prompt-queue-dispatcher.ts`).
   - Bind the request key to the queued item, so a replay finds the same item.
   - Follow each provider's `queue` capability (`providerCapabilities` in
     `public-api/providers.ts`) for ordering and availability.
   - Surface provider refusals. For example, Pi answers 409 to a literal
     follow-up it would read as a command.
3. **Prompt attachments.**
   - Define how files move from the client machine to the backend and into the
     workspace, with a lifecycle and size and count bounds.
   - Include an attachment digest in the request fingerprint, so a replay with
     different files conflicts.
   - Never accept a backend host path as an attachment.
4. **Project cascade removal.** A backend-owned, tracked operation that
   deletes each child environment through the normal lifecycle and reports a
   result for each. It never deletes the checkout or the GitHub repository.
5. **Local-only project init.** A new backend initialiser (`git init`,
   initial commit, no remote) separate from `createProjectFromScratch`.
   Credential-free fixtures can already use a local repository with a bare
   origin and `project add`, so this is a convenience, not a test blocker.
6. **Event-stream following** (optional; polling works). A JSONL follow over
   the existing gateway SSE that:
   - reuses the cursor and replay semantics in
     `apps/backend/src/gateway-event-replay.ts` (`GatewayEventReplay`,
     `parseGatewayCursor`);
   - detects gaps and generation changes and resets from a snapshot;
   - bounds frames and buffers, and disconnects a slow consumer explicitly
     instead of dropping events;
   - reports auth expiry and shutdown as observation outcomes.

   This needs a new `transcriptFollow` value in the protocol type.
7. **Worker-scoped credentials.** Explicitly provisioned, scope-limited
   automation credentials following the Control MCP authority patterns
   ([`control-mcp.md`](../../architecture/control-mcp.md)). Never discover an
   operator token automatically from inside a worker.
8. **Low priority, only on demand.**
   - Declarative `apply` or a scenario DSL, once shell composition has proved
     insufficient.
   - Shell completion.
   - Opt-in backend auto-start (see the constraint below).
9. **Optional.** Replace manual gateway `invoke` setup in
   `e2e/agent-testing/browser-gateway.spec.ts` with CLI commands where that
   shortens setup.

### Qualification

- Each new capability needs a case in `packages/cli/scenarios/cases.ts`:
  credential-free where possible, live or container only where behaviour
  depends on it.
- Each needs a browser check in `e2e/agent-testing/cli-ui.spec.ts` when the
  UI must rehydrate the result.
- Keep a capability `false` until both exist. Provider and platform runs are
  tracked in [0014-cli-qualification.md](0014-cli-qualification.md).

## Constraints and rationale

- The CLI is a thin client of the authenticated gateway. A second
  implementation of worktree, Docker, provider or settings persistence in the
  client would duplicate the most delicate code in the application, so new
  features reuse backend services through public actions.
- The gateway was chosen over an MCP client, because MCP lacked tools for
  several operations and would couple basic shell use to MCP session handling.
  It was also preferred over a new HTTP server: the gateway already
  authenticates callers and reaches the same command registry as the web
  client, so a server solely for the CLI would add a listener and no
  capability. Do not add either, and never expose raw registry dispatch.
  Control MCP's gateway keeps this constraint: it dispatches only
  `PUBLIC_ACTIONS` through `public_action`, in-process, and the CLI stays a
  gateway client
  ([0041-control-mcp-voice-surface.md](../mcp/0041-control-mcp-voice-surface.md),
  [control-mcp.md](../../architecture/control-mcp.md#tool-tiers)).
- Auto-start needs process ownership, readiness detection and data-directory
  exclusivity. Starting a second backend over the desktop's data directory is
  never a valid fallback.
- Sessions in one environment share its worktree. `session start` gives
  independent conversations, not filesystem isolation; tasks that need
  isolation use separate environments.
- A completed turn does not prove the requested change. Scripts and scenarios
  assert files or tests separately (for example with `environment exec`).
- Plain text, typed commands, selected commands, steering and queued
  follow-ups keep their distinct intent end to end. Never change the caller's
  intent automatically, for example by turning a busy prompt into a steer.
- Bind every new mutation to the request-key and fingerprint rules, and
  persist before side effects. Never retry ambiguous work under a new key.
- To withdraw a capability, remove its handler from `registry.ts`. The
  operation store and reconciler must keep serving accepted work.

## Open questions

- Should CLI text default to literal, as workflow and mail prompts do, or stay
  typed as it is now by accident of the session's origin?
- Should `session command` be a new action or a flag on `session.prompt`?
- What carries attachment uploads: a new gateway route, or the public action
  with a size limit?

## Needs verification

- That `run retry` of a typed-command prompt replays with the same intent. The
  dispatch plan stores `persistedIntent` (`native-agent-command-dispatch.ts`),
  but no CLI test covers this.

## Related

- [0014-cli-qualification.md](0014-cli-qualification.md) for provider and platform
  evidence.
- [0016-slash-command-catalogue.md](0016-slash-command-catalogue.md) for the catalogue
  the `session commands` listing would read.
- [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md) for
  steering behaviour that `session steer` exposes.
- [`public-cli.md`](../../architecture/public-cli.md),
  [`cli-testing.md`](../../development/cli-testing.md),
  [`remote-gateway.md`](../../architecture/remote-gateway.md).
- Living-doc drift to fix:
  - `public-cli.md` "Retention and expiry" says durability is "the atomic
    temp-file + rename (+ fsync) the other stores use", and that a retired
    namespace's "files are deleted". Since #969 the operation store is the
    logical SQLite store `public-operations/<namespace>` (WAL,
    `synchronous = FULL`; see [`storage.md`](../../architecture/storage.md)).
    "Never delete `public-operations/`" now refers to that logical store.
  - `public-cli.md` "Command surface" omits `orkestrator toolchain install`
    (`packages/cli/src/client/commands/toolchain.ts`), which is documented only
    in `packages/cli/README.md` and
    [`upgrade-agents.md`](../../development/upgrade-agents.md).
  - Neither `public-cli.md` nor `cli-testing.md` says that CLI prompt text is
    typed intent, so `/name …` runs a provider command.
  - The `public-cli.md` header links an implementation record that is being
    deleted; link this file and [0014-cli-qualification.md](0014-cli-qualification.md)
    instead.

## Replaces

- `docs/improvements/cli-commands.md` (design rationale, follow-on features)
- `docs/improvements/cli-commands/plan/00-cli-commands-index.md` (follow-on
  scope list; its outstanding-qualification line moves to
  [0014-cli-qualification.md](0014-cli-qualification.md))
- `docs/improvements/cli-commands/plan/01-public-command-and-compatibility-contract.md`
  (done; contract in `public-cli.md`)
- `docs/improvements/cli-commands/plan/02-client-and-service-entrypoints.md`
  (done)
- `docs/improvements/cli-commands/plan/03-connections-and-authenticated-transport.md`
  (done)
- `docs/improvements/cli-commands/plan/04-shared-actions-and-discovery.md`
  (done)
- `docs/improvements/cli-commands/plan/05-operation-receipts-and-idempotency.md`
  (done)
- `docs/improvements/cli-commands/plan/06-project-commands.md` (local init and
  cascade deferrals)
- `docs/improvements/cli-commands/plan/08-settings-and-concurrent-edits.md`
  (done)
- `docs/improvements/cli-commands/plan/09-sessions-and-prompt-dispatch.md`
  (enqueue and attachment deferrals)
- `docs/improvements/cli-commands/plan/11-session-controls-and-interactions.md`
  (selected slash command deferral)
- `docs/improvements/cli-commands/plan/12-transcripts-and-observation.md`
  (optional event following)
- `docs/improvements/cli-commands/plan/13-environment-command-execution.md`
  (done)
