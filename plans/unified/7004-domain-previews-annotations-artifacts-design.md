---
id: 7004
title: "Convert previews, web annotations, transcript artifacts and design"
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

# 7004 · Convert previews, web annotations, transcript artifacts and design

- **Report:** [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix E](../../docs/reports/unified-federation.md#appendix-e-command-surface-by-domain), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [1011](1011-contract-policy-and-docs.md)
- **Recommended before the web side:** [3002](3002-lib-backend-client-parameter.md) and [2011](2011-scope-domain-negotiation.md). Until they land, the domain's `lib/backend` file calls the domain client bound to the command scope.
- **Parallel with:** the other Phase 7 domain items, and all of Phases 2-6
- **Size:** M
- **Track:** C (contract)

## Domains

`previews`, `web-annotations`, `transcripts` (artifacts and media part), `design`.

## Current state (verified 2026-11-07)

- Previews: 17 registered, 15 web. Web annotations: 37 and 37. Transcript artifacts and media: 16 and 15. Design: 35 and 32.
- Web annotations already have a Zod schema map (`commands-registry-web-annotations.ts:310`, all `.strict()`). Design handlers use Zod `.strict()` too (`core/design/commands.ts`). Decision 13.8 is now Effect Schema (2026-11-07), so these are a conversion from Zod to Effect Schema (or a Standard Schema bridge where a conversion is not worth it), plus relaxing `.strict()` to strip.
- Capability commands: `get_preview_capabilities`, `web_annotations_capabilities`, `transcript_artifact_capabilities` and `design_capabilities`. Design already does floor-based retirement (Appendix F).
- Preview services carry `protocolVersion`, per-surface availability and an epoch. Keep that response-level versioning.

## Work

Apply the conversion checklist from [1011](1011-contract-policy-and-docs.md)'s "Domain contracts" docs to every command in the domains above:

- [x] Define each domain at version 1 (min 1) in `packages/protocol/src/contract/domains/`. (`previews`, `web-annotations`, `design`; `transcripts` created here and shared with 7001, which owns its other commands.)
- [x] `defineCommand` for every command, with:
  - `args` and `result` schemas;
  - `access` (workspace, admin or internal), seeded from [0006](0006-grant-scope-live-evidence.md)'s observed list and today's deny-lists;
  - `read`, checked against `isNodeReadCommand`;
  - `critical` fields, with a one-line reason each in Notes.
- [x] Switch handlers to `register(def, handler)`.
  - Lenient handlers stay tolerant.
  - Strict (`assertOnlyKeys`) handlers become tolerant-with-critical.
  - Hand-written `commands-validation.ts` parsing is replaced by the schema where it is equivalent; keep user-facing error text.
- [x] Fold the domain's capability command (if any) into the domain version. Keep the command registered for pre-contract clients until its register row retires.
- [x] Web side:
  - a domain client in `apps/web/src/lib/node-scope/domains/<domain>.ts`, with a version-1 adapter and a version-0 legacy adapter that keeps today's capability gating;
  - the domain's `lib/backend` functions call it;
  - typed results replace `invoke<T>` casts.
- [x] Move the domain's shared types from `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` to inferred protocol types where they match (see [7010](7010-converge-models.md)). (Neither file holds a type of these domains; the duplicates that did exist moved, see Notes.)
- [x] Classify the register rows for these domains: retired, mechanical (adapter), or unaffected. Update `version-compatibility.md`.
- [x] Add a scenario module to [1012](1012-mixed-version-qualification.md)'s script for the domain's main flows.
- [x] Regenerate the manifest and the adapters list; the untyped baseline falls.


## Tests

- [x] Each converted handler passes its existing tests unchanged, apart from tests that asserted rejection of unknown keys, which now assert stripping (or the critical-field refusal). (Two web test edits outside that, both named in Notes.)
- [x] A domain-client test for each adapter version against fakes.
- [x] Contract CI stage 2 ([1008](1008-contract-ci-job.md)) accepts every in-window snapshot's arguments. (`mise run contract:ci` passes; every in-window release is pre-contract, so 0 fixtures today.)

## Done when

- [x] Every command in these domains is defined, the untyped count for them is zero, and the web uses domain clients for them. (105 defined: previews 17, web-annotations 37, design 35, transcript artifacts and media 16; untyped 0 in each. Aggregate suite left to review preparation.)

## Notes

### Where Effect is used (2026-11-07)

- **Effect Schema** for every definition: arguments and results of the 105 commands, the field checks the design v2 handlers decode inside their typed envelope, and `modelRecord`/`opaqueRecord` (`contract/model-schema.ts`, new): a result's model record validates its declared fields and passes every other key through (`Schema.StructWithRest` with an unknown rest), typed as the existing protocol interface. A plain struct would silently drop the undeclared keys the renderer reads when a client decodes a result. 7001 built the same idea as `openStruct`; the two can merge in 7010.
- **Deliberately not Effect:** the four domain clients and their web bindings are promise-based adapters over 1009's `createDomainClient` (synchronous selection, promise-based callers, no services or fibers), as in 1010.

### Zod to Effect, per schema (2026-11-07)

- **Web annotations** (`commands-registry-web-annotations.ts`): the whole `.strict()` schema map is converted to Effect Schema in `contract/domains/web-annotations/commands.ts`, field by field (bounded opaque ids with the old message, revisions `Int` 0 to `MAX_SAFE_INTEGER - 1`, text maxima, enums, the destination struct plus `isWebAnnotationDestination`, the capture as `Unknown` checked by `assertNoDeclaredProvenance` and `validateWebAnnotationCaptureInput`). `.strict()` became strip, nested objects too. A top-level `provenance` stays refused on the eight commands whose handler refused it, through a declared optional `Never` field with the old message: the safety check survives tolerant decoding. `reconcile_draft.value` is optional (`z.unknown()` accepted a missing key). No Standard Schema bridge. The rollout gate, the payload ceilings (256 KiB, 2 MiB, the asset size) and the outcome metrics ran before parsing; they still do through a new registration option, `register(def, handler, { beforeDecode })` (`commands-registry-types.ts`, `commands-registry-contracts.ts`, with a test), and decode failures keep the `Invalid <command> <field>: <reason>` form and the `invalid` outcome.
- **Design** (`core/design/commands.ts`): every per-field Zod parse is Effect Schema. The six legacy commands threw on bad input, so their definitions carry the precise schemas. The 29 v2 commands answered bad input as `{ ok: false, failure: invalid-input }` (a test pins it); a registry decode failure would throw before the handler, so their definitions declare the keys as `Unknown` and each handler decodes its fields with the exported Effect schemas (`DesignIdSchema`, `DesignRevisionSchema`, `DesignTokenSchema`, `DesignLibraryQuerySchema`, `DesignSessionLinkInputSchema`…) inside `typed()`; the failure message now names the field. The nested `.strict()` objects (`design_library.query`, `design_session_link.link`) strip. Left to the service, not bridged: `descriptor`, `drafts`, `intents`, `intent`, `clientId`, `rebaseTo`, `design_action.input`, validated by the deep `schemas.ts`/`tools.ts` unions the design MCP tools share. Option considered: a Standard Schema bridge (Zod 4 implements `~standard`) to put them in the argument schemas; rejected because the JSON Schema digest would not describe them and the service validates them anyway.
- **Previews and transcript artifacts** had no Zod: lenient hand-written checks that answer coded errors (`PreviewError:` marker, `ArtifactError` JSON) the clients parse. A schema refusal would lose the code and refuse values accepted today (§11.4), so their checked arguments are `optionalKey(Unknown)` and the handlers keep their checks. `transcript_media_pin` was strict (`Unknown arguments: …`); it is tolerant now.

### Zod remaining in the backend, and its plan (2026-11-07)

*(2026-11-07, orchestrator, completeness check: done since. [7014](7014-remaining-zod-to-effect-schema.md) moved these files to Effect Schema and dropped `zod` from `apps/backend`; only `apps/backend/src/core/no-zod.test.ts` names it, as guard fixtures. The web helper this item's Notes mention converged into `domainApi` (`lib/node-scope/domains/domain-api.ts`) in 7010, `4476f0b3d`.)*

35 non-test files still import `zod` (37 before; `commands-registry-web-annotations.ts` and `design/commands.ts` left): the MCP and agent tool input schemas (`agent-tools*.ts`, `control-mcp-*.ts` (17 files), `graph-agent-tools.ts`, `scheduled-jobs/tools.ts`, `ticket-tool-fields.ts`, `build-pipeline-key-information-tools.ts`, `workflow-result-tools.ts`, `web-annotation-tools.ts`, `transcript-artifacts/tools.ts`, `design/tools.ts`) and the design service's own parsing (`design/schemas.ts` operation and descriptor unions shared with `design/tools.ts`, `records.ts`/`intents.ts`/`history.ts`/`library.ts` for records read back from disk, `errors.ts` mapping `ZodError` to `invalid-input`). **Plan:** this is the one other schema system, and it is not ownerless: `@modelcontextprotocol/server` 2.3.1's `registerTool` accepts `StandardSchemaWithJSON`, which Effect Schema provides (`Schema.toStandardSchemaV1` plus `Schema.toStandardJSONSchemaV1`), so every tool schema can move to Effect in one item, `design/schemas.ts` and the design records with them (they share the unions), then `errors.ts` drops its `ZodError` branch and `zod` leaves `apps/backend/package.json`. **The orchestrator should add that item** (suggested: "Convert the MCP tool and design service schemas from Zod to Effect Schema"); until then no new Zod outside tool schemas.

### Decisions (2026-11-07)

- **Access** (seeded from the deny-lists; 0006's realm list names only `get_preview_capabilities` of these, as `workspace`): `admin` for `update_preview_settings` and `web_annotations_rollout_set` (both in `WORKSPACE_ADMINISTRATION_COMMANDS`), `workspace` for the other 103; nothing `internal` (no command here is called backend to backend). Candidates for `admin` when 7012 builds the allow-list: `get_preview_settings`, `get_preview_diagnostics`, `revoke_preview_access`, `record_preview_client_metrics`, `web_annotations_rollout`, `web_annotations_metrics`, `web_annotations_migrate`, `transcript_artifact_prepare_worker` (builds a Docker image on the host).
- **Read** equals `isNodeReadCommand(name)`, pinned by each domain's test: `true` only for previews' five `get_` commands. The regex reads none of the transcript artifact or web annotation reads (`transcript_artifact_get_publication`, `web_annotation_get`, …) as reads, and no design command; changing that is a routing change for 7012, not this item.
- **Critical fields**, one reason each:
  - `register_preview_service`, `update_preview_service`, `remove_preview_service` `operationId`: the idempotency key; a receiver ignoring it would apply a retry twice.
  - `remove_preview_service.expectedRevision`: compare-and-set; ignoring it would delete a definition someone else changed.
  - `revoke_preview_access.serviceId`: without it every service's access closes; ignoring it widens a one-service revocation to all.
  - `transcript_media_open_stream.containerId`, `transcript_media_pin.containerId`: they name the container the path is in; ignoring them would serve or pin the host file of the same name.
  - `web_annotation_resolve.expectedResultRevision`: compare-and-set on the result; ignoring it accepts a result revised since the user saw it.
  - `web_annotation_request_prepare.textOnly`: ignoring it attaches screenshots the user left out.
  - `web_annotation_request_prepare.retargetOf`: ignoring it sends the notes to a second destination without cancelling the first request.
  - `design_session_resume.expectedTabId`: compare-and-set on the link's tab; ignoring it lets two windows adopt one conversation.
  - Not critical, because ignoring them fails safe: `design_export_save.replaceFingerprint` (the save refuses to replace), `design_session_link.replaceId` (an extra link), `rebaseTo` (the conflict surfaces later), the wait, priority and paging options, preview `path`/`clientKey`, artifact `paper`/`sourceRange`.
- **Results are real**: envelopes and small results are full structs; model records are `modelRecord`s declaring their ids, revisions, states and kinds. The one open shape is `design_action` (it dispatches to every design tool; any JSON object or array). Backend tests validate results under `NODE_ENV=test`; `commands-registry-previews-contract.test.ts` (new) runs all 17 preview commands through the real registry, the artifact suites run all 16 transcript commands through `registrarFrom`, and the design fork broke a schema on purpose to confirm the suite fails.
- **Capability commands folded.** None of these domains was version-gated, so each client's version 1 sends the envelope and decodes results and version 0 is today's call by name, answered as sent (an older backend's shapes are never refused by a newer schema). The four capability commands stay registered and are read on every version because they report runtime state: preview surfaces and the access kill switch, annotation storage and rollout mode, the artifact renderer and rollout flags, the design service's readiness. What only gated support is folded: the web annotation contract-version check and design's capability flags (`intents` and the rest) are answered by version 1 itself; version 0 keeps reading them from the node. Design reads its capabilities through `invoke` rather than `capability()`, because `capability()` would keep a "service unavailable" answer for the whole connection.
- **Domain clients**: `previewsClient` (one method per command: `capabilities`, `services`, `register`, `update`, `remove`, `resolveTarget`, `probe`, `createAttachment`, `renewAttachment`, `releaseAttachment`, `createHandoffUrl`, `publicOrigin`, `revokeAccess`, `diagnostics`, `recordClientMetrics`, `settings`, `updateSettings`); `transcriptsClient` (shared with 7001: `client.ts` composes each item's part; this item's is `artifact-client.ts`: `artifactCapabilities`, `getPublication`, `listPublications`, `readRepresentation`, `openLiveSession`, `closeLiveSession`, `renderMermaid`, `workflowLiveSnapshot`, `listDrafts`, `readDraft`, `stageAsset`, `openMediaStream`, `closeMediaStream`, `mediaPdfPreview`, `prepareWorker`, `pinMedia`); `webAnnotationsClient` (`run(command, args)` typed by `WebAnnotationCommandArgs`/`Results`, plus `version`); `designClient` (`command(def, args)`, `capabilities()`). All four are in `DOMAIN_CLIENTS` and `adapters.json` with adapters 1 and 0.
- **Web**: `lib/backend/client.ts`'s command-scope and per-scope factory clients now carry their scope client's `domains` and `capabilities`, and `invoke`/`invokeInScope` forward an envelope option, so a domain client over a factory client picks the node's real adapter (before, a factory client had no negotiation and always got version 0). Bindings: `lib/node-scope/domains/previews.ts` and `transcripts.ts` (over 7003's `backendDomainApi`), which `lib/backend/previews.ts` and `lib/backend/transcript-artifacts.ts` call; web annotations bind in their one funnel (`lib/web-annotations/client.ts`, `webAnnotationCommand`), design in `lib/design-client.ts` (per node scope). Calls for another machine (`machine` argument) go through `machineBackendClient` and the command node, which carries no negotiation: version 0, as today. Three web mechanisms for the same binding now exist (7001's `nativeSessionsDomainClient`, 7002's `domainApi`, 7003's `backendDomainApi`, which this item used); the orchestrator should pick one.
- **Bug fixed**: `listTranscriptArtifactDrafts` read the backend's `{ drafts }` answer as an array, so the draft inspector always listed nothing in production (its test fake answered an array). It now unwraps `{ drafts }` and still accepts an array.
- **Types moved** (none of these domains has types in `models.ts` or `web/src/types/index.ts`; their models already live in protocol): the web's own copies of the preview result types (`PreviewMutationResult`, `PreviewTargetResolution`, `PreviewSettingsResponse`/`Shape`, `PreviewPublicationDetail`, `PreviewDiagnosticsSnapshot`) and the backend's and web's `WorkflowLiveSnapshotResponse` are now the protocol schemas' inferred types; `preview-runtime.ts`'s `publicationDetail` is typed by it.
- **Register rows.** Previews: the legacy loopback route and preview tunnel v1 are transports, unaffected; "registry snapshots without `entryServiceId`" is mechanical (only version-0 answers lack it). Transcripts: "`transcript_media_open_stream` requires an `environmentId`" is mechanical (only a version-0 node refuses). Web annotations: no rows. Design: both rows already retired. Not in the register: design's `intents` capability check for older v2 backends (`design-controller.ts`), now true on version 1 and still read on version 0; the orchestrator may want a row for it.
- **Test edits outside "unchanged"**: backend `commands-registry-transcript-media.test.ts` and `commands-registry-web-annotations.test.ts` asserted unknown-key rejection and now assert stripping (the allowed exception). `domain-adapter-usage.test.ts` (1009) found each legacy capability command's domain only in the domain map; it now also reads the registry's definitions. Web `EnvironmentPreviewServices.test.tsx` expected `revoke_preview_access` with `{}`; the shared web binding sends a call without arguments as one, so it now accepts either.
- **Scenario modules** (`scripts/mixed-version/scenarios/{previews,transcript-artifacts,design,web-annotations}.ts`, over 7002's `renderer-client.ts`): previews PV-1..5 (adapter, capabilities' response-level versioning, register and replay by operation id, update and remove at the revision, settings), transcripts TA-1..5 (adapter, capabilities, an empty conversation's drafts and publications, a missing workflow run, a media pin), design DS-1..3 (adapter, capability envelope, library through the envelope), web annotations WA-1..4 (adapter, capabilities at the contract version, an empty list, destinations). Ran live: `--old-version current` and `--old-version latest-stable` (v2.36.1, both topologies): every module passed (34 checks per topology; reports in `output/agent-testing/7004/`).
- **Shared files** (`contract-domain-map.ts`, `client-adapters.ts`, `version-compatibility.md`, `scenarios/index.ts`) were committed from temporary indexes started at HEAD with only this item's hunks; the generated contract files at HEAD already held this item's definitions (another item's regeneration picked up the working tree), and `contract:check`, `contract:adapters:check` and `contract:ci` pass.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker, with two forked workers for web annotations and design): protocol `contract/model-schema.ts`; `contract/domains/{previews,web-annotations,design}/{commands,client,index}.ts` and `transcripts/{domain,artifact-commands,artifact-client,client,index}.ts` with tests; the four clients in `DOMAIN_CLIENTS`; four `package.json` subpaths. Backend: 105 handlers on `register(def, handler)` (`commands-registry-previews.ts`, `commands-registry-web-annotations.ts`, `design/commands.ts` + `commands-registry-design.ts`, `transcript-artifacts/commands*.ts`, `commands-registry-transcript-media.ts`), the `beforeDecode` registration option, domain-map entries removed. Web: `lib/backend/client.ts` negotiation and envelope passthrough, `lib/node-scope/domains/{previews,transcripts}.ts`, `lib/backend/previews.ts`, `transcript-artifacts.ts`, `lib/web-annotations/client.ts`, `lib/design-client.ts`. Scenario modules and docs. Commits 6771c89a3, 88de1cfd2, 4abe0bb80, 47356db54, 63708fb04, a793dcf70, 63cde758e, 4baf965cc, 2bda4ecc0, 606f331d1, 2f8de4f2c, 2571c0302, 936da0cb4 and this one. Tests: protocol previews 26, transcripts artifacts and design and web-annotations suites (protocol `src/contract` 321 pass at the WA run); backend previews 23 files pass plus the new contract test (4), transcript artifacts 48 files pass, web annotations 383 pass, design 309 pass; web previews/transcripts 30 files pass, web annotations 1107 pass, design 360 pass with 2 failures in `design-prompt-images.test.tsx` from another agent's compose-draft change; `mixed-version-qualification.test.ts`; `contract:check`, `contract:ci`; mixed-version runs above. Typecheck of protocol, backend and web clean in this item's files (remaining errors are other agents' in-progress files); `bun fmt` and oxlint clean.
- 2026-11-07 (orchestrator, completeness check): noted that 7014 did the Zod follow-up (no backend `zod` import or dependency) and that the web domain-client helper converged into `domainApi` in 7010.
- 2026-11-07 (claude-worker, completeness audit): mixed-version modules run live (1012 Work log): previews 10/10, transcripts (artifacts) 10/10, design 6/6, web-annotations 8/8, in the control and in both v2.36.1 topologies, all passed.
