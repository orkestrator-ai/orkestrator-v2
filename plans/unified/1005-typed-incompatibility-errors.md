---
id: 1005
title: "Typed incompatibility errors end to end"
phase: 1
plan: "§11.2 Typed incompatibility errors and §12 Phase 1.3"
status: not-started
depends_on: [1002, 0007]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Backend: throw a coded error (`code: "unknown-command"`, `domain` when known) from every unknown-command site. Keep the message text unchanged so that older clients' text matching still works.
- [ ] Backend: carry `unsupported-version` and `unsupported-field` from [1003](1003-backend-register-overload.md) with `{domain, range, field}` in the error body. Bound the body: the field name ≤ 64 characters, and never an argument value.
- [ ] Web: add `code` and a bounded `details` to `GatewayHttpError`, read from the JSON error body.
- [ ] Desktop: keep `code` and `details` across IPC (main serialises them; preload rebuilds the error).
- [ ] Replace every matcher with `incompatibility(error)` from `@orkestrator/protocol/contract/errors`. It reads `code` first and falls back to text for pre-contract nodes. Delete `isUnsupportedBackendCommand` and the portal helper once no callers remain.
- [ ] One UI helper: `describeIncompatibility(error, machineLabel)` → "Not available on <machine> (version x). Update it." Use it where the callers above currently show a raw error.

## Tests

- [ ] Each transport keeps `code` and `details` (gateway test, desktop IPC test, node-link test).
- [ ] `incompatibility()` against coded errors, legacy text, and unrelated errors.
- [ ] A source guard (or test) shows that no `Unknown backend command` / `Unknown command:` text matching remains in `apps/web/src` outside the protocol helper.

## Done when

- [ ] All matchers are gone and all three transports carry codes.
