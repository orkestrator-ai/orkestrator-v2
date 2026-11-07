---
id: 7002
title: "Convert terminals, files and Claude tmux"
phase: 7
plan: "§12 Phase 7 and Appendix E"
status: done
depends_on: [1008, 1010, 1011]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7002 · Convert terminals, files and Claude tmux

- **Report:** [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix E](../../docs/reports/unified-federation.md#appendix-e-command-surface-by-domain), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [1011](1011-contract-policy-and-docs.md)
- **Recommended before the web side:** [3002](3002-lib-backend-client-parameter.md) and [2011](2011-scope-domain-negotiation.md). Until they land, the domain's `lib/backend` file calls the domain client bound to the command scope.
- **Parallel with:** the other Phase 7 domain items, and all of Phases 2-6
- **Size:** L
- **Track:** C (contract)

## Domains

`terminals`, `files`, `claude-tmux`.

## Current state (verified 2026-11-07)

- Terminals and files: 59 registered, 54 web-referenced. Claude tmux: 28 registered, 25 web-referenced.
- The terminal WebSocket protocol already negotiates through a subprotocol list and `ready` features (Appendix F). Leave it as is; this item covers only invoke commands.

## Work

Apply the conversion checklist from [1011](1011-contract-policy-and-docs.md)'s "Domain contracts" docs to every command in the domains above:

- [x] Define each domain at version 1 (min 1) in `packages/protocol/src/contract/domains/`.
- [x] `defineCommand` for every command, with:
  - `args` and `result` schemas;
  - `access` (workspace, admin or internal), seeded from [0006](0006-grant-scope-live-evidence.md)'s observed list and today's deny-lists;
  - `read`, checked against `isNodeReadCommand`;
  - `critical` fields, with a one-line reason each in Notes.
- [x] Switch handlers to `register(def, handler)`.
  - Lenient handlers stay tolerant.
  - Strict (`assertOnlyKeys`) handlers become tolerant-with-critical.
  - Hand-written `commands-validation.ts` parsing is replaced by the schema where it is equivalent; keep user-facing error text.
- [x] Fold the domain's capability command (if any) into the domain version. Keep the command registered for pre-contract clients until its register row retires. (None exists for these domains; see Notes.)
- [x] Web side:
  - a domain client in `apps/web/src/lib/node-scope/domains/<domain>.ts`, with a version-1 adapter and a version-0 legacy adapter that keeps today's capability gating;
  - the domain's `lib/backend` functions call it;
  - typed results replace `invoke<T>` casts.
- [x] Move the domain's shared types from `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` to inferred protocol types where they match (see [7010](7010-converge-models.md)). (Neither file holds a type of these domains; the `lib/backend` duplicates that match are inferred now. See Notes.)
- [x] Classify the register rows for these domains: retired, mechanical (adapter), or unaffected. Update `version-compatibility.md`.
- [x] Add a scenario module to [1012](1012-mixed-version-qualification.md)'s script for the domain's main flows.
- [x] Regenerate the manifest and the adapters list; the untyped baseline falls.


## Tests

- [x] Each converted handler passes its existing tests unchanged, apart from tests that asserted rejection of unknown keys, which now assert stripping (or the critical-field refusal).
- [x] A domain-client test for each adapter version against fakes.
- [x] Contract CI stage 2 ([1008](1008-contract-ci-job.md)) accepts every in-window snapshot's arguments. (Passes; vacuously until a release that defines these commands is in the window, see Notes.)

## Done when

- [x] Every command in these domains is defined, the untyped count for them is zero, and the web uses domain clients for them.

## Notes

### Where Effect is used (2026-11-07)

- **Effect Schema** for every definition: the 82 commands' `args` and `result` in `contract/domains/{terminals,files,claude-tmux}/commands.ts`, with shared named schemas for the shapes they return (`FileTreeNode` recursive through `Schema.suspend`, `FileSubtree`, `FileContent`, `WorktreeReadStamp`, the `get_worktree_snapshot_revisions` outcome union, `TerminalStateSnapshot`, `TerminalHistoryPage`, `TerminalOutputSnapshot`, `UserCommandRecord`, `HumanPromptEntry`, `TmuxStatus` with `TmuxAgentObservation`, `TaskListSnapshot`, `TmuxPendingHook`, `PreviousTmuxSession`), following 1001's rules (`Schema.Finite`/`Schema.Int`, `optionalKey`, no transformations). Void results are `Schema.Void` (the HTTP gateway answers `{}` for an undefined result, so the wire value is `undefined`).
- **`effect/Result`** only through 1002's `decodeCommandArgs`/`decodeCommandResult`.
- **Deliberately not Effect:** the domain clients (`commandApi`/`legacyCommandApi`), the web binding (`node-scope/domains/domain-api.ts`) and `ASYNC_HANDLER` are plain promise code over 1009's `createDomainClient` and 7004's `beforeDecode`, for 1009's reason (synchronous selection, promise callers, no services or fibers).

### Decisions (2026-11-07)

- **Commands: 82, exactly the domain map's lists.** `terminals` 26 (the 21 terminal commands and the 5 composer `!` user-command and human-prompt commands the map placed there), `files` 28, `claude-tmux` 28. The Appendix E "59 registered" for terminals and files counted by registering file; the map's split is the authority. All three registrars (`commands-registry-terminal.ts`, `commands-registry-user-commands.ts`, `tmux-commands.ts`) hold no other command of these domains; the git commands in `commands-registry-terminal.ts` stay string-registered (git domain).
- **Argument schemas.** Options considered: (a) every key `optionalKey(Unknown)` with the handler's checks kept, as 1010 did; (b) type every key; (c) type the keys whose handler check the schema reproduces exactly, `Unknown` for the rest. Chose (c): a key the handler required with `asString(x, "x")` (or tmux's strict `asBoolean`) is `Schema.String`/`Schema.Boolean` and the handler's call is gone, because the registry's message is the same text (`Expected sessionId to be a string`); a key read leniently (`asTerminalDimension`, `asOptionalString`, `asBoolean` with a fallback, `=== true`, `typeof` filters) or checked with the handler's own message (`asNonBlankString` plus a pattern, `asPositiveInt`, `asNonNegativeInt`, the write precondition, path lists, attachment batches, `held must be a boolean`) is `optionalKey(Unknown)`, because typing it would refuse a value accepted today (§11.4). Fields are listed in the order the handler checked them, since a decode reports the first failure (tmux: `environmentId` before `tabId`; `read_local_file`: `filePath` before `worktreePath`).
- **Strict to tolerant:** `read_environment_file_base64` (`assertOnlyKeys` on the arguments) and the items of `write_initial_prompt_attachments` (`assertOnlyKeys` per attachment) ignore unknown keys now.
- **Async handlers and `ASYNC_HANDLER`.** The registry decodes before the handler and throws a decode failure synchronously; an `async` handler used to reject. Suites calling handlers directly (`commands-registry-terminal.test.ts`'s `.rejects` checks) and any `handler(...).catch` caller rely on the rejection. Options: keep those keys `Unknown` (loses the typing), change the registry for every domain (not this item's file), or a registration option. Chose the option: `ASYNC_HANDLER` (`apps/backend/src/core/commands-registry-async-decode.ts`) is a `beforeDecode` (7004's `DefinedCommandOptions`) that turns the synchronous failure into a rejection with the same message. Every `async` handler of the three files passes it, and so does every tmux work command (the fence wrapper was `async`, so their failures were rejections before). Synchronous handlers stay synchronous.
- **Results describe what the handlers return,** including the forms a current backend still answers: a bare tree or subtree without `knownDigest` and the conditional `{ unchanged, digest, value?, view? }` with it; the whole-snapshot and conditional `ViewSnapshotOutcome` of `get_worktree_snapshot_revisions`; the tmux transcript's whole-file array (no `page`) and page. Optional fields mark what older backends omit (`bootstrapped`, `truncated`, `info_events`, `view`, `deltas`). `terminal_write`/`terminal_resize` and the local pair answer `{ delivered }`, or nothing from an older backend. No structured result is `Unknown`: a tmux transcript line is `Record(String, Unknown)` (Claude's JSONL record, kept whole because its keys are not ours), and a pending hook's `payload` is the hook's own JSON. Nothing is `encoded` (no pre-encoded splice in these domains).
- **`access`:** `workspace` for every command a renderer or grant reaches today (none is in `WORKSPACE_ADMINISTRATION_COMMANDS` or `isWorkspaceExcludedCommand`, and 0006's live list includes the local terminal, file tree and file read commands); `internal` for the five called only in-process by the backend: `check_container_workspace_paths`, `delete_container_annotation_evidence` (web annotations), `claude_tmux_submit_queued` (the prompt-queue drainer), `claude_tmux_reconcile_orphans` (teardown) and `reconcile_claude_state_polling` (startup). `list_terminal_sessions` has no caller and stays `workspace` (a read of session ids). **`read`** equals `isNodeReadCommand(name)`, pinned by the test (so `claude_tmux_status` and `claude_tmux_list_previous_sessions` are `false`).
- **Critical fields, per field:**
  - `launch_terminal_job.requestId`: the job's identity (its id and tab derive from it); a receiver ignoring it would start a second job for a retried request.
  - `write_local_file.expected`, `write_container_file.expected`: the editor's precondition; ignoring it would overwrite a concurrent change.
  - `delete_container_annotation_evidence.digest`: removes the file only while it is the recorded evidence; ignoring it could delete a replaced file.
  - `claude_tmux_answer_selection_prompt.expectedGeneration`/`expectedRevision`/`expectedPromptFingerprint`: the prompt the user answered; ignoring them would press the option on whatever prompt the pane shows now.
  - Not critical: `knownDigest`, `sinceRevision`/`sinceGeneration`, `refresh` (ignoring them answers the whole body, safe), `claude_tmux_start.replaceExisting`/`resumeSessionId` (ignoring them keeps or starts a session, never destroys one), `terminalKey` (a second session, not a wrong one), `livenessMaxAgeMs` (one more probe).
- **No capability command** exists for these domains (none is in 1009's `LEGACY_CAPABILITY_COMMANDS`, and no hello capability gates them), so nothing is folded. The terminal WebSocket's `ready` features are a separate protocol this item leaves alone.
- **Domain clients** (`contract/domains/<domain>/client.ts`, in `DOMAIN_CLIENTS`): the API is the command list keyed by name (`contract/domains/command-api.ts`): `commandApi(call, COMMANDS)` for version 1 (envelope, decoded results) and `legacyCommandApi(context, COMMANDS)` for version 0. Options for version 0: decode with the same schemas, or answer as sent. Chose answer as sent (`context.invoke`, no envelope): no command was gated, so version 0's job is exactly today's behaviour; a pre-contract node's variations are what the callers already normalise (`parseTerminalSessionCreateResult`, `normalizeConditionalArraySnapshot`, the transcript array), and decoding would refuse some of them. It also keeps every web suite's partial fake answers working, since a test window has no hello `domains`. 7001 made the same choice.
- **Hot path.** Definitions gained `hotPath` (protocol `command.ts`) and `createDomainClient` the `validateHotPathResults` option (protocol `client.ts`): a `hotPath` result is not decoded when the option is `false`. The renderer binding passes `rendererValidatesHotPathResults()` (`import.meta.env` `DEV`, `MODE === "test"` or `NODE_ENV === "test"`), so production renderers do not validate terminal input, resize and output results, matching the backend (results validated only in development and tests, 1003). `hotPath` commands: `terminal_write`, `terminal_resize`, `local_terminal_write`, `local_terminal_resize`, `get_terminal_output_buffer`, `get_terminal_output_snapshot`, `get_terminal_state_snapshot`, `get_terminal_history_page`, `claude_tmux_write_interactive_terminal`, `claude_tmux_resize_interactive_terminal`. The backend's argument decoding is the tolerant reader every defined command has; measured at about 0.12 µs per `terminal_write` call (Bun, this Mac), next to the HTTP or IPC round trip. The legacy adapter never decodes. Terminal output itself arrives as events (7011's `terminal-output-*`), not through these commands.
- **Web binding** (`apps/web/src/lib/node-scope/domains/{domain-api,terminals,files,claude-tmux}.ts`): one domain client per factory client and domain (a `WeakMap`), over the client's `invokeRaw` and its negotiated `domains`/`capabilities` (4abe0bb80), usage counted only for a client that carries `domains`. `lib/backend/terminals.ts`, `user-commands.ts`, `kanban.ts` (the two base64 reads), `files-sessions.ts` and `workflows.ts` (local terminals) call it inside their `createXApi(client)` factories; `claude-tmux-client.ts` calls it over `commandBackendClient`; `useRemoteHumanPrompts.ts` over 7003's `routedBackendClient` (version 0: a routed call carries no range). A call that had no arguments object keeps none (`NO_ARGUMENTS` for `get_worktree_snapshot_revisions`). Remaining type assertions are narrowings to the web's own view types (`TmuxStatus` with `HookEventKind`, the mutable `FileNode`), not unchecked casts of `unknown`. The web's `isTerminalStateSnapshot`/`isTerminalHistoryPage` and output-snapshot checks stay, since production does not decode those hot-path results and the guards also bound sizes.
- **Shared types:** `models.ts` and `apps/web/src/types/index.ts` hold no result type of these domains (only persisted drafts and mode enums). The `lib/backend` duplicates that match the definitions exactly are inferred now: `TerminalSessionStatus`, `BootstrapTerminalResult`, `TerminalJobLaunchResult` (`ResultOf`), `FileContent` (`FileContentSchema`). `FileNode`/`FileSubtree` (mutable trees the panel sorts) and the tmux view types (narrower event-kind unions) stay as they are; converging them is 7010.
- **Register rows** (7 in these domains): two are **mechanical** now and gain the renderer adapter counter: "Backends that ignore `page` on `claude_tmux_transcript`" (`domain-adapter.renderer.claude-tmux.v0`) and "Backends whose `get_file_subtree` and `get_local_file_subtree` ignore `knownDigest`" (`domain-adapter.renderer.files.v0`); each also names its adapter's retirement. **Unaffected:** "Renderers that predate paged tmux transcripts" (an older renderer sends no envelope; the defined command keeps the whole-file path and its counter), and the three terminal WebSocket rows (`ping` feature, per-input results, v1 subprotocol), which are the WebSocket protocol, not invoke. None retires: every release in the window is pre-contract.
- **Scenario modules** (`scripts/mixed-version/scenarios/{terminals,files,claude-tmux}.ts`, shared helper `renderer-client.ts`): these domains are called by the renderer, so each module runs a current renderer's domain client (over the node's HTTP invoke, adapter picked from the node's hello) against both nodes of the pair: a local terminal session's lifecycle and output recovery; tree, read, a conditional save (and a refused stale one) and a move into a new folder; tmux status, a refused prompt and the resumable list without a session (no toolchain). Not run live in this item (the runner needs two installed backends); listed for the live qualification pass.
- **Test edits** (outside "unchanged"): `tests/tmux-test-harness.ts` and `tmux-liveness-reuse.test.ts` had raw `(name, handler) => map.set(...)` registrars, which would store a definition under the object; wrapped in `registrarFrom` as 1003 and 1010 did, the liveness one with `validateResults: false` because its fake session's `status()` answers only `{ running }`. No converted handler's test changed otherwise. Web suites are unchanged (version 0 answers as sent).
- **Contract CI stage 2** passes (7001 turned it on); it checks defined commands of in-window releases, and every release in the window is pre-contract, so these commands are checked from the first release that defines them.
- **Commits and shared files:** 225971467 (protocol), 4ca129436 (web), 5c916ba00 (backend, domain map, scenarios, docs), 539cfab04 (inferred types) and the item commit. Shared files (`package.json`, `client-adapters.ts`, `contract-domain-map.ts`, `files-sessions.ts`, `terminals.ts`, `scenarios/index.ts`, `version-compatibility.md`) were committed from a temporary index built on HEAD with only this item's hunks. 7001's 571d1a5e2 swept this item's `files-sessions.ts` and `workflows.ts` hunks (it committed whole files) before the bindings they import existed; 4ca129436 added the bindings. The manifest, baseline, schema store and adapters list at HEAD were already regenerated by another item from a working tree that held these definitions, so they needed no change here (`contract:check` and `contract:ci` passed on this working tree before another agent's mid-edit file stopped the registry from loading).
- Pre-existing or other items' failures seen in the focused runs, not this item: `commands-integration.test.ts` delegation suites, `transcript_media_pin`, `get_control_mcp_settings`, the remote Multi Review suites, the manifest-equality test while another item's definitions were uncommitted, `ActionBar` sidebar toggle, and suites that failed to load on other items' mid-edit stores.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): protocol: `files/domain.ts`; `commands.ts`, `client.ts`, `index.ts` for `terminals`, `files` and `claude-tmux` (7011's `domain.ts`/`events.ts` reused); `domains/command-api.ts`; `hotPath` on definitions and `validateHotPathResults` on `createDomainClient`; three clients in `DOMAIN_CLIENTS`; three `package.json` exports; `terminals-files-tmux.test.ts`. Backend: the 82 handlers on `register(def, handler)` (51 with `ASYNC_HANDLER`), `commands-registry-async-decode.ts`, their domain-map entries removed, the tmux registrar on `wrapRegistrar`. Web: `node-scope/domains/{domain-api,terminals,files,claude-tmux}.ts` and their test; `lib/backend/{terminals,user-commands,kanban,files-sessions,workflows}.ts`, `claude-tmux-client.ts`, `useRemoteHumanPrompts.ts` through them; four result types inferred. Scenario modules for the three domains. Docs: two register rows mechanical, Domain contracts bullets (the three domains, hot path, `ASYNC_HANDLER`). Manifest at HEAD: 26/28/28 defined, 0 untyped in these domains. Tests: protocol 60 pass (`terminals-files-tmux`, `client`, `pilot-domains`); backend 51 files, 1544 tests, the only failures other items' (above); web 42 files 1955 pass (1 other item's `ActionBar`); root `mixed-version-qualification`, `contract-untyped-ratchet`, `domain-import-boundaries`, `unknown-command-text-guard`, `contract-ci` (pass); `contract:check`, `contract:ci` pass. Protocol, backend (both tsconfigs) and web typecheck clean for these files; oxlint and `bun fmt` clean.
- 2026-11-07 (claude-worker, completeness audit): mixed-version modules run live (1012 Work log): control terminals 8/8, files 10/10, claude-tmux 8/8; v2.36.1 `current-command` and `old-command` the same, all passed.
