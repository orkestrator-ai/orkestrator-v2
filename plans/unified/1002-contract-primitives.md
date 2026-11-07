---
id: 1002
title: "Contract primitives: domains, commands, events, envelope, error codes"
phase: 1
plan: "§11.2 and §12 Phase 1.1"
status: not-started
depends_on: [1001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 1002 · Contract primitives: domains, commands, events, envelope, error codes

- **Report:** [§11.2 Design](../../docs/reports/unified-federation.md#112-design)
- **Decisions:** 13.6 (adaptation on both sides), 13.8 (schema library, settled by [1001](1001-schema-library-spike.md)), 13.9 (per-domain versions, about 25 domains)
- **Depends on:** [1001](1001-schema-library-spike.md)
- **Blocks:** [1003](1003-backend-register-overload.md), [1004](1004-hello-domains.md), [1005](1005-typed-incompatibility-errors.md), [1009](1009-domain-clients-and-adapters.md), [7011](7011-typed-events.md)
- **Size:** S–M
- **Track:** C (contract)

## Goal

Browser-safe definitions that the backend, web, desktop and CLI share, so that a command or event has one definition.

## Current state (verified 2026-11-07)

- `packages/protocol` has no `contract/` folder. A `define*` pattern exists in `packages/protocol/src/log-vocabulary/define.ts`.
- The `exports` map lists all 329 subpaths by hand. There are no wildcards and no `"."` entry.
- Top-level `src/*.ts` must be browser-safe. Node-only code goes in `src/node/` and fixtures in `src/testing/` (AGENTS.md, lint-enforced).
- Errors today are `{ error, code? }`, with `code` matching `/^[a-z][a-z0-9-]{0,63}$/` (`gateway-handlers.ts:170-192`).

## Work

- [ ] `packages/protocol/src/contract/domain.ts`:
  - `defineDomain({ name, version })`;
  - a `DOMAIN_NAMES` list seeded from Appendix E: environments, projects, config, native-sessions, transcripts, terminals, files, git, pull-requests, pipelines, graphs, multi-review, kanban, agent-mail, accounts, docker, previews, web-annotations, design, mcp, nodes, node-mail, ticket-sync, system, coordinator, agent-servers, claude-tmux.
  - Domain names follow the hello capability name pattern `/^[a-z][a-z0-9-]*$/`.
- [ ] `contract/command.ts`: `defineCommand({ domain, name, since, access: "workspace" | "admin" | "internal", read, args, result, critical })`, plus the type helpers `ArgsOf<C>` and `ResultOf<C>`. Results that are pre-encoded JSON declare `encoded: true` (see [1003](1003-backend-register-overload.md)).
- [ ] `contract/event.ts`: `defineEvent({ domain, name, payload })`, with `PayloadOf<E>`.
- [ ] `contract/envelope.ts`:
  - the invoke envelope `{ command, args, domain?, version?, critical? }`;
  - a bounded guard: `critical` holds at most 16 names, each a valid arg key.
- [ ] `contract/errors.ts`:
  - the codes `unknown-command`, `unsupported-version` and `unsupported-field`;
  - the payload `{ domain?, range?: {min, max}, field? }`;
  - one `incompatibility(error)` reader that accepts both coded errors and the legacy text, using `isUnknownCommandError`.
- [ ] `contract/client.ts`: the scope-agnostic `domainClient(domain, { [version]: (call) => api })` type, and the version selection `pickVersion(clientVersions, negotiated)`. This lives in protocol, not web, because the pilot domain ([1010](1010-pilot-node-mail-and-ticket-sync.md)) is called backend to backend.
- [ ] Add each subpath to `packages/protocol/package.json` `exports`.
- [ ] Add a lint/test pin that `contract/**` stays browser-safe (extend `tests/unit/domain-import-boundaries.test.ts`).

## Tests

- [ ] Envelope guard: bounds, malformed `critical`, unknown keys ignored.
- [ ] `pickVersion` over overlapping, disjoint and pre-contract (no `domains`) ranges.
- [ ] Every `DOMAIN_NAMES` entry passes the hello name pattern.

## Done when

- [ ] Primitives are exported from protocol with tests, and nothing uses them yet. This change is behaviour-neutral.
