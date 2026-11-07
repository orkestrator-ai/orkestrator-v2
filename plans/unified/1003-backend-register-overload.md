---
id: 1003
title: "Backend: register(def, handler) and the invoke envelope"
phase: 1
plan: "§11.2 and §12 Phase 1.2"
status: done
depends_on: [1002]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1003 · Backend: register(def, handler) and the invoke envelope

- **Report:** [§11.2 Definitions in `packages/protocol`](../../docs/reports/unified-federation.md#112-design)
- **Depends on:** [1002](1002-contract-primitives.md)
- **Blocks:** [1004](1004-hello-domains.md), [1006](1006-contract-manifest-generator.md), [1010](1010-pilot-node-mail-and-ticket-sync.md)
- **Size:** M
- **Track:** C (contract)

## Goal

A command defined with `defineCommand` gets these behaviours:

- tolerant argument parsing: unknown fields are stripped unless named critical, and an unknown critical field is refused with `unsupported-field`;
- result validation in development and tests;
- the envelope on every transport.

String-registered commands keep working unchanged.

## Current state (verified 2026-11-07)

- The registry is in `apps/backend/src/core/commands-registry.ts:103-406`; `commands.ts` is a 5-line re-export.
  - The `register` closure is at :112-117.
  - It wraps each handler in `guardContainerCommand` (:118-142) and `commandTimings.time`.
  - About 60 `register*Commands(register, deps)` calls follow at :342-403. `registerPublicApiCommands` must stay last.
- `CommandRegistrar = (name, handler) => void` is at `commands-registry-types.ts:15`. `CommandHandler` is at `commands-context.ts:140-143`.
- Wrapping registrars that the overload must pass through:
  - `gatedRegistrar` in `commands-registry-web-annotations.ts:392`
  - the MCP correlation wrapper at `commands-registry-mcp.ts:579`
  - the loops at `commands-registry-design.ts:12` and `commands-registry-servers.ts:136`
- HTTP invoke is `gateway-handlers.ts:71-194`.
  - It reads `command` and `args` at :104-105, with grant refusal at :110-126.
  - The pre-encoded transcript splice is at :157-161.
  - Errors are always HTTP 500 with `{ error, code? }`.
- Electron IPC: `apps/desktop/electron/ipc.ts:309-336` handles `orkestrator:invoke(command, args)`, and `preload-api.ts:495-497` calls it.
- The relay (`node-relay.ts:200-221`) parses only `{command, args}` for refusal and forwards the raw body, so the envelope passes through unchanged.
- Node link: backend-to-backend invokes keep `code` (`node-link.ts:536-555`).

## Work

- [x] Overload `CommandRegistrar`: `register(name, handler)` and `register(def, handler)`. The def form records the definition in a registry-side `contracts` map that [1006](1006-contract-manifest-generator.md) reads.
- [x] Make every wrapping registrar forward both forms (the four sites above). Add a test that a def registered through each wrapper appears in the `contracts` map.
- [x] Argument parsing for def commands:
  - strip unknown keys;
  - refuse an unknown key named in the envelope's `critical` with `unsupported-field`;
  - refuse a schema failure with the existing validation error text, so messages users see do not change.
- [x] Result validation in `NODE_ENV=development|test` only. Skip `encoded: true` results (the transcript splice).
- [x] HTTP: parse the envelope fields next to `command` and `args`. When `domain` and `version` are present and outside the backend's range, answer `unsupported-version` with the range.
- [x] Desktop IPC: the envelope travels in the optional third argument's `envelope` field (`orkestrator:invoke(command, args, { nodeId?, envelope? })`, the shape agreed with [2007](2007-desktop-node-ipc-and-events.md), which added the argument), and main forwards it to the backend client. Older renderers send two arguments and keep working.
- [x] Node link: send the envelope from `node-link.ts` when the peer's hello advertises the domain (after [1004](1004-hello-domains.md); leave a TODO box there).
- [x] Mixed strictness rule from §11.4, enforced in review: never switch a lenient handler to rejecting unknown keys. A strict handler that adopts `defineCommand` becomes tolerant with critical fields.

## Tests

- [x] Registry: def and string registrations coexist; a duplicate name across forms throws.
- [x] Parsing: unknown field stripped; unknown critical field refused with code and field; result validation fires in test mode and skips encoded results.
- [x] HTTP envelope through the gateway, the relay and Electron IPC (desktop test), including an older two-argument IPC call.

## Done when

- [x] One throwaway def command (in a test) works on all three transports. *(Split 2026-11-07 from "…, and `mise run test` passes with no handler converted yet".)*
- [x] `mise run test` passes, with this exception. `mise run test` at `13d3b79ea` (2026-11-07, orchestrator): the workspace (web, backend, desktop, web-public, cli, protocol, toolchain), bridges and codex-lockfile groups pass; the root group fails only on tests that fail identically at the base `148e9ad0a`: `dom-absence-scan` (`NativeChart.test.tsx`, `RichBlockFrame.test.tsx`), the two `test-suite-ownership` checks (`e2e/agent-testing/session-history-environment.test.ts`, `tests/unit/tmux-mail-benchmark.test.ts`), and `goals-plan`/`graphs-plan`, which scan the `plans/goals` and `plans/graphs` folders the base deleted. None of these files is touched by this branch. (The "no handler converted yet" state no longer exists: Phase 7 defined every command; the throwaway def command test above still passes.)

## Notes

### Where Effect is used (2026-11-07)

- **`effect/Result`** from the 1002 decode helpers (`decodeCommandArgs`, `validateCommandResult`, `decodeInvokeEnvelope`) is read once per call and mapped to the backend's existing error shape: the registry throws the `Data.TaggedError` failure (`UnsupportedFieldError`, `UnsupportedVersionError`, `InvalidCommandArgsError`, `InvalidCommandResultError`). They are real `Error`s, so every transport carries them as today (`{ error, code? }`), and the gateway answers an incompatibility with `toWire(error)` (`{ error, code, details }`).
- **`effect/SchemaIssue` / `effect/SchemaAST`** (types only): the argument failure text is built by walking the Schema issue tree (`Pointer` paths, `MissingKey`, `InvalidType`, `Filter`, `AnyOf`) and the args AST, so a schema failure keeps the `commands-validation.ts` phrasing.
- Deliberately not Effect: the registrar, the handler wrappers and the version check are plain functions that keep a synchronous handler synchronous (the container guard relies on that); no `Effect` runtime on the command hot path. `CommandRegistry` is a plain `Map` subclass, not a Context service, because 60+ `register*Commands` functions and many tests take the map.

### Decisions (2026-11-07)

- **`CommandRegistrar` is a real overload** (`(name, handler)` and `<C>(def, handler: DefinedCommandHandler<C>)`). A two-signature type makes an untyped `(name, handler) => map.set(name, handler)` lambda unassignable (its parameters lose their contextual type), which broke 66 call sites in 47 backend test/support files. Options: (a) keep `CommandRegistrar` string-only and add a separate contract registrar type: no churn, but the wrapping registrars could not forward the definition form by type, and the box asks for the overload; (b) the overload, with every such lambda wrapped in `registrarFrom(sink)` (`commands-registry-contracts.ts`): a mechanical one-line change per site, and those test registrars then decode definitions the way the registry does, so a domain item converting a command (7001+) needs no further test churn. Chose (b). The edits are outside this item's file set (test files and `node-network-test-support.ts`, `public-api/node-test-support.ts`, `preview-baseline-harness.ts`), all a pure wrap.
- **Registry shape.** `createCommandRegistry()` returns `CommandRegistry extends Map<string, CommandHandler>` with `contracts: Map<name, CommandDef>` (1006 reads it) and `domainRanges: Map<domain, { min, max }>` (`min` = `domain.min`, `max` = `domain.version`; 1004 can advertise exactly this). `createRegistryRegistrar(commands, { validateResults, guard?, time? })` is the registry's own registrar; `createCommandRegistry` passes the container guard and command timing, tests pass neither. Two definitions naming one domain with different ranges throw at registration.
- **Duplicates.** A name registered in both forms, or defined twice, throws (`claim`). String-after-string keeps today's last-wins behaviour, so nothing existing changes.
- **How the envelope reaches the registry.** `CommandHandler` gains an optional third parameter `invocation?: CommandInvocation` (`{ domain?, version?, critical? }`); `OrkestratorBackend.invoke(command, args, invocation?)` and `BackendInvoker.invoke` pass it (minimal edits to `core/index.ts` and `gateway-support-core.ts`, outside the file set). Not on `CommandContext`, because the context object is shared by every call. Only the registry's wrapper reads it; handlers and wrapping registrars may ignore it (the four wrappers pass it on).
- **Order per call:** version check, then (definition) argument decode / (string) critical check, then the container guard on the decoded arguments, then the handler, then result validation; all inside `commandTimings.time`.
- **Version range check** applies to every command, defined or not, when the envelope has both `domain` and `version` and this registry has a range for that domain. A domain with no defined command has no range here and is not checked (no older client sends one, and there is nothing to report). Version 0 against a domain with a range is refused, since `min ≥ 1`.
- **Critical fields on a string-registered command** are refused when the arguments carry them: an untyped handler cannot say it understands a must-understand field, and refusing is the safe side (§11.2 "it never weakens a safety property"). A critical name the arguments do not carry is ignored, as in `decodeCommandArgs`.
- **Schema failure text** (`commandArgsErrorMessage`): `Expected <path> to be a string|a number|a boolean|an object|an array|one of "a", "b"`, the phrasing of `commands-validation.ts`; paths are `a.b` and `a[1]`, the root is `arguments`; a check without a message uses its `expected` annotation (`Expected count to be a finite number`). A `message` annotation on the failing schema or check (or `messageMissingKey`) wins, so a converted handler keeps any hand-written text exactly (for example `Schema.isMinLength(1, { message: "Expected label to be a non-blank string" })`). Values never appear. The thrown error is `InvalidCommandArgsError` with that message and no `code`, so the HTTP body stays `{ error }`.
- **Result validation** defaults on for `NODE_ENV` `development` or `test` (`contractResultValidationDefault`), overridable with `CommandRegistryOptions.validateContractResults`. It returns the handler's own value (not the encoded copy), so validated and production runs answer the same thing, and a synchronous handler stays synchronous. `encoded: true` definitions are skipped.
- **HTTP.** The gateway decodes the envelope only when the body has `domain`, `version` or `critical`; a body with only `command`/`args` reaches the backend as a two-argument call, unchanged. A malformed envelope (critical over 16 names, a non-array, a bad version or domain) answers 400 with the protocol's value-free message before the backend runs. Errors stay HTTP 500; an incompatibility error answers `toWire(error)`, i.e. `{ error, code, details: { domain, range | field } }`. This is part of [1005](1005-typed-incompatibility-errors.md)'s "Backend: carry unsupported-version and unsupported-field ... in the error body" box, done here for the gateway because this item's HTTP box answers `unsupported-version` *with the range*; 1005 still owns the unknown-command sites, the web/desktop clients and the node link.
- **Relay.** `node-relay.ts` already forwards the raw body, so the envelope passes through unchanged; no code change, a test drives a real command-node gateway relaying to a real leaf gateway.
- **Desktop (wording, 2026-11-07).** The item said "an optional third `envelope` argument"; the shape agreed with 2007/2008 is the third argument's `envelope` field, `orkestrator:invoke(command, args, { nodeId?, envelope? })`, and the preload's `invoke(command, args, { envelope })`. 2007 added and bounds it (4096 serialised characters); this item wires main → `ConnectionManager.invoke(command, args, scope, { envelope })` → `BackendHttpClient.invoke(command, args, { envelope })` for the window's scope and for node scopes (`DesktopNodeIpc.backendFor`). The client takes only `domain`, `version` and `critical` from the envelope (`invokeEnvelopeFields`); `command` and `args` always come from the call. Recommendation for 1009/2011: over IPC send the envelope without `args` (they travel positionally), or a large argument object would exceed 2007's 4096 bound. Terminal input and lifecycle commands keep their sequencer, which sends the plain body; no terminal command has a definition yet (7002 carries it). Over IPC only the error message crosses today; keeping `code`/`details` is 1005's desktop box.
- **Mixed strictness (§11.4).** Enforced by construction: a defined command only ever strips unknown keys (never rejects them), so adopting `defineCommand` cannot make a lenient handler strict, and a strict handler that adopts it becomes tolerant with critical fields. Reviewers still check that a conversion does not add a hand-written unknown-key rejection.
- **Node link** box was left open for [1004](1004-hello-domains.md), which needed the hello's `domains`; done there on 2026-11-07 (`NodeLink.invokeCommand`, see the Work log), so the status is now `done`.
- Aggregate suite left to review preparation.
- **Status (2026-11-07, orchestrator, completeness check).** Open only for the aggregate `mise run test` box, which the orchestrator runs at the end of the branch; everything else is done.

## Work log

- 2026-11-07 (claude-worker): backend: `CommandRegistrar` overload, `commands-registry-contracts.ts` (`CommandRegistry`, `createRegistryRegistrar`, `contractCommandHandler`, `untypedCommandHandler`, `assertInvocationVersion`, `commandArgsErrorMessage`, `wrapRegistrar`, `registerTarget`, `registrarFrom`, `contractResultValidationDefault`), `CommandInvocation` on `CommandHandler`, backend `invoke` and `BackendInvoker` third argument, gateway envelope decoding and `toWire` error bodies; the four wrapping registrars (`gatedRegistrar`, `mcpCorrelatedRegistrar`, `designAdmissionRegistrar`, `containerBridgeStartRegistrar`) forward both forms; 66 test registrar lambdas wrapped in `registrarFrom` (commit 25623b096). Desktop: envelope from main through `ConnectionManager` and `DesktopNodeIpc` to `BackendHttpClient` (commit c94c980b3). Tests: `commands-registry-contracts.test.ts` (20 pass), `tests/gateway-invoke-envelope.test.ts` (HTTP and relay, 7 pass), `apps/desktop/tests/invoke-envelope-ipc.test.ts` (5 pass) and a node-ipc test; the 52 touched/related backend files pass, 18 node/preview files pass, desktop ipc/node-ipc/main-ipc/backend-process/connection-manager/preload pass. Backend and desktop typecheck, oxlint and `bun fmt` clean.
- 2026-11-07 (claude-worker, during 1004): node link envelope: `NodeLink.invokeCommand(def, args, options)` sends `buildInvokeEnvelope`'s `domain`/`version`/`critical` next to `command`/`args` only when the peer's hello advertises the command's domain (`contractEnvelopeFor(hello, def, args)`, via 1004's `domainRange`); a pre-contract peer, or one without the domain, gets today's `{ command, args }`. String `invoke` is unchanged. Tests in `apps/backend/src/core/nodes/node-link.test.ts` (3 cases).
- 2026-11-07 (orchestrator, completeness check): the ticked Done-when box claimed `mise run test` passes, but no aggregate run is recorded. Split it: the proven part stays ticked, "`mise run test` passes" is its own open box (the orchestrator runs it at the end). `status: in-progress` until then.
- 2026-11-07 (orchestrator): ran the aggregate suite at `13d3b79ea`; result recorded in the Done-when box.
