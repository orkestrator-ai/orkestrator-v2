# CLI command surface

Checked against `main` at `ba7cc8d4` (2026-10-25).

The published `orkestrator` client reaches the backend only through versioned
public actions, all entering the single `public_action` registry command. The
first release left several capabilities out on purpose and advertised them as
unavailable in `capabilities.features`. This file covers adding them without
weakening admission, request keys, receipts or request-specific completion.

On 2026-10-25 selected slash commands (with explicit `--literal`), durable
enqueue, prompt attachments, cascade project removal, local-only project init
and shell completion shipped, and the typed-intent behaviour is now documented
and controllable. What is left is optional or deferred: event-stream
following, worker-scoped CLI credentials, declarative `apply` and backend
auto-start.

## Current state

- Contract: `packages/protocol/src/public-api.ts` (`PUBLIC_ACTIONS`, envelope,
  error codes, limits, `PublicCapabilities`), `public-api-inputs.ts` and
  `public-api-resources.ts`. Handlers are registered in
  `apps/backend/src/core/public-api/registry.ts`. Shipped behaviour is in
  [`public-cli.md`](../../architecture/public-cli.md).
- `publicFeatures()` returns `transcriptFollow: "poll"`, `exec`, and `true` for
  `projectCascadeRemove`, `localProjectInit`, `promptAttachments`,
  `selectedSlashCommands` and `enqueue`. `PublicCapabilities["features"]` types
  those five as `boolean` (they were the literal `false`).
- New actions: `session.commands` (read), `session.command` (run) and
  `project.init` (receipt). New inputs: `literal` and `attachments` on
  `session.start`; `literal`, `enqueue` and `attachments` on `session.prompt`;
  `enqueue` on `session.command`; `cascade` on `project.remove`. Each optional
  field is absent from the fingerprinted intent when unset, so receipts admitted
  before this change still replay.
- Shared delivery helpers: `public-api/prompt-delivery.ts` (literal, attachment
  parsing, digests and staging, enqueue). Selected commands:
  `public-api/actions-session-commands.ts`. Queued runs settle in
  `run-observer.ts` (`evaluateQueuedRun`). Cascade and init:
  `public-api/actions-projects.ts`, `initLocalProject` in
  `commands-projects.ts`, and the local-only start point in
  `resolveRemoteWorktreeStartPoint` (`commands-files.ts`). `project.remove`
  has its own reconciler.
- CLI: `session commands`, `session command`, `--literal`, `--enqueue`,
  `--attach`, `project init`, `project remove --cascade [--wait]` and the local
  `completion bash|zsh|fish` (`packages/cli/src/client/commands/completion.ts`).
- `session transcript --follow --jsonl` still polls snapshot pages by cursor.
  There is no worker-scoped credential, no declarative apply, and the client
  never starts a backend.

## Outstanding work

### Done (2026-10-25)

1. **Selected slash commands from the CLI.** Done.
   - `session commands SESSION [--refresh]` lists the cached catalogue (merged
     with Orkestrator's session actions, as dispatch sees it): ID, name,
     aliases, bounded description and hint, source, `bindingRevision`,
     availability with reason, argument and busy policy. No execution kind,
     origin, skill path or template is exposed; `/steer` is left out
     (`session steer` is its public form).
   - `session command SESSION --command ID|NAME [--expected-binding-revision R]
     [--enqueue] [-- ARGS]` resolves an exact ID, else exactly one name or
     alias (with or without `/`/`$`), and submits
     `{ kind: "selected", commandId, bindingRevision }` through
     `dispatch_native_agent_intent`.
   - `--literal` on `session prompt` and `session start` sends
     `command: { kind: "literal" }`, which `planDispatchCommand` maps to
     `allowProviderCommands: false` (the registry's input parser keeps
     `command` and drops a bare `allowProviderCommands`). `launch_native_agent_job`
     accepts `literal: true` for the first prompt.
   - Stale or unavailable selections fail before admission with stable codes
     (`not-found`, `ambiguous-target`, `revision-conflict`,
     `capability-unavailable`, `invalid-input`, `busy`); one that vanishes
     between admission and dispatch fails the run (`operation-failed`,
     dispatch `rejected`). Nothing falls back to prompt text.
   - Evidence: `public-api-command-surface.test.ts` (listing, refusals,
     vanished-at-dispatch, literal and its Claude refusal, typed default);
     `command-surface.test.ts` (CLI inputs); live Claude `live-session`
     2026-10-25 (`/context` selected and completed; unknown → exit 3; stale
     binding → exit 8; `--literal` completed). See the
     [0014 evidence log](0014-cli-qualification.md#evidence-log).
2. **Durable enqueue for busy sessions.** Done. `--enqueue` on `session prompt`
   and `session command` calls `enqueuePromptQueueMessageIfAbsent` with the
   operation ID as the queue item ID and dispatch request ID, then wakes the
   drainer. A replay returns the same operation and finds the same item. The
   run is `running`/`queued` with `dispatch: pending`; `evaluateQueuedRun`
   settles it from the queue (read first) and the dispatch journal: still held
   → pending; journaled → normal observation; parked → unknown; refused at
   dequeue (`dispatchError`, for example Pi's 409) → `failed` with the
   provider's reason; removed unsent → `cancelled`; restarted before the item
   was written → `interrupted`. Providers whose `queue` capability is false
   refuse with `capability-unavailable` (all six currently report `true`).
   Ordering is the queue's FIFO. Evidence: unit tests (queue identity, replay,
   drain, provider refusal, removal, queued selection) and live Claude (a plain
   prompt refused busy; the queued prompt completed after a running `sleep 20`
   turn).
3. **Prompt attachments.** Done. Files travel inside the public action
   (`attachments: [{ name, type?, dataBase64 }]`), at most 8 files and 256 KiB
   decoded in total (`PUBLIC_API_LIMITS.promptAttachments*`). Names must not
   contain directories; there is no path field. Name, type, size and SHA-256
   are fingerprinted, never the bytes. After admission the backend writes them
   to `.orkestrator/prompt-attachments/<operation ID>/` in the workspace
   (`write_local_file` / `write_container_file`) and attaches those paths; they
   go with the workspace. Provider attachment support is checked first.
   Evidence: unit tests (staging, paths, conflict on changed bytes, refusals,
   no content in the record) and live Claude (the agent quoted the attached
   file). Live OpenCode too since 2026-10-26, local and container, after
   [0166](0166-opencode-prompt-attachment-never-dispatched.md) fixed the
   file part's MIME type.
4. **Project cascade removal.** Done. `project.remove` with `cascade: true`
   (operator authority only) deletes the environments reviewed at admission one
   by one through `delete_environment`, records a bounded per-environment result
   in the operation, and removes the registration only if all were deleted;
   otherwise `partial`, project kept and unfenced. Backend-owned through
   `runWithContinuation`; `reconcileProjectRemove` settles it after a restart.
   Never touches the checkout or remote. Evidence:
   `public-api-project-init-cascade.test.ts`, the `project-cascade` scenario
   (local) and the `cli-ui.spec.ts` browser check.
5. **Local-only project init.** Done. `project init --path P` (`project.init`,
   `initLocalProject`): `git init -b main`, one empty Orkestrator commit, no
   remote, registered with `gitUrl` = the checkout path; resumes a pristine
   earlier attempt; rolls back only what it created. Local environments of
   such a project (`gitUrl` equal to its checkout path) start from
   `refs/heads/<branch>` while it has no `origin`; any other checkout without
   an origin still fails, as before. Evidence: unit tests, the `project-init`
   scenario and the browser check.
8. **Shell completion.** Done: `orkestrator completion bash|zsh|fish`,
   generated from the command table, local only, nouns/verbs/flags (no IDs).
   Evidence: `command-surface.test.ts` executes Bash, Zsh via bashcompinit,
   and Fish completions, including option values colliding with command words,
   equals forms, and short flags.
9. **Gateway setup in `browser-gateway.spec.ts`.** Evaluated and declined: its
   `invoke` calls are one-line in-page calls, and most (pane layouts,
   terminals, unread flags, pipelines, prompt-queue fixtures) have no public
   action. A CLI subprocess per call would lengthen setup, not shorten it.

Living-doc drift fixed in the same change: `public-cli.md` retention now
describes the logical SQLite store `public-operations/<namespace>` (WAL,
`synchronous = FULL`); its command table lists `toolchain install` and
`completion`; `public-cli.md` and `cli-testing.md` say CLI prompt text is typed
intent; the `public-cli.md` header already linked this file and 0014.

### Remaining (deferred)

6. **Event-stream following** (optional; polling works). A JSONL follow over
   the existing gateway SSE that reuses `GatewayEventReplay` and
   `parseGatewayCursor`, detects gaps and generation changes and resets from a
   snapshot, bounds frames and buffers, disconnects a slow consumer explicitly,
   and reports auth expiry and shutdown as observation outcomes. Needs a new
   `transcriptFollow` value. Build it only when a measurement shows polling's
   latency or load is a problem.
7. **Worker-scoped CLI credentials.** Explicitly provisioned, scope-limited
   credentials following the Control MCP authority patterns
   ([`control-mcp.md`](../../architecture/control-mcp.md)); never discover an
   operator token from inside a worker. Today a worker that needs scoped
   automation can use a Control MCP credential (capabilities, denied actions,
   its own authority namespace). Proposed shape: the gateway accepts a Control
   MCP credential bearer only on `public_action`, applies
   `controlMcpActionAllowed` and the confirmation rules, and dispatches under
   `control-mcp:<id>` authority; the CLI reads it from a private file
   (`connection add --credential-file`), never argv or the environment.
8. **Declarative `apply` and backend auto-start** (low priority, only on
   demand). Not requested so far. Auto-start needs process ownership, readiness
   detection and data-directory exclusivity first (see constraints).

### Qualification

- Done: credential-free `project-cascade` and `project-init` scenarios (local),
  live Claude `live-session` with the new steps, and the `cli-ui.spec.ts` browser
  check for init and cascade (2026-10-25, macOS).
- Left: `project-cascade` in the container matrix (needs a worktree-owned
  image), and the new `live-session` steps on Codex and OpenCode (and on Pi,
  Cursor and Grok with [0014](0014-cli-qualification.md)). The selected-command
  step is Claude-only today; other providers run only the refusal checks,
  `--literal`, `--attach` and `--enqueue`. Enqueue and selected-command results
  are not browser-checked (their UI is the existing queue and transcript,
  unchanged by this work).

## Assumptions and decisions

1. **Default intent of CLI prompt text.**
   Options: (a) keep the typed default and add an explicit `--literal`; (b)
   make CLI text literal by default, as workflow and mail prompts are; (c) add
   a required `--intent typed|literal`.
   Choice: (a).
   Why: the item specified `--literal`; CLI sessions are ordinary native tabs,
   so typed matches the composer; scripts already using `/compact` keep working;
   and the default is now documented rather than accidental.
   Pros: no behaviour change for existing scripts; one flag. Cons: a script that
   forwards untrusted text must remember `--literal`; on Claude a literal prompt
   starting with a known command is refused rather than sent.
2. **`session command` as a new action or a flag on `session.prompt`.**
   Options: (a) new `session.command` action; (b) `command` input on
   `session.prompt`.
   Choice: (a).
   Why: different input (ID or name plus arguments, binding revision), its own
   refusals and its own Control MCP description; the prompt fingerprint stays
   unchanged.
   Pros: clear contract and errors; older backends simply do not advertise it.
   Cons: one more action in the catalogue and Control MCP's list.
3. **Stable codes for refused selections.**
   Options: (a) reuse existing codes; (b) add command-specific codes.
   Choice: (a): `not-found`, `ambiguous-target`, `revision-conflict`,
   `capability-unavailable`, `invalid-input`, `busy`.
   Why: an older client validating envelopes rejects unknown error codes, and
   these already carry the right exit classes.
   Pros: compatible; consistent exit codes. Cons: callers read `details` to
   tell a command refusal from other not-found cases.
4. **Attachment transport.**
   Options: (a) inside the public action with a size limit; (b) a new gateway
   upload route; (c) backend host paths.
   Choice: (a), 8 files / 256 KiB.
   Why: no new listener or route (a constraint of this file); the request key,
   fingerprint and admission rules apply unchanged; (c) is forbidden.
   Pros: one request, one receipt, idempotent. Cons: small limit (prompt plus
   attachments must fit 1 MiB); large files must go through the workspace.
5. **Attachment lifecycle.**
   Options: (a) keep them in the workspace under a per-operation directory;
   (b) delete them after the turn; (c) store them in the backend data directory.
   Choice: (a), in the composer's own staging directory.
   Why: the agent may read them later in the turn or session; a per-operation
   directory cannot collide; the workspace owns cleanup on deletion.
   Pros: simple, consistent with the UI. Cons: files persist until the
   environment is deleted.
6. **Enqueue identity and refusals.**
   Options: (a) queue item ID = operation ID = dispatch request ID; (b) a
   separate queue ID mapped in the operation record.
   Choice: (a).
   Why: replay finds the same item through `enqueuePromptQueueMessageIfAbsent`,
   and the run observer can use the existing dispatch journal unchanged.
   A refused queued prompt fails its run but stays latched in the tab's queue
   for the user, as the composer's queue does. Pros: one identity end to end.
   Cons: a retry from the app sends it outside the run, which stays `failed`.
7. **Cascade authority.**
   Options: (a) operator only; (b) any credential with `projects`; (c) require
   `projects` and `environments.destructive`.
   Choice: (a).
   Why: one action has one capability in `PUBLIC_ACTION_INPUTS`; (b) would let
   a `projects` grant delete environments; (c) needs a per-input capability
   rule that does not exist yet.
   Pros: no privilege widening. Cons: Control MCP callers must delete
   environments first.
8. **Cascade order and failures.**
   Options: (a) sequential, keep the project if any deletion fails; (b)
   parallel; (c) best effort, remove the project regardless.
   Choice: (a).
   Why: each deletion already serialises on its environment queue; sequential
   keeps load bounded; never orphan environments of a removed project.
   Pros: predictable, retryable with a new key. Cons: slower for many
   environments.
9. **Local-only project identity.**
   Options: (a) no remote, `gitUrl` = checkout path, local start point when
   there is no `origin`; (b) create a sibling bare repository as `origin`;
   (c) set `origin` to the checkout itself.
   Choice: (a).
   Why: matches the item ("no remote"); the fallback applies only to projects
   recorded as local-only and still without an `origin`, so remote-backed
   projects and misconfigured checkouts behave exactly as before.
   Pros: nothing extra on disk; no network. Cons: container environments and
   pull requests need a remote added later.
10. **Deferred items.**
    Event following (6) waits for a measurement; worker credentials (7) are a
    new authentication path into the gateway and get their own design and
    review (Control MCP credentials cover scoped automation meanwhile);
    `apply` and auto-start (8) wait for demand; item 9 was declined after
    evaluation.

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
- To withdraw a capability, remove its handler (or input) from the public API;
  the operation store and reconciler must keep serving accepted work.

## Open questions

- Answered 2026-10-25 (see "Assumptions and decisions"): CLI text stays typed
  by default with `--literal`; `session command` is a new action; attachments
  ride in the public action with a size limit.

## Needs verification

- Verified 2026-10-25 after review fixes: the isolated `cli-review-qa` browser
  check passed (10.8 s). It dismisses optional-tool startup dialogs and waits
  for the fixture project's sidebar before `project.init`; the new project
  appears live, a local environment starts, and cascade removal converges live
  and after reload. Backend public API: 437 passing; CLI: 256 passing;
  protocol contract/input suites: 25 passing. Backend, CLI, and browser test
  type checks and changed-file lint passed.
- Verified 2026-10-25: `run retry` after restart of a parked selected command
  replays the same command ID, binding revision, and arguments
  (`public-api-command-surface.test.ts`, "recovery keeps command intent").
- Restart during local/container attachment staging (start, prompt, enqueue),
  queued image/file persistence, queue recovery, cold provider catalogue refresh,
  cascade progress/final observation and byte-bound summaries are covered by
  the public API command-surface and project-init-cascade tests.
- Local environment start from a `project.init` checkout is exercised through
  the public API and real Git, including a checkout with no origin.

## Related

- [0014-cli-qualification.md](0014-cli-qualification.md) for provider and platform
  evidence.
- [0166-opencode-prompt-attachment-never-dispatched.md](0166-opencode-prompt-attachment-never-dispatched.md):
  `--attach` with a text file is lost on OpenCode (found 2026-10-25).
- [0016-slash-command-catalogue.md](0016-slash-command-catalogue.md) for the catalogue
  `session commands` reads.
- [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md) for
  steering behaviour that `session steer` exposes.
- [`public-cli.md`](../../architecture/public-cli.md),
  [`cli-testing.md`](../../development/cli-testing.md),
  [`native-agent-commands.md`](../../architecture/native-agent-commands.md),
  [`remote-gateway.md`](../../architecture/remote-gateway.md).

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
  cascade deferrals; both done 2026-10-25)
- `docs/improvements/cli-commands/plan/08-settings-and-concurrent-edits.md`
  (done)
- `docs/improvements/cli-commands/plan/09-sessions-and-prompt-dispatch.md`
  (enqueue and attachment deferrals; both done 2026-10-25)
- `docs/improvements/cli-commands/plan/11-session-controls-and-interactions.md`
  (selected slash command deferral; done 2026-10-25)
- `docs/improvements/cli-commands/plan/12-transcripts-and-observation.md`
  (optional event following; still deferred)
- `docs/improvements/cli-commands/plan/13-environment-command-execution.md`
  (done)
