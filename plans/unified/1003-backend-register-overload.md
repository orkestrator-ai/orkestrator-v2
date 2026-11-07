---
id: 1003
title: "Backend: register(def, handler) and the invoke envelope"
phase: 1
plan: "§11.2 and §12 Phase 1.2"
status: not-started
depends_on: [1002]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Overload `CommandRegistrar`: `register(name, handler)` and `register(def, handler)`. The def form records the definition in a registry-side `contracts` map that [1006](1006-contract-manifest-generator.md) reads.
- [ ] Make every wrapping registrar forward both forms (the four sites above). Add a test that a def registered through each wrapper appears in the `contracts` map.
- [ ] Argument parsing for def commands:
  - strip unknown keys;
  - refuse an unknown key named in the envelope's `critical` with `unsupported-field`;
  - refuse a schema failure with the existing validation error text, so messages users see do not change.
- [ ] Result validation in `NODE_ENV=development|test` only. Skip `encoded: true` results (the transcript splice).
- [ ] HTTP: parse the envelope fields next to `command` and `args`. When `domain` and `version` are present and outside the backend's range, answer `unsupported-version` with the range.
- [ ] Desktop IPC: add an optional third `envelope` argument to `orkestrator:invoke` and the preload `invoke`, and forward it to the backend client. Older renderers send two arguments and keep working.
- [ ] Node link: send the envelope from `node-link.ts` when the peer's hello advertises the domain (after [1004](1004-hello-domains.md); leave a TODO box there).
- [ ] Mixed strictness rule from §11.4, enforced in review: never switch a lenient handler to rejecting unknown keys. A strict handler that adopts `defineCommand` becomes tolerant with critical fields.

## Tests

- [ ] Registry: def and string registrations coexist; a duplicate name across forms throws.
- [ ] Parsing: unknown field stripped; unknown critical field refused with code and field; result validation fires in test mode and skips encoded results.
- [ ] HTTP envelope through the gateway, the relay and Electron IPC (desktop test), including an older two-argument IPC call.

## Done when

- [ ] One throwaway def command (in a test) works on all three transports, and `mise run test` passes with no handler converted yet.
