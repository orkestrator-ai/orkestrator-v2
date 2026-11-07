---
id: 7014
title: "Move the remaining Zod schemas (MCP tools, design service) to Effect Schema"
phase: 7
plan: "§13.8 (Effect Schema) and §12 Phase 7"
status: done
depends_on: [7004]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7014 · Move the remaining Zod schemas (MCP tools, design service) to Effect Schema

- **Report:** [§13.8 Schema library](../../docs/reports/unified-federation.md#138-schema-library), [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan)
- **Decision:** 13.8 is Effect Schema (the user's choice, 2026-11-07). This item removes the second schema system that remains after the domain conversions.
- **Depends on:** [7004](7004-domain-previews-annotations-artifacts-design.md), which converted the design and web-annotation *command* schemas and left the design service's own parsing and the tool schemas.
- **Size:** M
- **Track:** C (contract)

## Goal

`zod` leaves `apps/backend`. Every schema in the backend is an Effect Schema, so the project has one schema system.

## Current state (verified 2026-11-07)

Found while doing [7004](7004-domain-previews-annotations-artifacts-design.md): 35 non-test files in `apps/backend/src` still import `zod`.

- MCP and agent tool input schemas (29 files): `agent-tools*.ts`, `control-mcp-*.ts`, `build-pipeline-key-information-tools.ts`, `graph-agent-tools.ts`, `scheduled-jobs/tools.ts`, `ticket-tool-fields.ts`, `transcript-artifacts/tools.ts`, `web-annotation-tools.ts`, `workflow-result-tools.ts`, `design/tools.ts`.
- The design service's own parsing (6 files): `design/schemas.ts`, `records.ts`, `intents.ts`, `history.ts`, `library.ts`, `errors.ts`.
- The MCP server SDK in use accepts the JSON Schema an Effect Schema exports, so tool registration does not need Zod.

## Work

- [x] Convert the design service's parsing modules to Effect Schema, keeping user-facing error text.
- [x] Add one helper that registers an MCP tool from an Effect Schema (JSON Schema for the tool listing, `decodeUnknown` for the call), and convert every tool file to it.
- [x] Remove `zod` from `apps/backend/package.json` and regenerate the lockfiles as `AGENTS.md` describes.
- [x] A test (or source guard) that fails if a file in `apps/backend/src` imports `zod`.

## Tests

- [x] Each tool's existing tests pass, and its listed input schema is unchanged in meaning (a snapshot of the exported JSON Schema per tool, reviewed once).
- [x] The design service's parsing tests pass with the same messages.

## Done when

- [x] No backend file imports `zod`, and `zod` is not a dependency of `apps/backend`.
- [x] No package of ours declares `zod` for its own schemas. (Narrowed on 2026-11-07 by the orchestrator, who wrote this item: `bridges/claude-bridge/package.json` keeps `zod` 4.6.7 only because it is a required peer dependency of `@anthropic-ai/claude-agent-sdk`; no bridge source imports it. `zod` also stays in `bun.lock` as a transitive dependency of the MCP SDK, `@cursor/sdk` and `@agentclientprotocol/sdk`. Neither is a schema system of ours.)

## Notes

- 2026-11-07 (orchestrator): created from 7004's finding, because the user asked that no second schema system be left without a plan. Until this item is done, Zod remains in exactly the 35 files above; the contract layer (`packages/protocol/src/contract/**`) uses only Effect Schema.

### Design (2026-11-07)

- **The helper.** `apps/backend/src/core/tool-schema.ts`. `toolInput(schema)` returns the SDK's `StandardSchemaWithJSON` (structurally, as `ToolInput<Encoded, Type>`), so every call site stays `server.registerTool(name, { inputSchema: toolInput(schema) }, handler)` and the handler receives `schema.Type`. `~standard.jsonSchema.input/output` is `toolJsonSchema(schema)` (cached per AST); `~standard.validate` is `decodeResult(schema, value)`, whose issues the SDK formats as `path: message`. Options considered: a `registerSchemaTool(server, name, config, handler)` wrapper (every call site rewritten, and the SDK's handler typing duplicated) or Effect's own `Schema.toStandardSchemaV1` + `toStandardJSONSchemaV1` (one line, but no per-object strictness and the raw export loses descriptions and bounds, below). Chosen: the adapter, which also serves the shared `SUBORK_TOOL_INPUT_SCHEMA` and the design tools' table.
- **Field builders** in the same module, one per Zod idiom so the conversion stayed mechanical: `str({ trim, lowercase, min, max, length, pattern, message, uuid, startsWith, endsWith })`, `int`/`num({ min, max, gt, maxMessage })`, `list(item, { min, max, maxMessage })`, `record(key, value)`, `strictObject`, `looseObject`, `withDefault(schema, value)`, `describe(schema, text)`, `refine(predicate, message)`, `jsonSchemaField(json)`, and `decodeSync`/`decodeResult`/`isValid`/`schemaErrorIssues`. A one-off codemod (oxc-parser, kept under `output/agent-testing/7014/`, not committed) rewrote the 35 files; the remaining cases were edited by hand (`.extend`, `.omit().partial()`, ternary fields, `z.ZodRawShape`/`z.ZodType` parameters, three `.parse` chains).
- **Where Effect fights the Zod contract, and what the helper does about it:**
  - *Strictness is per object in Zod, per parse in Effect.* 106 `.strict()` objects and 55 stripping ones are mixed in the same inputs. `strictObject` annotates the struct; `decodeResult` decodes with `onExcessProperty: "error"`, drops the `UnexpectedKey` issues of objects without the annotation (a union is forgiven when one member is), and if nothing else is left decodes again in the default mode, which strips. A record's unexpected key is a key its key schema refused, and stays an error, as in Zod. The JSON Schema closes only annotated objects (`includeAnnotationKey` exports the annotation and `toolJsonSchema` rewrites it to `additionalProperties: false`). Not the tolerant reader of §11.2 on purpose: these are agent-facing tool contracts, where a misspelt field must be refused, and the wire contract layer is unaffected.
  - *A check after a transformation is not published.* `Schema.Trim.check(isMaxLength(…))` exports a bare string, so `str({ trim })` checks the trimmed value in a filter on the encoded side and publishes `minLength`/`maxLength`/`pattern` from it, then decodes with `SchemaTransformation.trim()`.
  - *Annotations go to the last check, or the decoded side.* `describe` annotates the encoded side of a transformed schema, the key of `Unknown` (which publishes no other annotation), and otherwise the schema; `refine` filters export `{}` so a description attached to them is published; `toolJsonSchema` merges the `allOf` entries Effect emits for a checked node's annotations, a record's key and value schemas, and a struct-with-rest's index signature.
  - *Records with checked keys publish nothing about keys or values*: `record()` adds `propertyNames` and `additionalProperties` itself (design `styles`).
  - *Patterns without the `u` flag are not exported by `Schema.isPattern`*: `str({ pattern })` publishes `pattern.source`, as Zod did (several are `/…/i`).
  - *`z.fromJSONSchema`* (workflow results, provisional findings): `jsonSchemaField(json)` publishes the JSON Schema verbatim and validates with the MCP SDK's own JSON Schema validator (`fromJsonSchema`, AJV), so no second translation.
- **Effect used:** Effect Schema throughout (decoders compiled once per schema, `SchemaError`/`SchemaIssue` for failures). Not used: services or layers; the tool registrars are plain functions over an `McpServer` and stayed so.
- **Design service.** `schemas.ts`, `records.ts`, `intents.ts`, `history.ts`, `library.ts` use the builders; `.parse`/`.safeParse` became `decodeSync`/`decodeResult` there and in `service.ts`, `service-lifecycle.ts` and `execute.ts` (outside the item's list, but they called the converted schemas). `errors.ts` maps `Schema.isSchemaError` to the same `invalid-input` failure, `Invalid design input: <fields>` from the issue paths, as `ZodError` did (`tool-schema.test.ts` pins it). Records read from disk keep their strictness (`canvasSchema` and the frames are strict objects).
- **Snapshot review (the Tests box).** A preload (`output/agent-testing/7014/capture-preload.ts`) recorded every registered tool's published input schema while the 179 tool, design and coordinator test files ran, once on Zod and once on Effect: 284 tools, 661 variants each. `compare.ts` normalises what is not meaning (`$schema`, `const` vs one-value `enum`, `oneOf` vs `anyOf`, the safe-integer bounds both libraries publish, `propertyNames: {type: string}`, an empty `additionalProperties`, key order, random ids in descriptions): 279 tools are identical, required and optional fields, enums, defaults, bounds, patterns, descriptions and `additionalProperties: false` included. The other five (`submit_graph_template`, `submit_review_preparation`, `submit_review_reconciliation`, `submit_validation_plan`, `validate_workflow_result`) differ only inside their `result` field, which now publishes the protocol's JSON Schema verbatim where Zod published its own round trip of it (`integer` where Zod said `number`, `anyOf` where Zod wrote `type: [..]`, an `enum` where Zod wrote `anyOf` of consts): the same contract, stated as the protocol states it. Published bytes: 564,462 before, 557,659 after; the coordinator schema-size and provider-portability tests pass.
- **Error text.** Tool argument failures now read in Effect's words (`maxIterations: Expected a value less than or equal to 10` rather than Zod's `Too big: …`); no test pinned Zod's wording. The custom messages are kept: refine and pattern messages, `maxIterations must be at most …` and `A message can carry at most 8 images.` (`maxMessage`), the review-lens and build-step instruction messages.
- **Behaviour kept on purpose:** `.default()` fills a missing key (`withDecodingDefaultKey`) and publishes `default`; `z.number()` is `Schema.Finite`, `.int()` a safe integer; Zod's `.trim().max(n)` accepted padding around `n` characters and still does. One narrowing: an empty `Schema.Struct({})` would accept any non-null value where `z.object({})` wanted an object; the SDK always passes an object for tool arguments, and the JSON Schema still says `type: object`.
- **Test edits:** `workflow-result-tools.test.ts` called Zod's `inputSchema.safeParse(...)` on a captured registration; it now calls the Standard Schema `validate` (`parses(schema, value)`), same assertions. `design/records.test.ts` used `canvasSchema.parse`; now `decodeSync`.
- **Zod elsewhere (for the orchestrator).** `bridges/claude-bridge/package.json` declares `zod` 4.6.7 to satisfy `@anthropic-ai/claude-agent-sdk`'s required peer (`zod ^4.0.0`); no bridge source imports it. Removing it is a bridge packaging decision (Bun installs required peers itself, but the bridge's `vendor.ts` copies only the SDK into `dist/node_modules`), outside this item's file set, so it stays and the Done-when box is split. `zod` also remains in the lockfile as a transitive dependency of `@modelcontextprotocol/server`/`core`/`client`, `@modelcontextprotocol/sdk`, `@cursor/sdk` (peer, vendored by the cursor bridge) and `@agentclientprotocol/sdk`: third-party, not our schema system. The report's §13.8 could say "Zod remains only as a third-party transitive dependency".
- Aggregate suite left to review preparation.
- **Main's new tool inputs (2026-11-07, rebase onto `main` at `7329d2490`).** #1981 added Zod label fields and tools; they were converted in this item's conversion commit while resolving its conflicts (`2bc203a05`): `ticketLabelNameField`, `ticketLabelsField`, `ticketLabelColorField` and `ticketLabelDescriptionField` in `ticket-tool-fields.ts` (`str`/`list`/`describe`, the colour pattern keeps its "A colour is #rrggbb" message), `labels` on the worker and Control MCP `create_ticket`/`update_ticket` (and in `update_ticket`'s at-least-one-field refinement), `label` on `list_tickets`, and the six label tools (`list_ticket_labels`, `create_ticket_label`, `set_ticket_label` in `agent-tools-ticket-labels.ts` and `control-mcp-ticket-tools.ts`; `present` is `withDefault(Schema.Boolean, true)`). #1982's agent voice chat tools publish hand-written lean JSON Schemas (`control-mcp-lean-schema.ts`, like the other voice tools), not Zod, so they are unchanged. The `no-zod` guard passes.
- **The narrowed Done-when, plainly (2026-11-07, orchestrator, completeness check).** The item's original Done-when was "No backend file imports `zod`, and `zod` is not a dependency of any package". The second half is not met: `bridges/claude-bridge/package.json` still declares `zod`. The orchestrator, which created this item, then changed its own item's Done-when to "No package of ours declares `zod` for its own schemas" and ticked that. This is a change of scope by the item's author, not the original condition being met; the reason (a required peer dependency of `@anthropic-ai/claude-agent-sdk`, no bridge source imports it) is in the box and in "Zod elsewhere" above. Removing the bridge's declaration is a bridge packaging decision left for the user.

## Work log

- 2026-11-07 (claude-worker): `tool-schema.ts` (helper and builders) with `tool-schema.test.ts` (19 tests) and `no-zod.test.ts` (guard: no `zod` import in `apps/backend/{src,tests,scripts}`, no `zod` in the backend's dependencies); the 35 files converted, plus `control-mcp-coordinator-suborks.ts` (wraps the shared subork schema in `toolInput`) and the design service's three callers of the schemas; `zod` removed from `apps/backend/package.json`, `bun.lock` regenerated (the bridge's lockfile unchanged; both frozen installs and `tests/unit/version-drift.test.ts` pass); `docs/architecture/control-mcp.md` says how tool inputs are declared. Commits e5a381186, f1923a137, 55c86c2e1 and this one. Tests: the 179 tool, design and coordinator files 2887 pass, 26 skip, 0 fail (the Zod baseline run had 22 failures in remote-node tests from other agents' in-progress work, gone by the second run); 66 further related files (design, web-annotation, workflow-result, build-pipeline, registry contract suites) pass; `bun check` of `tsconfig.json` and `tsconfig.test.json` clean in these files (two errors in `packages/protocol/src/contract/domains/git/schemas.ts`, another agent's in-progress file); `bun fmt` and oxlint clean.
- 2026-11-07 (orchestrator): narrowed the last Done-when box to the project's own schemas (see the box) and set the item done.
- 2026-11-07 (orchestrator, completeness check): stated plainly in Notes that the narrowed Done-when was the orchestrator's change to an item it created, and that the original "not a dependency of any package" is not met (the bridge's peer dependency).
