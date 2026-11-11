# Where Effect is used, and where it is not

The repository depends on `effect` 4.1.2 (Effect v4, whose API differs from
v3). Its own reference ships with the package: `node_modules/effect/AGENTS.md`,
`node_modules/effect/ai-docs/` and the `.d.ts` files under
`node_modules/effect/dist/`. Use those, not v3 examples.

Effect is used where it removes a bug class or makes correctness-critical code
simpler. It is not used where it would only restyle code. The decisions below
come from a whole-repository review on 2026-11-07. Read them before adding
Effect somewhere new or proposing to remove it.

## Where it is used

| Feature | Where | Why |
| --- | --- | --- |
| `Schema` | Contracts in `packages/protocol/src/contract/**`, backend command and MCP tool inputs (`tool-schema.ts`) | One schema system with static types and a JSON Schema export; see [version-compatibility.md](../architecture/version-compatibility.md#domain-contracts). Zod remains only as a third-party peer of the Claude Agent SDK. |
| `Data.TaggedError` | Contract errors (`contract/errors.ts`), registered error codes (`CodedError`, Kanban, native job receipts, provider session missing, `ContainerLifecycleError`, pane layout and prompt queue conflicts), `CaptureError` (`change-tracking/capture-error.ts`), `NodeRefusal`, `NodeGrantOpenError` | Typed, `_tag`-discriminated failures. A code that must cross Electron IPC or the gateway is registered in `contract/ipc-error.ts` ([Registered error codes](../architecture/version-compatibility.md#registered-error-codes)), never matched by its message text. |
| `Scope` lifetimes | `apps/web/src/lib/node-scope/lifetime.ts`, `apps/desktop/electron/node-scopes.ts`, `apps/web/src/lib/node-scope/node-clients.ts` | Reverse-order finalizers, parent closes children, and idempotent close for node scopes and grants. |
| `Effect.retry`, `Schedule`, `Effect.timeout` | Grant opening in `node-clients.ts` | A capped exponential retry that a release interrupts. |
| Startup `Scope` | `createBackendLifetime` in `apps/backend/src/startup-services.ts`, used by `main.ts` | Signal handlers are installed before `init()` (AGENTS.md invariant 16). Each stage's release is registered before it starts, a signal interrupts startup between stages, and exactly what was acquired is released. Stages are uninterruptible, so `shutdown()` never runs beside `init()`. |
| Shutdown steps | `shutdownStep` in `apps/backend/src/core/shutdown-steps.ts`, used by `OrkestratorBackend.shutdown()` | Every close step runs even if an earlier one fails, so `storage.close()` (WAL checkpoint, clean-exit marker) is always reached. Caps use `Effect.timeout`, which clears its timer. This is a sequential program rather than `Scope` finalizers, because the order is fixed and branches on pending lifecycle tasks. |
| Fiber with `acquireRelease` | `ContainerHostReachabilityService` (`container-host-reachability.ts`) | The probe network and containers are scoped resources. An uninterruptible acquire means a resource is never removed before its create settles. `dispose()` interrupts the fiber. Both earlier fixes here (#1419, #1903) were leaks of these resources. |
| `Result` | Result decoding in `decodeCommandResult` and domain clients | A typed decode outcome without exceptions. |
| Sleep, timeout and retry | `apps/backend/src/core/abortable-timing.ts` (`abortableSleep`, `runWithTimeout`, `retryWithBackoff`) | One abort convention (a sleep resolves `false` on abort), a timeout that aborts the work's signal, and a jittered, capped retry with a `retryable` predicate, all tested on `TestClock`. Use these rather than a new inline `Promise.race` or sleep in the backend. A provider read bounded this way takes its signal through `ProviderReadOptions`, and a backend command through its invoker's `options.signal` (`CommandInvocation.signal`, which the gateway also aborts when the client goes away; a routed command forwards it to the node only for reads); a mutation (a prompt send, an MCP reload) keeps a plain bounded wait, because an abort cannot undo work the bridge already started. |

## Where it is deliberately not used

- **The sandboxed preload, `packages/cli` (`dist/client.js`) and
  `packages/toolchain`.** These bundles carry no Effect.
  `contract/ipc-error.ts` and `contract/node-refusal.ts` are Effect-free so the
  preload can import them. Keep it that way: a module these bundles import must
  not gain an `effect` import.
- **The bridges.** No bridge depends on Effect, so keep `effect` imports out of
  protocol modules the bridges use. Their close contract ("answer 503 pending
  within budget, stay fenced, retry") is the opposite of `Scope.close`, which
  runs finalizers to completion. `Effect.timeout` waits for an uninterruptible
  loser. A runtime per SDK event on the never-await callbacks is pure cost.
  Codex's `SerialQueue` bounds bytes as well as count, which Effect's `Queue`
  does not. A bridge bounds a wait with the Effect-free `boundedWait`
  (`@orkestrator/protocol/node/bounded-wait`), not its own timer race.
- **Renderer stores, signals and transports.** Plans 2001, 2002, 2010 and 2011
  record why: React reads synchronous state, and `ReconnectBackoff`'s
  reset-after-uptime is not a `Schedule` concept.
- **Persisted backoffs** (agent mail, PR auto-merge, cleanup reconciler,
  prompt drainer, turn recovery). Their attempt counts survive restarts, and
  `Schedule` is in-memory only. Use the pure `reconnectDelayMs` formula.
- **`work-admission.ts`.** It has priority classes, per-target caps, a
  starvation limit and slot retention after abort, none of which Effect's
  `Semaphore` has.
- **`{ ok } | { ok: false }` wire results.** `Result` is a class instance,
  not a JSON shape.
- **`Config` and `Brand`.** `options.ts` already centralises parsing. Id-swap
  bugs are rare enough that branding about 3,300 id fields is not worth the
  churn.
- **`Effect.cached` for single-flight `init()`.** It keeps failures. Clear the
  memoised promise on rejection instead, as `build-pipeline-transcript-store.ts`
  does.

Follow-ups that may extend this (a Cursor parked-cancel pilot, and a
cancellation path for timed-out backend commands) are in
[to-do 7543](../todo/backend-structure/7543-effect-adoption-follow-ups.md).
