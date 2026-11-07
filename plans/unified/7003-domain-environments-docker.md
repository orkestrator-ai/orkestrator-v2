---
id: 7003
title: "Convert environments, container lifecycle and Docker"
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

# 7003 · Convert environments, container lifecycle and Docker

- **Report:** [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix E](../../docs/reports/unified-federation.md#appendix-e-command-surface-by-domain), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [1011](1011-contract-policy-and-docs.md)
- **Recommended before the web side:** [3002](3002-lib-backend-client-parameter.md) and [2011](2011-scope-domain-negotiation.md). Until they land, the domain's `lib/backend` file calls the domain client bound to the command scope.
- **Parallel with:** the other Phase 7 domain items, and all of Phases 2-6
- **Size:** L
- **Track:** C (contract)

## Domains

`environments`, `docker`.

## Current state (verified 2026-11-07)

- Environments and container lifecycle: 63 registered, 55 web-referenced. Docker: 29 and 27.
- 20 `assertOnlyKeys` sites in the environment handlers are strict today, so they become tolerant-with-critical.
- Container lifecycle operations are durable (`container-lifecycle-service.ts`). Idempotency keys and safety options there are prime `critical` candidates.

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
- [x] Fold the domain's capability command (if any) into the domain version. Keep the command registered for pre-contract clients until its register row retires.
- [x] Web side:
  - a domain client in `apps/web/src/lib/node-scope/domains/<domain>.ts`, with a version-1 adapter and a version-0 legacy adapter that keeps today's capability gating;
  - the domain's `lib/backend` functions call it;
  - typed results replace `invoke<T>` casts.
- [x] Move the domain's shared types from `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` to inferred protocol types where they match (see [7010](7010-converge-models.md)).
- [x] Classify the register rows for these domains: retired, mechanical (adapter), or unaffected. Update `version-compatibility.md`.
- [x] Add a scenario module to [1012](1012-mixed-version-qualification.md)'s script for the domain's main flows.
- [x] Regenerate the manifest and the adapters list; the untyped baseline falls.


## Tests

- [x] Each converted handler passes its existing tests unchanged, apart from tests that asserted rejection of unknown keys, which now assert stripping (or the critical-field refusal).
- [x] A domain-client test for each adapter version against fakes.
- [x] Contract CI stage 2 ([1008](1008-contract-ci-job.md)) accepts every in-window snapshot's arguments.

## Done when

- [x] Every command in these domains is defined, the untyped count for them is zero, and the web uses domain clients for them.

## Notes

### Where Effect is used (2026-11-07)

- **Effect Schema** for every definition and model: `contract/domains/environments/{models,results,commands}.ts` and `docker/{models,commands}.ts` (`Schema.Finite`, `optionalKey` for arguments, `Schema.optional` for result fields, `Schema.mutable` arrays so inferred types stay assignable to the mutable model types, `Schema.Void` for commands that answer nothing).
- **Deliberately not Effect:** the domain clients and the web helper (`lib/backend/domain-client.ts`) are promise-based over 1009's `createDomainClient`, for 1009's reason (synchronous selection, promise-based callers). The async-argument wrapper (`commands-registry-async-args.ts`) is a plain registrar wrapper over 7002's `ASYNC_HANDLER`.

### Decisions (2026-11-07)

- **The environment model is one schema set** (`environments/models.ts`): `ClientEnvironmentSchema` field for field with `ClientEnvironment` in `apps/backend/src/core/models.ts` (the handlers' return types are checked against it at registration), `EnvironmentDetailSchema` for `get_environment` (the stored record: plus `initialPromptAttachments` and `initialConversationMode`; the durable lifecycle record is backend-private and only `object`), `EnvironmentSnapshotRowSchema` for `get_environment_snapshots` (plus the node-summary extras `dockerAvailable`, relayed PR health, build markers and the mail badge), `EnvironmentSetupStartResultSchema`, and the nested `ContainerLifecycleSnapshot`, `ContainerResourceLimits`, `PortMapping`, worktree move, diff baseline/override and startup session. 7010 can infer both model files' types from these.
- **One typed-opaque field:** `agentSettings` is `ownedObject<AgentSettingsTier>()` (decoded as an object, typed as the tier): the tier belongs to the `config` domain and its full schema (action defaults, Multi Review, execution policy) is that domain's. Every other structured result is fully described.
- **Result fields are `Schema.optional`, not `optionalKey`:** handlers return records with fields set to `undefined` (`buildPipelineId: undefined` from `createEnvironment`), which result validation in development and tests refuses under `optionalKey`. Same reason event payloads use `optional`. The JSON export differs only in the digest.
- **Ports accept `null`:** storage normalises a cleared port to absent, but fixtures and pre-normalisation records carry `null` (`entryPort: environment.entryPort ?? null` is written by the start path). The web `Environment` and `EnvironmentTooltipDetails` port fields became `number | null`.
- **Literal vocabularies are literals** (status, platform, unread reason, deletion step, operation kind, boot phase, failure code): faithful to the model types. A new literal is a change an older client cannot decode, so it bumps the domain (stated in `models.ts`).
- **Arguments:** every key a handler reads is declared (including keys parsed from the whole `args` object: `parseContainerMutationIdentity`, `parseRecreateEnvironmentRequest`, the conditional snapshot's `knownManifestGeneration`/`knownResourceRevision`). A value read with `asString(x, "x")` is `Schema.String` (its missing/invalid text is identical, "Expected x to be a string"); `pending` on `set_environment_pending_agent_launch` is `Schema.Boolean` (`asRequiredBoolean`'s text is the same). Everything checked or coerced by the handler itself (`asOptionalString`, `asNonBlankString`, `asStringArray`, the lifecycle parsers with their `ContainerLifecycleError` text, `=== true` flags) is `optionalKey(Unknown)`, so lenient handlers stay lenient and every error text is unchanged.
- **Strict handlers:** the 21 `assertOnlyKeys` sites (20 in the environments registrar, `teardown_tab` in the teardown one; the item counted 20) are gone; those commands now strip unknown keys.
- **Async handlers keep rejecting.** The registry decodes before the handler and throws synchronously; an `async` handler used to reject. `withAsyncArgumentFailures(register)` (`commands-registry-async-args.ts`) registers every definition whose handler is an `async` function with 7002's `ASYNC_HANDLER`, so `commands.get(name)?.(args).catch(...)` callers and the lifecycle commands (async by design so a direct caller sees a rejection) behave as before. A first version wrapped the call in an `async` function; that added a microtask and changed the ordering a pending-rename test relies on, so the wrapper only converts a synchronous throw.
- **Critical fields** (one-line reasons, also next to each definition):
  - `create_environment.controlRequestId`: the launch's idempotency key; ignored, a retry creates a second environment.
  - `create_environment.controlRequestFingerprint`: refuses a reused key with a different intent; ignored, the wrong environment is answered.
  - `create_environment.delegationBaseBranch`/`delegationBaseCommit`: the immutable source a coordinator delegated; ignored, the branch comes from the default.
  - `operationId` on `start_environment`, `start_environment_background`, `stop_environment`, `discard_recovery_copy`, `restore_recovery_copy`, `recreate_environment`, and docker `provision_environment`: the durable lifecycle operation's idempotency key (container-lifecycle.md); ignored, a retry runs the operation twice.
  - `expectedRevision` on the same commands: binds the mutation to the lifecycle revision (or recovery list) the user reviewed.
  - `expectedContainerId` on `recreate_environment`/`restore_recovery_copy`: a discard or restore replaces only the runtime that was reviewed.
  - `recreate_environment.keepRecoveryCopy`: ignored, the runtime the user asked to keep is deleted.
  - `docker_cleanup_execute.selectionToken`: binds the removal to the reviewed set (the id lists are not critical: ignoring one removes less).
  - Not critical: `intent` (absent means preserve, which refuses rather than destroys), `allowUnknownCapacity`, `applyNow`/`allowBelowUsage`, `remember`, `measureSize`, the teardown session ids.
- **`access`:** `admin` for `cleanup_logs`, `set_container_resource_limits`, `docker_cleanup_execute`, `docker_cleanup_preview` (workspace-excluded, Settings only); `internal` for `approve_project_setup_commands` (node link only); `workspace` for the rest, seeded from `isWorkspaceExcludedCommand` and 0006's observed list (every environments/docker command a realm sent there is `workspace`). **`read`** equals `isNodeReadCommand(name)`, pinned by both domain tests.
- **No capability command** exists for either domain, so none is folded: version 1 is today's command set.
- **Clients:** `environmentsClient` and `dockerClient`, one method per command, adapters 1 and 0. Version 1 sends the envelope and decodes results. **Version 0 answers as sent** (`answeredAsSent`), as 7001/7002's legacy adapters do: a pre-contract node's records are the shapes callers already handle, and decoding them would refuse an older node's variation those callers accept (a first version decoded on version 0 too; it failed some 48 web suites whose fakes answer partial records, which also showed the risk for real older nodes). The docker fork's client follows.
- *(2026-11-07, orchestrator, completeness check: stale file pointer. [7010](7010-converge-models.md) converged the three web domain-client helpers into `domainApi`/`domainClientFor` in `lib/node-scope/domains/domain-api.ts` (`4476f0b3d`); `lib/backend/domain-client.ts` no longer exists.)* **Web:** `lib/backend/domain-client.ts` (`backendDomainApi(client, def)`, `machineBackendClient`, `routedBackendClient`, `withArgumentsObject`) builds a domain client over a factory client; it reads the client's `domains`/`capabilities` (7004 made the command-scope and per-scope clients carry them), counts version-0 usage only for a client that carries `domains`, and sends `invokeRaw(command)` for an empty argument object so mocked-`invoke` suites see today's calls. The item text names `lib/node-scope/domains/<domain>.ts`; this item's helper lives in `lib/backend/` because 7004, 7009 and the docker functions already import it from there (7001/7002 have their own copies in `lib/node-scope/domains/`; converging the three is left to review). Converted: every environments and docker call in `projects-environments.ts`, `config-integrations.ts`, `files-sessions.ts`, `terminals.ts`, `docker-skills.ts`, `federation/federated-actions.ts` (routed, including `check_docker`) and `federation/node-environment-reads.ts`. Not converted: `apps/desktop/scripts/dev/*` live-observer scripts (dev tools calling by name) and test fixtures.
- **Types moved (7010's table):** `EnvironmentStatus`, `PrState`, `NetworkAccessMode`, `EnvironmentType`, `EnvironmentLifecycleOperation`, `EnvironmentSetupPhase` (backend), `PortProtocol`, `EnvironmentUnreadReason` are now the protocol schemas' types in both `models.ts` and `types/index.ts`. `Environment`/`ClientEnvironment` themselves stay declared in both files (pending, 7010): the web type is a narrower view (no `localPiPort`, a smaller `worktreeMove`), and the protocol type is assignable to it, which the converted `lib/backend` functions now check at compile time.
- **Register rows:** none retires and none becomes mechanical. Unaffected: `get_environment_snapshot`'s fallback (`useEnvironments.ts` reads the typed `unknown-command` through the client as before), `builtInDefault` on `get_docker_capacity`, `legacyRuntimes` on `docker_cleanup_preview`, `egressFilter` on the network policy (all optional fields). Recorded in `version-compatibility.md` ("Environments and Docker").
- **Scenario modules** (1012): `scripts/mixed-version/scenarios/environments.ts` (reads, then a port-mapping and PR-record round trip that is reverted, asserting the receiver's own record) and `docker.ts` (reads only; nothing creates, starts or removes a container). Not run live here (no live qualification in this pass).
- **Test edits** outside "unchanged": `commands-registry-environments-logs.test.ts` "rejects arguments neither command accepts" now asserts the key is dropped and only the log directory is measured and cleaned; `commands-state-sync.test.ts`'s `set_environment_pr` `extra` case now asserts stripping. Fixtures with impossible data under result validation: `commands-integration.test.ts`'s storage mock answered `[{ id }]` for `reorder_environments` (whole records now, `toMatchObject`); the docker fork edited four web/backend fixtures with impossible docker answers (its report). `factories.test.ts` skips `domain-client.ts` (it has no commands). `docker-domain.test.ts` follows the answered-as-sent version 0.
- **Done when:** the untyped count for both domains is zero in the manifest; the web uses domain clients for every production call (dev scripts aside, above). Aggregate suite left to review preparation. Stage 2 of contract CI was run (`mise run contract:ci`).

## Work log

- 2026-11-07 (claude-worker): protocol `contract/domains/environments/{models,results,commands,client,index}.ts` and `environments-domain.test.ts`; docker half by a forked worker (commit 9a428b310: `docker/{models,commands,client,index}.ts`, `commands-registry-docker.ts`, `docker-skills.ts`), then its version 0 switched to answered-as-sent. Backend: the environments and teardown registrars on `register(def, handler)` through `withAsyncArgumentFailures`, the environments block out of `contract-domain-map.ts`. Web: `lib/backend/domain-client.ts` and the conversions listed in Notes; `test/environments-results.ts` (valid answers per command, decode-checked). Docs: `version-compatibility.md` bullet. Scenario modules `environments.ts`, `docker.ts`. Tests: protocol environments+docker domain tests 21 pass; backend focused set (97 files: registrars, lifecycle, recovery, setup approval, nodes, public API, coordinator, build pipeline) 2,567 tests pass on the last clean run (later runs fail only in files other agents were mid-edit on: `changesGetViewCommand`, `get_node_status`, `get_database_stats`, coordinator surfaces); web focused set (55 files) pass except `store-resource-sync.test.ts`, which fails the same on the baseline; `mixed-version-qualification.test.ts` pass. Typecheck clean in owned files (protocol, backend both tsconfigs, web); errors remaining are in other agents' files.
- 2026-11-07 (orchestrator, completeness check): marked the `lib/backend/domain-client.ts` pointers stale: 7010 converged the helper into `domainApi` (`4476f0b3d`).
