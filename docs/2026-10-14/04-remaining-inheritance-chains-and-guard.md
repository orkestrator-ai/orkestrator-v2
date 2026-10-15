# 04 — Gateway, Codex runtime, build pipeline and web annotation chains, plus a regression guard

Status: Done (2026-10-15). The guard landed first, then all four chains were
replaced by a context plus collaborators behind an unchanged facade. Only plan
01's and plan 02's chains remain pinned in
`tests/unit/inheritance-chains.test.ts`.

## Problem

The same mechanical split (`7aee8366`, #417) produced four more chains. Each
one is a single class whose state sits in the base, held together by
`abstract` forward declarations:

| Chain | Layers (base → concrete) | Lines | Abstract decls in base | Fields |
| --- | --- | --- | --- | --- |
| Gateway (`apps/backend/src/`) | `gateway-base` (533) → `-events` (427) → `-auth` (740) → `-handlers` (396) → `-proxy` (859) → `gateway.ts` (`OrkestratorGateway extends GatewayProxy {}`) | 2,961 | 12 | ~42, all in base |
| Codex runtime (`bridges/codex-bridge/src/`) | `app-server-runtime-base` (1049) → `-lifecycle` (2094) → `-sessions` (1544) → `-prompt` (1476) → `-tail` (416) → `app-server-runtime.ts` (empty subclass) | 6,589 | 14 | ~36 in base, 4 elsewhere |
| Build pipeline (`apps/backend/src/core/`) | `build-pipeline-service-base` (1662) → `-supervisor` (1694) → `-recovery` (1015) → `-interactions` (478) → `build-pipeline-service.ts` (empty subclass) | 4,849 | 23 `abstract` uses | mostly base |
| Web annotation (`apps/backend/src/core/`) | `web-annotation-service-base` (759) → `-core` (1299) → `-results` (701) → `-requests` (1448) → `web-annotation-migration` (653) → `web-annotation-service.ts` (empty subclass) | 4,860 | 1 | mostly base |

`gateway-support-core.ts` / `-extra.ts` and `build-pipeline-service-helpers.ts`
are standalone helpers, not part of the chains.

These are smaller and lower-risk than 01–03. Refactor each one the next time
real work touches that area, not as a standalone project.

## Step 0: guard against new layers (land first)

Add `tests/unit/inheritance-chains.test.ts`, modelled on
`tests/unit/module-import-cycles.test.ts`:

- Scan `apps/`, `bridges/` and `packages/` (excluding `node_modules`,
  generated code and tests) for `abstract class X extends Y` and
  `class X extends Y` where `Y` is a project class, not `Error`, `Map` or
  another built-in.
- Pin today's chains in an allowlist, each with a recorded reason and a link
  to this plan or 01–03.
- Fail on a new chain, on a chain that gets longer, and on a stale allowlist
  entry, so the list shrinks as plans 01–04 land.
- Allow intentional single-level inheritance (for example
  `CursorRunDiagnostics extends BridgeRunDiagnostics`, or error subclasses)
  through an explicit allowlist.

Also add a short note to `docs/development/` or the root `AGENTS.md`: split
large classes by responsibility into collaborators, not into `extends`
layers.

## Shared pattern for all four chains

Their state is already concentrated in the base, so the change is mostly
mechanical:

1. Turn the base's fields into a context object (`GatewayContext`,
   `CodexRuntimeContext`, `BuildPipelineContext`, `WebAnnotationContext`)
   built once by the concrete class.
2. Turn each layer into a module of functions, or a small class, that takes
   the context. Replace each abstract upward call with a direct import of the
   function that implements it. A real cycle becomes an explicit callback on
   the context.
3. Keep the public class name and surface (`OrkestratorGateway`,
   `AppServerRuntime`, `BuildPipelineService`, `WebAnnotationService`) as a
   thin facade, so callers and tests don't change.
4. Remove each layer from the guard allowlist as it goes.

## Per-chain notes

### Gateway

Done (2026-10-15). `OrkestratorGateway` is a facade over `GatewayContext`
(`gateway-context.ts`) and `GatewayLifecycle` (`gateway-lifecycle.ts`, the
listeners, token and shutdown that used to sit in `gateway-base.ts`),
`GatewayEvents`, `GatewayAuth`, `GatewayHandlers` and `GatewayProxy`. Three
calls run against the build order and are callbacks bound late by the facade:
the terminal WebSocket's credential and origin checks (context → auth),
request routing (lifecycle → auth), and the route handlers (auth → handlers).
Await order, listener registration and the replay code are unchanged. The
facade keeps the internals the gateway suites reach through casts as
protected pass-throughs to the same instances.

Read `bridges/AGENTS.md` and the transport invariants in the root
`AGENTS.md` first.

- Natural modules: event fan-out and replay (`-events`), auth and token
  handling (`-auth`), route handlers (`-handlers`), and the reverse proxy
  (`-proxy`).
- Keep the replay rules intact: subscribe before computing the replay range,
  the connected frame echoes the client cursor, and every buffer stays
  bounded.

### Codex runtime

Done (2026-10-15). `AppServerRuntime` is a facade over `CodexRuntimeContext`
(`app-server-runtime-context.ts`), `CodexRuntimeApprovals`
(`app-server-runtime-approvals.ts`), and `CodexRuntimeLifecycle`, `-Sessions`,
`-Prompt` and `-Tail` in the existing files. `app-server-runtime-base.ts` now
holds only shared types, constants and helpers. Nine upward calls are
callbacks on the context, wired by the facade. Eleven methods that tests patch
on the runtime and that are also called internally go through the facade's
own method, so patching still intercepts internal calls. The stdout reader
(`jsonl-rpc-client.ts`) is untouched, and every callback on its path is a
synchronous call, so invariant 9 holds.

Read `bridges/codex-bridge/AGENTS.md` first.

- Natural modules: process lifecycle and supervision (`-lifecycle`),
  thread/session registry (`-sessions`), turn dispatch (`-prompt`), and
  transcript tail (`-tail`).
- Invariant 9 is the hard constraint: the app-server stdout loop never awaits
  rendering, SSE writes or other consumers. Keep the reader loop in one
  module that only enqueues.

### Build pipeline

Done (2026-10-15). `BuildPipelineService` is a facade over
`BuildPipelineContext` (`build-pipeline-context.ts`, which also holds `save`,
`requireRecord` and `mutate`), `BuildPipelineAgents`
(`build-pipeline-service-agents.ts`: providers, bridge connections, step
settings), `BuildPipelineRecovery`, `BuildPipelineInteractions`,
`BuildPipelineSupervisor` and `BuildPipelineLifecycle`
(`build-pipeline-service-lifecycle.ts`, formerly `-base`). Every abstract
declaration had one implementation, so after moving a few methods down the
calls run one way. The one real cycle, recovery opening the next stage, goes
through a `BuildPipelineStageDispatch` port the facade binds late to the
supervisor. Storage calls are unchanged; plan 01's repository work still
applies at those call sites. In practice the service called
`storage.getBuildPipeline`/`saveBuildPipeline` directly, not
`enqueueBuildPipelineMutation` as assumed below.

- Natural modules: stage supervisor, crash and restart recovery, and
  user-interaction handling. The base's 23 `abstract` uses show most of the
  upward coupling.
- Persistence goes through `storage.enqueueBuildPipelineMutation`. Coordinate
  with plan 01 so this service moves onto the build-pipeline repository at
  the same time.
- The test suite is large (`build-pipeline-service-*.test.ts`, about 11k
  lines, including `build-pipeline-service-recovery.facade.test.ts`) and
  makes a good regression oracle.

### Web annotation

Done (2026-10-15). `WebAnnotationService` is a facade over a
`WebAnnotationContext` (`web-annotation-context.ts`) and five collaborators:
`WebAnnotationStoreOperations` (`-service-store.ts`), `WebAnnotationThreads`
(`-service-threads.ts`, formerly `-core`), `WebAnnotationResults`,
`WebAnnotationRequests` and `WebAnnotationMigration`. Each takes the context
and the collaborators it calls. All calls between layers already ran one way
(base ← core ← results ← requests, and migration → core), so no callbacks were
needed.

- Only one abstract declaration, so this is the cheapest chain.
- `web-annotation-migration.ts` is not a one-time startup migration, as this
  plan assumed. It runs on demand per environment (`web_annotation_migrate`,
  paged, polled through `migrationStatus`), and `mapMigratedComposeDraft` runs
  on every compose-draft save. It became a collaborator instead of a startup
  function, so behaviour did not change.

## Order

1. Step 0, the guard.
2. Web annotation: cheapest, and proves the pattern.
3. Build pipeline, alongside plan 01's repository work.
4. Gateway.
5. Codex runtime.

## Done when

- The guard allowlist has no entries for these four chains.
- Each public class is a plain class or facade with no project-class
  `extends`.
