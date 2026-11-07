---
id: 1005
title: "Typed incompatibility errors end to end"
phase: 1
plan: "§11.2 Typed incompatibility errors and §12 Phase 1.3"
status: done
depends_on: [1002, 0007]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1005 · Typed incompatibility errors end to end

- **Report:** [§11.2 Typed incompatibility errors](../../docs/reports/unified-federation.md#112-design)
- **Depends on:** [1002](1002-contract-primitives.md), [0007](0007-unknown-command-helper.md)
- **Blocks:** [1010](1010-pilot-node-mail-and-ticket-sync.md), [5006](5006-fleet-currency.md)
- **Parallel with:** [1003](1003-backend-register-overload.md), [1006](1006-contract-manifest-generator.md)
- **Size:** M
- **Track:** C (contract)

## Goal

"Not available on this machine" is detected from a code on every path, never from message text. The client shows one UI state for it.

## Current state (verified 2026-11-07)

- Backends throw `Unknown backend command: <name>`: `core/index.ts:3019-3024` and 6 other sites, plus `public-api/dispatch.ts:131`.
- **`code` is lost on two of the three paths:**
  - Web HTTP: `web-gateway.ts:1360-1377` builds `GatewayHttpError(status, message)` (`gateway-http-error.ts:12`), which has no `code`.
  - Electron IPC: `preload-api.ts:41-75` keeps only the message.
  - Node link: kept (`node-link.ts:536-555`).
- Text matchers to replace:
  - `lib/backend/shared.ts:51` (5 callers)
  - `lib/portal/unknown-command.ts` (5 callers; fixed in [0007](0007-unknown-command-helper.md))
  - the protocol `isUnknownCommandError` (9 files)
  - about 11 inline matches, listed in [0007](0007-unknown-command-helper.md)

## Work

- [x] Backend: throw a coded error (`code: "unknown-command"`, `domain` when known) from every unknown-command site. Keep the message text unchanged so that older clients' text matching still works.
- [x] Backend: carry `unsupported-version` and `unsupported-field` from [1003](1003-backend-register-overload.md) with `{domain, range, field}` in the error body. Bound the body: the field name ≤ 64 characters, and never an argument value.
- [x] Web: add `code` and a bounded `details` to `GatewayHttpError`, read from the JSON error body.
- [x] Desktop: keep `code` and `details` across IPC (main serialises them; preload rebuilds the error).
- [x] Replace every matcher with `incompatibility(error)` from `@orkestrator/protocol/contract/errors`. It reads `code` first and falls back to text for pre-contract nodes. Delete `isUnsupportedBackendCommand` and the portal helper once no callers remain.
- [x] One UI helper: `describeIncompatibility(error, machineLabel)` → "Not available on <machine> (version x). Update it." Use it where the callers above currently show a raw error.

## Tests

- [x] Each transport keeps `code` and `details` (gateway test, desktop IPC test, node-link test).
- [x] `incompatibility()` against coded errors, legacy text, and unrelated errors.
- [x] A source guard (or test) shows that no `Unknown backend command` / `Unknown command:` text matching remains in `apps/web/src` outside the protocol helper.

## Done when

- [x] All matchers are gone and all three transports carry codes.

## Notes

### Decisions (2026-11-07)

- **`details.command` (deviation from the box's `{domain, range, field}`).** Every typed error now names the refused `command` in its wire `details` (an identifier of at most 64 characters, else omitted), and `incompatibility(error, command)` returns `null` for an incompatibility that names another command. Why: once every unknown-command site is coded, a handler whose *nested* in-process call misses (`this.commands.get(Y)`) would answer `code: "unknown-command"` for the outer command X, and a caller's fallback for X would fire for a command that may already have run (the risk `isUnsupportedBackendCommand`'s comment named). Options: (a) do not code nested sites (deviates from "every site"); (b) the gateway strips a code whose `error.command` differs from the invoked command (breaks routed `invoke_on_node`, where the leaf's command is not the gateway's); (c) carry the command and let the reader, which knows what it asked, compare. Chose (c): every site is coded, routed calls keep their code, and nested misses never read as the caller's. The command name is the caller's own identifier, already in the legacy message, never an argument value. The report's §11.2 table could say "`domain`, `range`, `field`, `command`".
- **Domain on unknown-command.** `OrkestratorBackend.invoke` passes `invocation?.domain` (the envelope's domain, validated by the gateway). The 1006 domain map (`contract-domain-map.ts`) is not used: it lists only commands this backend registers, so it never knows the domain of a command the backend lacks; nested sites name no domain.
- **Electron IPC: message form, not a structured value.** The context bridge copies only an error's message (custom properties are dropped), and rejecting with a plain object would break every `error instanceof Error` caller. So main's `orkestrator:invoke` (`ipc.ts`) catches a coded error and throws `incompatibilityIpcMessage(error)`: 2007's `[code] text` convention extended with bounded `key=value` details inside the brackets, values URI-encoded (`[unsupported-version domain=git range=1-3 command=get_x] Domain git …`, `packages/protocol/src/contract/ipc-error.ts`, no Effect import so the sandboxed preload can use it). The preload (`readableInvokeError`) sets `error.code` and `error.details` from it for its own world; the renderer reads the message form through `incompatibility()` itself, so no renderer transport (2010's files) needed a rebuild step. The desktop `BackendHttpClient` rebuilds the class with `fromWire`, which is how main sees the code. 2007's `nodeRefusalCode` regex does not match the details form, and an `[unknown-command command=…]` prefix is not one of its refusal codes, so its connection state is unaffected.
- **Node link** rethrows `fromWire(body)` (class, code, details); the gateway's existing `toWire` answer then relays it unchanged through `invoke_on_node`.
- **Web HTTP:** `GatewayHttpError(status, message, body?)` keeps the body's `code` (the gateway's code form) and, for an incompatibility, its `details` bounded by the protocol schema; `node-transport.ts` passes the parsed body.
- **Two readers.** `incompatibility(error, command)` (code, IPC form, then exact legacy text) for callers that know the command; new `incompatibilityOfAnyCommand(error)` for classifiers that do not (`classifyReadError`, `classifyTransportError`, `mediaStreamFailure`, `classifyWebAnnotationError`): codes as usual, legacy text only when the message *starts* with the backend's answer (what those classifiers did). Fallbacks to an older command check `?.code === "unknown-command"` (an `unsupported-field` must not fall back to a command that ignores a critical field); "this backend cannot" states (portal, project copy, read `unsupported`) accept any code.
- **Matchers replaced:** web `isUnsupportedBackendCommand` (deleted, with `lib/backend/unsupported-command.test.ts`), the portal helper `lib/portal/unknown-command.ts` (deleted, with its test), direct `isUnknownCommandError` uses (`boot-hydration.ts`, `TicketSyncStrip.tsx`), the inline matches 0007 listed (`agent-handoff.ts`, `backend/agent-handoffs.ts`, `backend/terminals.ts`, `read-coordinator.ts`, `resource-sync.ts` ×2, `native-agent-sync-capabilities.ts` (moved there by 3016 from `useNativeAgentSession.ts`), `design-client.ts`, `chat/media-presentation.ts`, `portal-layout.ts`, `portal-store.ts`), plus two 0007 did not list (`web-annotations/client.ts`, `settings/DiagnosticsExportCard.tsx`). `isUnknownViewCommandError` (protocol `view-sync.ts`, 5 web callers) now delegates to `incompatibility`. Backend in-process readers of node-link errors (`control-mcp-machine-load`, `coordinator-node-tickets`, `node-service`, `node-coordination`, `node-setup-approvals`, `commands-registry-coordinator-nodes`) and `node-project-copy`'s loose `/unknown|not found|unsupported/` matcher use `incompatibility` too. The portal's "… is not available in this backend" check stays: it is a feature-off answer, not version skew.
- **`media-presentation.ts`** used `!code && …`: a coded error has a `code`, so the check is now unconditional (an incompatibility is the fallback).
- **UI helper:** `describeIncompatibility(error, machine, command?)` (`apps/web/src/lib/describe-incompatibility.ts`), `machine` a label or `{ label, version? }` → "Not available on <machine> (version x). Update it." (version only when known; no caller has the machine's version at hand yet, 5006 may pass it). Used by `DiagnosticsExportCard` (it showed "This machine's backend is too old …" for any text containing "unknown command"). The other callers either take a fallback, hide the section, or show a feature-specific message (`agent-handoff.ts` keeps "Continuing in another agent needs a newer Orkestrator backend …", pinned by `AgentInfoButton.test.tsx`; web annotations keep their "unavailable" reason), so none shows a raw incompatibility error any more.
- **Guard:** `tests/unit/unknown-command-text-guard.test.ts` scans non-test renderer source (comments removed) for the legacy wording, `Unknown command:`, regexes for either, and `isUnknownCommandError`; a self-test pins that it recognises each replaced form. Not added to `tests/source-guards/` (another agent was editing that framework).
- **Test fixtures:** `TestNodeNetwork` (`node-network-test-support.ts`) now answers like the real gateway (`toWire(unknownCommand(...))`); the gateway envelope and desktop IPC harness backends throw `unknownCommand` as `OrkestratorBackend.invoke` does. `portal-layout.test.ts` hand-typed the never-sent `Unknown command:` wording (0007's note); it now runs coded and legacy answers.
- **Effect:** the error classes stay 1002's `Data.TaggedError`s and details are bounded by 1002's Effect Schema (`IncompatibilityDetailsSchema`, extended with `command`). Deliberately not Effect: `ipc-error.ts` (the preload bundle has no Effect), the readers and `describeIncompatibility` (synchronous predicates on any thrown value).
- **No visual screenshot** was taken for the changed Diagnostics error text (a string change in an existing alert; sub-agents do not drive the app here).
- Aggregate suite left to review preparation.
- Typecheck on 2026-11-07: protocol, backend, desktop and web clean. Two backend failures in the wide run are other agents' work in progress (`commands-registry-contracts.test.ts` "no definitions yet" vs a newly defined command; `control-mcp-machine-load.integration` from the typed-emit migration); oxlint warnings for unused event-constant imports in `node-service.ts`, `node-coordination.ts`, `node-project-copy.ts` are the same in-progress migration.

## Work log

- 2026-11-07 (claude-worker): protocol: `details.command`, `incompatibilityOfAnyCommand`, `incompatibilityIpcMessage`, `contract/ipc-error.ts` (`formatIpcIncompatibility`, `parseIpcIncompatibility`), `isUnknownViewCommandError` over `incompatibility`. Backend: every unknown-command site throws `unknownCommand` (domain from the envelope at the top level); node link rethrows `fromWire`; backend readers converted. Desktop: `BackendHttpClient` rebuilds, main sends the IPC message form, preload sets `code`/`details`. Web: `GatewayHttpError` `code`/`details`, all matchers replaced, two helpers deleted, `describeIncompatibility`. Tests: protocol contract + unknown-command + view-sync (pass); backend `node-link`, `node-project-copy-update` (new), `gateway-invoke-envelope`, `backend-core`, `commands-registry-contracts` and the nodes/public-api/control-mcp set (1526 pass; 2 failures from other agents' work); desktop `invoke-envelope-ipc`, `preload-api`, `main-ipc`, `node-ipc`, `electron-bundle` (100 pass); web 21 related files (778 pass, the 2 failures fixed after) and a second set of 10 (pass); `tests/unit/unknown-command-text-guard.test.ts` (2 pass).
