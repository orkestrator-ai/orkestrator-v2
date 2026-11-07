---
id: 1002
title: "Contract primitives: domains, commands, events, envelope, error codes"
phase: 1
plan: "§11.2 and §12 Phase 1.1"
status: done
depends_on: [1001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] `packages/protocol/src/contract/domain.ts`:
  - `defineDomain({ name, version })`;
  - a `DOMAIN_NAMES` list seeded from Appendix E: environments, projects, config, native-sessions, transcripts, terminals, files, git, pull-requests, pipelines, graphs, multi-review, kanban, agent-mail, accounts, docker, previews, web-annotations, design, mcp, nodes, node-mail, ticket-sync, system, coordinator, agent-servers, claude-tmux.
  - Domain names follow the hello capability name pattern `/^[a-z][a-z0-9-]*$/`.
- [x] `contract/command.ts`: `defineCommand({ domain, name, since, access: "workspace" | "admin" | "internal", read, args, result, critical })`, plus the type helpers `ArgsOf<C>` and `ResultOf<C>`. Results that are pre-encoded JSON declare `encoded: true` (see [1003](1003-backend-register-overload.md)).
- [x] `contract/event.ts`: `defineEvent({ domain, name, payload })`, with `PayloadOf<E>`.
- [x] `contract/envelope.ts`:
  - the invoke envelope `{ command, args, domain?, version?, critical? }`;
  - a bounded guard: `critical` holds at most 16 names, each a valid arg key.
- [x] `contract/errors.ts`:
  - the codes `unknown-command`, `unsupported-version` and `unsupported-field`;
  - the payload `{ domain?, range?: {min, max}, field? }`;
  - one `incompatibility(error)` reader that accepts both coded errors and the legacy text, using `isUnknownCommandError`.
- [x] `contract/client.ts`: the scope-agnostic `domainClient(domain, { [version]: (call) => api })` type, and the version selection `pickVersion(clientVersions, negotiated)`. This lives in protocol, not web, because the pilot domain ([1010](1010-pilot-node-mail-and-ticket-sync.md)) is called backend to backend.
- [x] Add each subpath to `packages/protocol/package.json` `exports`.
- [x] Add a lint/test pin that `contract/**` stays browser-safe (extend `tests/unit/domain-import-boundaries.test.ts`).

## Tests

- [x] Envelope guard: bounds, malformed `critical`, unknown keys ignored.
- [x] `pickVersion` over overlapping, disjoint and pre-contract (no `domains`) ranges.
- [x] Every `DOMAIN_NAMES` entry passes the hello name pattern.

## Done when

- [x] Primitives are exported from protocol with tests, and nothing uses them yet. This change is behaviour-neutral.

## Notes

### Where Effect is used (2026-11-07)

- **Effect Schema** for every schema: command `args`/`result`, event payloads, the invoke envelope (`InvokeEnvelopeSchema`) and the incompatibility wire body (`IncompatibilityWireSchema`, `IncompatibilityDetailsSchema`). The envelope and error schemas follow 1001's export rules (`Schema.Int`/`Schema.Finite`, `optionalKey`, `u`-flag patterns), so 1006 can digest them.
- **`Result`** (`effect/Result`) is the return type of every decode/validate helper (`decodeCommandArgs`, `validateCommandResult`, `decodeCommandResult`, `decodeEventPayload`, `validateEventPayload`, `decodeInvokeEnvelope`). Chosen over throwing so the failure type is in the signature, and over `Effect` because every caller (the registry in 1003, transports in 2011) is synchronous or promise-based and needs no runtime.
- **`Data.TaggedError`** for all errors (`UnknownCommandError`, `UnsupportedVersionError`, `UnsupportedFieldError`, `InvalidEnvelopeError`, `InvalidCommandArgsError`, `InvalidCommandResultError`, `InvalidEventPayloadError`).
- Deliberately not Effect: `defineDomain`/`defineCommand`/`defineEvent`/`domainClient` return plain frozen objects; `pickVersion` is a plain function. Nothing needs services, scopes or fibers here.

### Decisions (2026-11-07)

- **Error classes: `Data.TaggedError` with a `code` property and a `message` field, not `Schema.TaggedErrorClass`.** A tagged schema class encodes as `{ _tag, ...fields }`, which is not the gateway's existing body. `Data.TaggedError` instances are real `Error`s whose `message` and `code` the gateway already serialises as `{ error, code }` (`gateway-handlers.ts:170-176`) and the node link already keeps. The JSON form is a separate Effect Schema (`IncompatibilityWireSchema`: `{ error, code, details? }`) with `toWire(error)` / `fromWire(body)`. `fromWire` rebuilds the class and drops malformed details as a whole (and a range with `min > max`) rather than refusing the error.
- **`unknown-command` keeps the legacy message** (`unknownBackendCommandMessage`), so older clients' text matching keeps working (1005).
- **`incompatibility(error, command?)`** reads `code` first; details come from a `details` object when present (a transport-rebuilt error or wire body, the shape 1005 adds to `GatewayHttpError` and IPC), otherwise from the error's own `domain`/`range`/`field`. Legacy text is read only when `command` is passed, through `isUnknownCommandError`, because that helper matches one exact command.
- **Critical fields.** The definition's `critical` lists the arg keys a sender must mark critical; `buildInvokeEnvelope(def, args, version?)` sends only those actually present. On the receiver, `decodeCommandArgs(def, raw, { critical })` refuses a listed key only when the definition does not declare it **and** the arguments carry it (own property, not `undefined`); a listed key that is absent is ignored, since there is nothing to misunderstand. This keeps a client that always sends its static critical list from being refused for a field it did not use.
- **Envelope guard refuses rather than drops.** A malformed `critical` (not an array, over 16, or a name that is not an identifier of at most 64 characters), `domain` (hello name pattern) or `version` (integer 0 to 1000) refuses the whole envelope with a value-free `InvalidEnvelopeError`. Dropping a must-understand list would silently downgrade the call. Unknown envelope keys are ignored. `command` is only required to be a string, as the gateway checks today; `args` may be absent.
- **`defineDomain({ name, version, min? })`**: `min` (the oldest version still accepted, which 1004 advertises) defaults to `version`, so accepting older peers is declared explicitly. Versions are 1 to 1000; 0 is reserved for the legacy adapter. Only names in `DOMAIN_NAMES` are accepted, so the list is the one place new domains appear.
- **`DOMAIN_NAMES` adds `node-files`** to the item's seed list, because [1010](1010-pilot-node-mail-and-ticket-sync.md) defines that domain. 28 names, all under the hello's 64-entry bound.
- **`args` must be a `Schema.Struct`** (the `ArgsSchema` constraint requires `fields`), so the known argument keys are the struct's field names and `critical` is type-checked against them (`ArgKeyOf<Args>`). Schemas must need no Effect services and should be JSON-shaped (`Type` equals `Encoded`), because production sends results unencoded; `EncodedArgsOf`/`EncodedResultOf`/`EncodedPayloadOf` name the wire form.
- **`pickVersion(clientVersions, negotiated)`**: `negotiated` is the node's `{ min, max }` for the domain, or `null`/`undefined` when the node gives none (no `domains` at all, or a domain it does not advertise because it has no defined commands there yet). Both mean version 0 only. Returns the highest client version in range, or `null` when disjoint (1009 turns that into a coded `unsupported-version`). `NegotiatedDomainRange` is reused from `node-client.ts` (type import).
- **`domainClient(domain, adapters)`** requires an adapter for the domain's current version and refuses keys outside `0..version`; `versions` is sorted highest first. Building the client over a transport and caching per generation stay in 1009.
- **Exports:** `./contract` (index re-exporting everything) plus one subpath per module: `./contract/client`, `command`, `domain`, `envelope`, `errors`, `event`.
- **Browser-safety pin** needed a new `.oxlintrc.json` override for `packages/protocol/src/contract/**/*.ts` (outside this item's file set; one block, same shape as the graphs and log-vocabulary blocks, also covering nested `contract/domains/` for 1010). `tests/unit/domain-import-boundaries.test.ts` pins that `node:`/`bun:`, `testing/` and value imports from `node/` are refused at both depths and that test files keep their exemption.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `packages/protocol/src/contract/` (`domain.ts`, `command.ts`, `event.ts`, `envelope.ts`, `errors.ts`, `client.ts`, `index.ts`) with tests (41 pass across 6 files; 48 with `unknown-command.test.ts` and `effect-json-schema.test.ts`), the seven `exports` entries, the `.oxlintrc.json` contract override and the boundary pin (`domain-import-boundaries.test.ts`, 22 pass). Protocol typecheck, oxlint and `bun fmt` clean. Nothing uses the primitives yet, so the change is behaviour-neutral.
