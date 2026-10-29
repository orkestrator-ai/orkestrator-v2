# CLI command surface

Checked against `main` at `ba7cc8d4` (2026-10-25).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

The shipped items (Done 1 to 5, 8 and 9) are on `main` through `2d3a55ea`
(#1246). Note that "8" is used twice: Done 8 is shell completion, Remaining 8
is `apply` and auto-start. The task numbers below are this section's own.

### Tasks

1. **Event-stream transcript following**: a JSONL follow over the gateway SSE instead of cursor polling (Remaining 6). Status: deferred (until a measurement shows polling is a problem).
2. **Worker-scoped CLI credentials**: let the CLI authenticate with a scoped Control MCP credential (Remaining 7). Status: deferred.
3. **Declarative `apply` and backend auto-start** (Remaining 8). Status: deferred (no demand; auto-start needs process ownership first).
4. **`project-cascade` in the container matrix**: run the cascade scenario with container environments. Status: done (2026-10-25, recorded in 0014 but still listed here as left).
5. **New `live-session` steps on other providers**: `--literal`, `--attach`, `--enqueue` and the refusals on Codex, OpenCode, Pi, Cursor and Grok. Status: partly done (OpenCode done 2026-10-26; Codex open; Pi, Cursor and Grok blocked on credentials with 0014).
6. **Selected-command step beyond Claude, and browser checks for enqueue and selected commands**. Status: open (decision only: extend or retire).

### 1. Event-stream transcript following

**Problem.** `session transcript --follow --jsonl` polls snapshot pages by cursor; there is no push follow. Nobody has reported latency or load from it.

**Context.** Optional by the file's own decision 10; needs a new `transcriptFollow` value and must keep the transport invariants (replay subscribes first, `connected` echoes the cursor, bounded buffers, explicit desync).

**Investigation.** Still accurate. `transcriptFollow` is typed `"poll" | "unavailable"` (`packages/protocol/src/public-api.ts:1268`) and `publicFeatures()` returns `"poll"` (`apps/backend/src/core/public-api/registry.ts:71`). The reuse targets exist: `parseGatewayCursor` at `apps/backend/src/gateway-event-replay.ts:66` and `GatewayEventReplay` at `:82`. New since the file: `attention --follow --jsonl` (`packages/cli/src/client/commands/attention.ts:43`) is a second polling follower, so a push transport would serve two commands, not one. `publicFeatures()` also now returns `nodeRouting` (added by #1268/#1302), which the file's "Current state" does not list; leaf-node routing (`--node`) would have to be handled by any SSE follow too, since the stream would come from the leaf.

**Decisions.**

- **When to build it?**
  - **Keep deferred until a measurement exists (recommended).** Measure poll latency and backend load for a typical follow (and `attention --follow`) first, as the file requires.
    - Pros: no new streaming surface to keep within the transport invariants; polling already rehydrates from snapshots by construction.
    - Cons: follows stay as slow as the poll interval.
  - **Build it now for both followers.**
    - Pros: one push transport for transcript and attention; lower latency for voice and notifier clients.
    - Cons: gateway SSE, replay, gap detection and node relay for an unmeasured need; a large review surface.
- **What would count as the trigger measurement?**
  - **A recorded poll-interval latency and request rate from a scripted follow on a busy session, with a stated budget (recommended).**
    - Pros: makes the deferral testable; the CLI scenario harness can produce it.
    - Cons: someone has to choose a budget without a user complaint to anchor it.
  - **A user report only.**
    - Pros: zero work until needed.
    - Cons: the item may never be re-rated.

### 2. Worker-scoped CLI credentials

**Problem.** A worker that wants to run the CLI has no scoped credential of its own; the only CLI credential is the operator token, which must never be discovered from inside a worker.

**Context.** The proposed shape reuses Control MCP credentials on `public_action` only, with `controlMcpActionAllowed` and `control-mcp:<id>` authority, read from a private file. Decision 10 says it is a new authentication path into the gateway and needs its own design and review.

**Investigation.** `controlMcpActionAllowed` is at `packages/protocol/src/control-mcp.ts:123` and is applied in `apps/backend/src/core/control-mcp-caller.ts:65` and `apps/backend/src/core/scheduled-jobs/executor.ts`. `control-mcp:` authority is already threaded through `public-api/operation-ledger.ts`, `node-targets.ts` and `actions-schedules.ts`; #1268 added relaying a Control MCP credential's authority to leaf nodes. The gateway still accepts no Control MCP bearer on `public_action`, and the CLI has no `--credential-file` option on `connection add` (`packages/cli/src/client/commands/connection.ts` only manages its own credential file). So the backend half of the proposal (authority namespace, allow rules, relay) is more in place than when the file was written; the gateway authentication and CLI halves are untouched.

**Decisions.**

- **Should the work start now?**
  - **Keep deferred and spin it out as a new todo with a security design when someone asks (recommended).** Control MCP credentials already give scoped automation over MCP.
    - Pros: no new gateway authentication path without a threat review; matches decision 10 and the folder rule that new work goes into a new file.
    - Cons: shell-only workers still cannot use the CLI with scoped authority.
  - **Implement the proposed shape now.**
    - Pros: most of the authority plumbing exists, so the code is smaller than it was.
    - Cons: widens what the gateway accepts as a bearer; needs isolation review (worker can reach the gateway port) before it is safe.
- **Credential transport when it is built?**
  - **Private file named by `connection add --credential-file` (recommended).** As proposed.
    - Pros: keeps tokens out of argv and the environment (metrics and logs invariants).
    - Cons: the worker needs a provisioned file path, so environment setup must stage it.
  - **Environment variable.**
    - Pros: trivial to inject into a container.
    - Cons: inherited by every child process and visible in `/proc`; the file rejects it.

### 3. Declarative `apply` and backend auto-start

**Problem.** The CLI cannot apply a desired-state file, and client commands never start a backend.

**Context.** Not requested. The root `AGENTS.md` ("Client commands never start a backend") and this file's constraints forbid starting a second backend over the desktop's data directory.

**Investigation.** Unchanged: no `apply` command in `packages/cli/src/client/commands/`, and the launcher still decides service versus client before importing the backend. No demand recorded since 2026-10-25.

**Decisions.**

- **Keep or retire the item?**
  - **Retire it from this file and leave the constraint in `public-cli.md` (recommended).** Record "not planned; reopen as a new todo on demand".
    - Pros: removes an open item nobody wants; the file can then finish once task 5 is done; the safety constraint already lives in the architecture doc and `AGENTS.md`.
    - Cons: the design notes (process ownership, readiness, data-directory exclusivity) live only in git history.
  - **Keep it deferred here.**
    - Pros: the prerequisites stay listed next to the CLI surface.
    - Cons: keeps the file open indefinitely for unrequested work.

### 4. `project-cascade` in the container matrix

**Problem.** The file says the cascade scenario was never run with container environments.

**Context.** It needed a worktree-owned image.

**Investigation.** Out of date. `project-cascade` has no `environmentTypes` restriction (`packages/cli/scenarios/cases.ts:730`; filter at `packages/cli/scripts/run-scenarios.ts:88`) and creates environments with `--type context.environmentType` (`cases.ts:79-80`). The 0014 evidence log records a container matrix of 7/7 on 2026-10-25 at `bab01b13` (image `orkestrator-v2:dev-1af641a7170c`); the seven container-eligible cases are `read-only`, `local-lifecycle`, `retry-and-retention`, `exec`, `wrong-profile`, `foreign-owner` and `project-cascade`, so the cascade passed in containers.

**Decisions.**

- **How to close it?**
  - **Mark it done, citing the 0014 2026-10-25 review follow-up run (recommended).**
    - Pros: matches the evidence; removes a false open item.
    - Cons: the run was recorded as a matrix total, not per case; the manifest (`2026-10-25T18-39-29-682Z-8f32d1f8`) is git-ignored and may be gone.
  - **Re-run `project-cascade` alone in a container and record it explicitly.**
    - Pros: a per-case record in this file.
    - Cons: needs a dev image build for a result already covered.

### 5. New `live-session` steps on other providers

**Problem.** `--literal`, `--attach`, `--enqueue` and the refusal steps were live-qualified only on Claude when the file was written.

**Context.** Steps are in `packages/cli/scenarios/cases.ts:1052-1223`; Pi, Cursor and Grok are batched with 0014 item 1 (no API-key credentials on the qualifying host).

**Investigation.** OpenCode is now done: 0166 and the 0014 evidence log record `live-session --provider opencode` passing every stage, local and container, on 2026-10-26 (`--attach` included). Codex has not run since the new steps landed; its last `live-session` pass is the 2026-10-22 run, before #1246. Since #1270 every host provider needs its pinned binary, which the harness now installs (`packages/cli/scenarios/harness.ts:147-168`), so Codex is unblocked.

**Decisions.**

- **Where to track the remaining runs?**
  - **Run Codex now and leave Pi, Cursor and Grok to 0014 item 1 only (recommended).** Record Codex here, then drop this item.
    - Pros: one owner per provider run; this file can finish without waiting for credentials.
    - Cons: 0014 must remember that its Pi, Cursor and Grok runs also cover these steps (the scenario runs them anyway).
  - **Keep all five providers listed here until each passes.**
    - Pros: a complete per-provider record next to the feature.
    - Cons: duplicates 0014 and keeps this file open on a credential blocker.
- **Codex run scope?**
  - **Local and container, with the provider default model recorded in the manifest (recommended).**
    - Pros: matches the OpenCode evidence; container covers the restricted allowlist.
    - Cons: the container run needs a dev image and `--network full` per the 2026-10-22 notes, costing a build and live tokens.
  - **Local only.**
    - Pros: cheaper.
    - Cons: leaves attachment staging through `write_container_file` unproved live on Codex (Codex refuses non-image files, so only the refusal path runs).

### 6. Selected-command step beyond Claude, and browser checks

**Problem.** The live selected-command step is gated to Claude (`cases.ts:1089`), so other providers only exercise the refusals; enqueue and selected-command results have no browser check.

**Context.** The file argues the UI (queue and transcript) is unchanged, so no browser check is needed. 0015 already qualifies selected commands for all six providers through the composer.

**Investigation.** Gate confirmed at `packages/cli/scenarios/cases.ts:1089-1093` (Claude's built-in `/context`). Earlier attempts with project `.claude/commands` failed because that build's session catalogue omitted them; other providers would need a command they reliably list before the first turn (for example an OpenCode `command.list` entry, or a Pi template, which 0069 now lists before attach).

**Decisions.**

- **Extend the selected-command step to other providers?**
  - **No; keep it Claude-only and rely on 0015 for per-provider executor proof (recommended).**
    - Pros: the CLI path is provider-neutral after `dispatch_native_agent_intent`; 0015 already proves each executor live.
    - Cons: the CLI's name-to-ID resolution and `bindingRevision` echo are proved live on one catalogue shape only.
  - **Add a per-provider planted command (OpenCode command file, Pi template, Codex skill).**
    - Pros: end-to-end CLI proof per provider.
    - Cons: more fixture setup per provider and more live tokens; brittle when a provider changes discovery.
- **Browser-check enqueue and selected-command results?**
  - **No; retire that note (recommended).** The renderer path is unchanged and is covered by existing queue and transcript tests.
    - Pros: no new browser spec for unchanged UI.
    - Cons: a CLI-enqueued item's appearance in the tab's queue is not observed in a real browser.
  - **Add one `cli-ui.spec.ts` case that enqueues through the CLI and checks the queue panel.**
    - Pros: proves the inactive-tab path for a CLI-originated queue item.
    - Cons: a live turn in a browser spec; slower and needs credentials.

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
   todo 0166 fixed the file part's MIME type.
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
- [agent-engines.md](../../architecture/agent-engines.md#opencode): OpenCode
  attachment MIME types, from todo 0166 (`--attach` with a text file was lost
  on OpenCode; found 2026-10-25, retired on 2026-10-29).
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
