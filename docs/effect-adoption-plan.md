# Effect Adoption Plan for Orkestrator

## Purpose

Introduce Effect incrementally into Orkestrator’s backend to improve:

* Typed error handling.
* Background-task supervision.
* Retry and scheduling behaviour.
* Resource acquisition and cleanup.
* Deterministic testing of time-based behaviour.
* Backend startup and shutdown management.

This is **not** a whole-codebase migration. Effect must initially remain an internal backend implementation detail.

The project already has careful durability, idempotency, recovery and process-lifecycle behaviour. The migration must preserve those properties rather than replacing them with in-memory Effect constructs.

---

# 1. Executive decision

Adopt **stable Effect v3** only.

As of 31 July 2026, the latest stable `effect` package is `3.21.4`. It requires TypeScript 5.4 or newer with strict checking enabled. Orkestrator’s backend already uses TypeScript 5.8 with strict checking, so it is compatible.

Use:

```json
{
  "dependencies": {
    "effect": "3.21.4"
  }
}
```

Before implementation, verify that `3.21.4` is still the latest stable v3 release. Pin the exact version rather than using `^`.

Do not use:

* Effect v4 prereleases or snapshots.
* `@effect/platform`.
* Effect Schema.
* Effect HTTP servers.
* Effect RPC.
* Effect Workflows or Cluster.
* Third-party Effect wrappers.

Those may be considered separately after the core migration has proven useful.

Effect explicitly supports incremental adoption by wrapping existing Promise APIs and returning to Promise interfaces at system boundaries.

---

# 2. Non-negotiable architectural rules

These rules apply to every milestone.

## 2.1 Keep durable state durable

Effect fibers, scopes, queues and references exist only inside one backend process. They do not survive a crash or restart.

Do not replace any of the following with Effect-only state:

* Environment lifecycle fields.
* Deletion tombstones.
* Build-pipeline snapshots.
* Pipeline revisions.
* Prompt queues.
* Prompt claims and reservations.
* Native session mappings.
* Dispatch journals.
* Request IDs.
* Cross-process locks.
* Controller leases.
* Recovery markers.
* Provider session IDs.
* Persisted retries or user-visible errors.

`StorageService` remains authoritative for anything that must survive process termination.

The existing environment lifecycle recovery deliberately reconciles persisted `creating` and `deleting` states after a restart. That recovery must remain storage-backed.

## 2.2 Preserve rejected-versus-ambiguous dispatch semantics

A provider rejection and an ambiguous transport failure are not interchangeable.

In particular:

* `PromptRejectedError` means the provider rejected the prompt.
* `ProviderUnavailableError` means an operation is temporarily unavailable.
* `AmbiguousPromptDispatchError` means the transport failed without proving whether the provider accepted the prompt.

An ambiguous dispatch must never be blindly retried. It must retain its durable request ID and be reconciled against authoritative provider state.

Effect retry schedules must be applied only to explicitly safe operations and error classes.

## 2.3 Background work must outlive UI lifecycles

Never scope backend work to:

* An HTTP invocation.
* An SSE connection.
* A browser tab.
* A React component.
* A selected environment.
* A renderer process.
* A mobile page lifecycle.

Orkestrator requires background environments to continue working while the UI is inactive or unmounted, and requires clients to rehydrate from authoritative snapshots.

The intended scope hierarchy is:

```text
Backend process scope
├── Backend services scope
│   ├── PR monitoring scope
│   ├── Native-agent supervision scope
│   ├── Build-pipeline supervision scope
│   └── Activity lease scope
├── Environment scopes
│   ├── Local server and bridge resources
│   ├── Agent provider resources
│   └── Environment-owned operations
└── Gateway resource wrapper
```

Request handlers may submit work into these scopes, but must not own them.

## 2.4 Preserve “stop waiting” versus “cancel work”

These are different operations:

1. Interrupt an operation.
2. Stop waiting for an operation.
3. Allow an operation to continue in a longer-lived scope.
4. Let process termination eventually stop it.

The existing `EnvironmentLifecycleTaskTracker` deliberately stops waiting after its shutdown deadline without cancelling the underlying operation.

Do not migrate that class until a dedicated milestone explicitly preserves this behaviour.

## 2.5 Keep Promise façades

Effect types must not initially leak into:

* Backend command handlers.
* Gateway interfaces.
* Electron IPC.
* Preload APIs.
* React clients.
* Protocol packages.
* Bridge HTTP contracts.
* Public service interfaces consumed by existing code.

Existing interfaces such as this must remain Promise-based:

```ts
interface BuildPipelineProvider {
  send(...): Promise<void>
  status(...): Promise<ProviderStatus>
  dispose?(): Promise<void> | void
}
```

Internally, those methods may run Effect programs through the backend runtime.

## 2.6 Use one managed backend runtime

Do not call `Effect.runPromise` or create runtimes throughout the codebase.

Create one managed runtime owned by the backend process. Boundary adapters may call that runtime.

Preferred structure:

```text
apps/backend/src/effect/
├── runtime.ts
├── boundary.ts
└── testing.ts
```

Responsibilities:

* `runtime.ts`: create and own the process-level Effect runtime.
* `boundary.ts`: helpers for converting internal Effects to existing Promise APIs.
* `testing.ts`: test-only Layers, clocks or utilities shared by Effect-based tests.

## 2.7 Do not hide expected failures

Avoid:

* `Effect.orDie` for expected operational failures.
* Broad `catchAll` handlers that convert every error to `unknown`.
* Retrying every error.
* Logging an error and returning success when the caller needs to know it failed.
* Converting `AmbiguousPromptDispatchError` into `ProviderUnavailableError`.
* Swallowing finalizer failures without applying existing fatal versus best-effort policy.

## 2.8 Do not expose sensitive data

Effect logs, spans and error annotations must not contain:

* Prompts.
* Terminal output.
* File contents.
* Attachment contents.
* Structured-output payloads.
* Authentication tokens.
* Bridge passwords.
* SSH keys.
* Environment variables containing credentials.
* Absolute sensitive paths.

This is already a repository invariant.

---

# 3. Where Effect must not be introduced

The following areas are outside the approved implementation scope.

## 3.1 Frontend

Do not add Effect to:

```text
apps/web/
apps/web-public/
```

Do not rewrite:

* React components.
* React hooks.
* Zustand stores.
* Compose state.
* UI event handling.
* Client-side resource reconciliation.
* xterm integration.
* Monaco or TipTap integration.

Effect may be useful on frontends in some projects, but that is not the problem this migration is intended to solve.

## 3.2 Electron shell

Do not add Effect to:

```text
apps/desktop/
```

Keep Electron supervision, preload and IPC boundaries Promise-based.

## 3.3 Shared protocol package

Do not add Effect or Effect Schema to:

```text
packages/protocol/
```

Continue using the existing:

* TypeScript unions.
* Runtime type guards.
* JSON Schema structures.
* Zod usage where already present.
* Protocol exports.

Do not change wire formats as part of the Effect migration.

## 3.4 Gateway internals

Do not rewrite `apps/backend/src/gateway.ts` using Effect HTTP or Effect Streams.

The gateway contains sensitive, highly tuned behaviour around:

* SSE replay.
* Replay cursors.
* Backpressure.
* Authoritative versus droppable events.
* Compression.
* Buffer limits.
* Request-size limits.
* Metrics.
* Static assets.
* Loopback proxying.

The backend composition milestone may wrap `gateway.start()` and `gateway.stop()` as a scoped resource, but must not change gateway internals.

## 3.5 Storage schemas and validation

Do not migrate `StorageService` to Effect Schema.

Do not alter persisted JSON formats as part of this project.

Promise-based storage methods may be wrapped with `Effect.tryPromise` when called from Effect code, but the storage implementation remains unchanged.

## 3.6 Native bridges

Do not add Effect to:

```text
bridges/codex-bridge/
bridges/claude-bridge/
```

The Codex bridge has extremely sensitive rules around:

* Ambiguous dispatch.
* At-most-once execution.
* Generation changes.
* Process ownership.
* App-server stdout processing.
* Approval denial.
* Ordered event delivery.
* Circuit breaking.
* Process-group termination.
* Dispatch reconciliation.

These are not approved for migration in the initial programme.

## 3.7 `commands.ts` before decomposition

Do not directly convert `apps/backend/src/core/commands.ts` into an Effect module.

It currently owns numerous global maps, timers, process registries and operation registries for terminals and local servers.

First extract cohesive services with existing Promise interfaces. Effect may then be introduced inside those extracted services in a later, separately reviewed change.

## 3.8 Pure and simple code

Do not use Effect for:

* Pure parsing.
* String manipulation.
* Type guards.
* Constants.
* Small synchronous helpers.
* Simple DTO construction.
* One-step CRUD wrappers.
* React-facing formatting.
* Path validation.
* Existing protocol conversion functions.

Effect should be used where it removes lifecycle, failure or concurrency complexity—not merely because it is available.

---

# 4. Pull-request and milestone policy

Each milestone must be independently reviewable and revertible.

General requirements:

1. One milestone per pull request unless the milestone explicitly calls for multiple PRs.
2. No unrelated cleanup.
3. No formatting churn in untouched files.
4. No wire-format changes.
5. No persisted-schema changes.
6. No behaviour changes unless explicitly listed.
7. Preserve existing public interfaces where possible.
8. Add regression tests before deleting legacy coordination code.
9. Do not leave commented-out legacy implementations.
10. Do not maintain two implementations indefinitely.

Every PR description must include:

* What custom coordination code was removed.
* What Effect primitive replaced it.
* Which scopes own the new fibers or resources.
* Which errors are retryable.
* Which errors are never retried.
* What happens during interruption.
* What happens during backend shutdown.
* How crash recovery remains durable.
* The exact test commands run.
* Any remaining migration risk.

---

# 5. Milestone 0 — Policy, baseline and ADR

## Goal

Establish migration boundaries and capture current behaviour before adding the dependency.

## Files

Create:

```text
docs/adr/0002-effect-backend-adoption.md
docs/effect-adoption-plan.md
```

Update:

```text
AGENTS.md
```

## Required ADR decisions

Document:

* Effect v3 only.
* Exact-version pinning.
* Backend-only adoption.
* One managed runtime.
* Promise façades at existing boundaries.
* Storage remains authoritative.
* Ambiguous dispatches are never blindly retried.
* No Effect in frontend, protocol, gateway internals or bridges.
* Background fibers belong to backend or environment scopes.
* Layers are used only for meaningful long-lived services.
* No Effect Schema during the initial programme.
* No Effect-based logging of user content or credentials.
* Each later expansion requires evidence from the previous milestone.

## Baseline tests

Run before implementation:

```bash
bun install --frozen-lockfile
bun run --cwd apps/backend typecheck
bun run --cwd apps/backend test
bun run build:backend
bun test
```

The repository requires Bun rather than npm or yarn.

Record:

* Current test results.
* Current backend build result.
* Current backend startup result.
* Current backend shutdown result.
* Any pre-existing failures.
* Test duration for relevant targeted suites.

## Exit criteria

* ADR merged.
* `AGENTS.md` includes explicit Effect restrictions.
* Baseline is green or all pre-existing failures are documented.
* No runtime code changed.
* No Effect dependency added yet.

---

# 6. Milestone 1 — Effect runtime foundation

## Goal

Add Effect to `apps/backend` and establish the runtime boundary without changing application behaviour.

## Files

Update:

```text
apps/backend/package.json
bun.lock
```

Create:

```text
apps/backend/src/effect/runtime.ts
apps/backend/src/effect/boundary.ts
apps/backend/src/effect/runtime.test.ts
```

## Implementation requirements

### Dependency

Add only:

```json
"effect": "3.21.4"
```

Do not add any other Effect package.

### Runtime ownership

Create one managed backend runtime.

The runtime must:

* Be created once.
* Be disposed once.
* Expose a small Promise boundary.
* Not start application services yet.
* Not use global ad hoc `runPromise` calls.
* Be testable without starting the real backend.

The exact Effect API should be verified against the pinned v3 compiler definitions. The conceptual boundary should resemble:

```ts
export interface BackendEffectRuntime {
  runPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A>
  dispose(): Promise<void>
}
```

Do not export a broad collection of Effect internals from this module.

### Boundary helpers

Provide narrowly named helpers rather than making every module know runtime details.

For example:

```ts
runBackendEffect(...)
runBackendEffectExit(...)
disposeBackendEffectRuntime(...)
```

Use `runBackendEffectExit` only where callers must distinguish typed failures from defects.

## Tests

Add tests proving:

* A successful Effect returns its value.
* A typed failure rejects the Promise boundary with the expected error.
* A defect remains distinguishable from an expected typed failure.
* A scoped finalizer runs when the program ends.
* Runtime disposal is idempotent or safely guarded.
* No test leaves live fibers or timers behind.

## Do not do in this milestone

* Do not refactor providers.
* Do not refactor PR monitoring.
* Do not refactor backend startup.
* Do not create service Layers.
* Do not create logging or telemetry Layers.
* Do not modify `main.ts`.
* Do not change shutdown behaviour.

## Exit criteria

* Dependency is backend-only.
* Runtime tests pass.
* Root tests pass.
* No production behaviour changed.
* Effect imports exist only under `apps/backend/src/effect/`.

---

# 7. Milestone 2 — Provider error-handling pilot

## Goal

Prove that Effect improves typed failure handling without changing dispatch behaviour.

## Primary file

```text
apps/backend/src/core/build-pipeline-provider.ts
```

Preferred supporting file:

```text
apps/backend/src/core/provider-effects.ts
```

The current provider already distinguishes rejection, unavailability and ambiguous dispatch.

## Scope

Convert these internal operations to Effect:

* Bridge fetch construction.
* Timeout handling.
* Response-status classification.
* JSON decoding where malformed responses are currently possible.
* Attachment staging.
* Provider disposal where applicable.

Retain the existing `BuildPipelineProvider` Promise interface.

## Error policy

The internal error channel must preserve at least:

```ts
PromptRejectedError
ProviderUnavailableError
AmbiguousPromptDispatchError
```

Do not merge these into one generic error.

### Send operation

Rules:

* A transport failure after attempting prompt dispatch becomes `AmbiguousPromptDispatchError`.
* HTTP responses known to be temporary remain `ProviderUnavailableError`.
* A definite non-temporary prompt refusal remains `PromptRejectedError`.
* Do not add automatic retries around prompt send.
* Do not change durable request IDs.
* Do not change provider reconciliation behaviour.

### Read operations

For:

* `status`
* `messages`
* `structured`

Keep existing behaviour during the first PR.

A later commit within this milestone may add a bounded retry to an idempotent read only when:

1. Its current callers do not already implement the retry.
2. The retry cannot change provider state.
3. The schedule is bounded.
4. The operation has a test proving the exact number and timing of attempts.
5. Shutdown interrupts the wait cleanly.

### Session creation

Do not automatically retry session creation merely because a request timed out. A session may have been created before the response was lost.

Any retry must rely on the existing deterministic client-session key or an authoritative lookup proving safety.

## Tests

Add or preserve tests proving:

1. Fetch rejection during prompt send produces `AmbiguousPromptDispatchError`.
2. Prompt send is attempted exactly once.
3. A 404, 409 or transient HTTP dispatch response produces the same existing temporary-unavailability behaviour.
4. A definite refusal produces `PromptRejectedError`.
5. Attachment staging failure does not silently omit the attachment.
6. Malformed session creation responses remain errors.
7. `status` returns `missing` for the existing missing-session response.
8. Timeouts do not become prompt rejections.
9. Error formatting never includes tokens, prompts or attachment contents.
10. The Promise-facing provider contract remains unchanged.

## Expected result

This milestone is successful only when:

* The possible operational failures are clearer in internal types.
* There is no increase in dispatch attempts.
* Existing callers require little or no modification.
* The implementation is no more difficult to follow than the original.

## Rollback gate

Stop the migration after this milestone when:

* Most Effect errors are immediately converted back to `unknown`.
* The implementation introduces more classification logic than it removes.
* Provider call sites require widespread changes.
* Reviewers cannot easily determine whether a prompt may be retried.

---

# 8. Milestone 3 — PR monitor scheduling pilot

## Goal

Use Effect for a self-contained backend supervisor with timers, retries, interruption and deterministic virtual-time tests.

## Primary files

```text
apps/backend/src/core/pr-monitor.ts
apps/backend/src/core/pr-monitor.test.ts
```

The existing service already isolates its effects and injects clock and scheduling functions, making it a suitable controlled scheduling pilot. It maintains per-environment generations, check state, retry state, reconciliation progress and one-shot timers.

## Required behaviour to preserve

* Every eligible environment is monitored independently of active UI state.
* A known PR is checked on its normal schedule.
* `create-pending` and `merge-pending` modes use their existing effective intervals.
* A check request during an active check causes one later recheck rather than parallel execution.
* A stale result cannot mutate a newer target generation.
* Provisional probes disappear when no PR is found.
* PR changes are persisted before being treated as authoritative.
* Kanban side effects remain idempotent.
* Snapshots and emitted protocol events remain byte-compatible.
* Pause stops future checks.
* Untrack removes the entry.
* Shutdown prevents later side effects.

## Suggested internal design

Use one service-owned Effect scope.

For each monitored entry:

* Hold one scheduled fiber.
* Interrupt and replace that fiber when its target or generation changes.
* Never permit two `performCheck` fibers for the same generation.
* Preserve the existing recheck coalescing rule.
* Scope all fibers to the PR monitor service, not a command invocation.
* Use Effect `Clock` for deadlines and delays.
* Use `TestClock` in unit tests.
* Keep target and reconciliation data in ordinary maps initially unless moving it to `Ref` clearly improves atomicity.

Do not force every synchronous snapshot helper into Effect. `snapshot()` and pure description functions should remain ordinary synchronous TypeScript.

## Public API

Prefer to preserve:

```ts
sync(...)
requestMode(...)
requestCheck(...)
pause(...)
untrack(...)
trackedIds()
snapshot()
```

Shutdown may become awaitable internally, but retain a compatibility façade for existing callers.

Do not return Effect values to `commands.ts`.

## Tests using virtual time

Cover:

1. Normal polling interval.
2. Pending-mode interval.
3. Pending-mode expiry.
4. Error backoff.
5. Immediate requested check.
6. Recheck requested during an active check.
7. Pause before a scheduled check.
8. Untrack while detection is in flight.
9. Target generation changes while detection is in flight.
10. Shutdown with sleeping fibers.
11. Shutdown with an active detection.
12. No side effects after interruption.
13. Terminal reconciliation remains idempotent.
14. Provisional probe cleanup.
15. Snapshot and event compatibility.

Tests should advance virtual time rather than sleeping in real time.

## Exit criteria

* Legacy timer fields and timer injection are substantially reduced.
* No duplicate checks are possible.
* All scheduling tests are deterministic.
* Public protocol behaviour is unchanged.
* Backend shutdown leaves no PR-monitor fibers alive.
* Root test suite passes.

## Expansion gate

Do not proceed to native-agent migration until this milestone has been stable through:

* Unit tests.
* Backend integration tests.
* Manual start and shutdown.
* Multiple monitored environments.
* An inactive or disconnected renderer scenario.

---

# 9. Milestone 4 — Native-agent supervisor migration

## Goal

Replace the service’s custom Promise-task and retry coordination with scoped Effect supervision while preserving storage-backed at-most-once behaviour.

## Primary files

```text
apps/backend/src/core/native-agent-service.ts
apps/backend/src/core/native-agent-service.test.ts
```

The current service maintains provider, task, retry, attempt and scan registries plus a recurring timer.

Current coordination includes:

```text
providers
launchTasks
launchRetryAt
queueTasks
queueRetryAt
queueAttempts
scanTasks
launchTimer
stopped
```

## Split this milestone into two PRs

### Milestone 4A — Supervisor loop only

Convert:

* Periodic launch reconciliation.
* Periodic prompt-queue draining.
* Scan task tracking.
* Shutdown of scan loops.

Do not yet change:

* Provider cache ownership.
* Per-queue retry algorithm.
* Storage locking.
* Prompt dispatch logic.
* Session creation logic.

Desired result:

* Two service-owned supervisor fibers, or one supervisor fiber with two explicitly supervised child operations.
* No raw `setInterval`.
* No detached scan Promises.
* Shutdown interrupts sleeping scans and awaits active scans according to the existing policy.
* Initial reconciliation still occurs before periodic scans begin.

### Milestone 4B — Keyed work and provider resources

Convert:

* `launchTasks`.
* `queueTasks`.
* Provider cleanup.
* In-memory backoff scheduling.

Use scoped, keyed child fibers so:

* One launch task exists per environment.
* One queue-drain task exists per queue key.
* Repeated discoveries join or ignore existing work rather than dispatching twice.
* Provider disposal runs exactly once.
* Shutdown stops admission before awaiting children.

## Durable invariants that must remain unchanged

Do not replace or weaken:

* `getOrCreateNativeAgentSession`.
* Cross-process storage locks.
* `dispatchNativeAgentPromptOnce`.
* Prompt queue reservation and claim behaviour.
* Request-ID stability.
* Message fingerprints.
* Environment deletion checks.
* Environment readiness checks.
* Persisted dispatch errors.
* Provider-session invalidation.
* Startup-session recovery.

Effect coordinates one process; storage still decides cross-process ownership.

## Retry policy

The existing queue retry policy has:

* A base delay.
* An exponential increase.
* A ceiling.
* A maximum attempt count.
* A durable parked error after repeated failure.

Preserve those semantics exactly unless a separately approved change alters them.

Do not retry:

* `PromptRejectedError`.
* Ambiguous prompt dispatch without reconciliation.
* Invalid input.
* Environment deletion.
* Identity mismatches.

A retry schedule may apply to known transient provider-unavailability cases.

## Required tests

Retain all existing concurrency tests, especially those proving two supervisors dispatch once.

Add tests covering:

1. Two process-local callers still join one keyed task.
2. Two storage instances still dispatch one durable prompt.
3. Supervisor fibers stop on shutdown.
4. An active scan is awaited or interrupted according to documented policy.
5. Sleeping backoff does not keep the process alive after scope shutdown.
6. Backoff timings using `TestClock`.
7. Maximum attempts park the queue.
8. Successful dispatch clears retry state.
9. Provider resources are disposed once.
10. Replaced providers are disposed.
11. Deleted environments do not launch sessions.
12. Not-ready environments do not drain queues.
13. Startup prompts and images are still consumed exactly once.
14. Ambiguous dispatch remains in reconciliation rather than blind retry.
15. Shutdown rejects new work synchronously or through the existing public contract.
16. No prompt content appears in logs or traces.

## Exit criteria

* Manual Promise task registries are removed or significantly reduced.
* Retry delays use Effect scheduling rather than timestamp comparisons where practical.
* Storage-backed idempotency is unchanged.
* Existing Promise API remains intact.
* No work is tied to renderer lifetime.
* All current native-agent tests pass.
* The root test suite passes.

---

# 10. Milestone 5 — Build-pipeline supervision

## Goal

Migrate build-pipeline scheduling, locking, deadlines and provider lifecycle after native-agent supervision has proven stable.

## Primary files

```text
apps/backend/src/core/build-pipeline-service.ts
apps/backend/src/core/build-pipeline-service.test.ts
```

This service currently owns a polling timer, coalesced tick Promise, per-pipeline Promise locks, provider resources and several deadlines. Its persisted snapshots and revision checks are durable and must remain authoritative.

## Split this milestone

### Milestone 5A — Tick supervisor

Replace:

* Raw polling interval.
* `tickPromise`.
* `tickRequested`.

Preserve:

* Immediate initial tick.
* Tick coalescing.
* No parallel global tick passes.
* Shutdown waiting for the current pass.
* Existing auto-advance option.

### Milestone 5B — Per-pipeline serialization

Replace Promise-chain locks with one explicitly owned serialization mechanism per pipeline.

Acceptable approaches:

* A one-permit semaphore per pipeline.
* A keyed fiber supervisor.
* A per-pipeline queue.

Requirements:

* Only one pass for a pipeline may run at once.
* A requested pass during an active pass must not be lost.
* Different pipelines may progress concurrently within existing safe limits.
* Shutdown closes admission before draining active work.

### Milestone 5C — Provider scopes and deadlines

Move provider resources into scopes.

Use Effect Clock for:

* Reconnect deadline.
* Structured-result deadline.
* Transcript persistence interval.
* Poll timing.

Do not modify the durations or user-visible failure messages unless separately approved.

## Persisted invariants

Do not change:

* Pipeline snapshot shape.
* Pipeline version.
* Backend revision semantics.
* Admission key construction.
* Durable phase transitions.
* Environment association.
* Session request IDs.
* Recovery after restart.
* Completion-comment locking.
* Source linkage.
* Verification schema.
* Transcript persistence format.

## Tests

Cover:

1. Initial pass.
2. Tick coalescing.
3. No parallel pass for one pipeline.
4. Concurrent progress for independent pipelines.
5. Pass requested during active pass.
6. Shutdown during active pass.
7. Provider disposal.
8. Reconnect deadline with virtual time.
9. Structured-output deadline with virtual time.
10. Transcript throttling with virtual time.
11. Failed persistence.
12. Restart reconciliation.
13. Existing environment versus new environment admission.
14. Duplicate admission key.
15. Provider unavailable.
16. Ambiguous dispatch.
17. Terminal pipeline restoration.
18. Pipeline deletion during a pass.

## Exit criteria

* Timer and Promise-lock complexity is substantially reduced.
* Durable pipeline semantics are unchanged.
* Time-based tests use virtual time.
* Provider resources have one clear owner.
* No pipeline fiber is owned by a request or renderer.
* Full backend and root tests pass.

---

# 11. Milestone 6 — Backend composition and shutdown

## Goal

Make the backend process a scoped Effect program after individual services have proven their Effect implementations.

## Primary files

```text
apps/backend/src/main.ts
apps/backend/src/shutdown.ts
apps/backend/src/core/index.ts
apps/backend/src/effect/runtime.ts
```

Current startup and shutdown manually coordinate storage, recovery, agent tools, timers, reapers, services, gateway, managed web access and Tailscale Serve.

## Required startup order

Preserve this logical order:

1. Validate platform and options.
2. Prepare paths and data directory.
3. Initialise storage.
4. Reconcile interrupted environment lifecycle state.
5. Start agent tools.
6. Clear stale frontend activity.
7. Reap orphaned local servers.
8. Reap orphaned tmux runtimes.
9. Re-admit interrupted idempotent deletion work.
10. Restore build pipelines.
11. Restore native-agent launches.
12. Start gateway.
13. Start managed web client or Tailscale Serve when configured.
14. Emit the exact machine-readable readiness message.
15. Register signal and parent-reparent shutdown handling.

Do not allow gateway command admission before required recovery and orphan reaping complete.

## Resource wrappers

Effect may wrap these existing implementations:

```text
AgentToolsServer.start / stop
BuildPipelineService.init / shutdown
NativeAgentService.init / shutdown
OrkestratorGateway.start / stop
ManagedWebClient enable / shutdown
TailscaleServeManager.start / stop
Activity lease supervisor
```

Wrapping means calling the existing methods from `acquireRelease`-style resources.

Do not rewrite their internals solely for this milestone.

## Failure policy

Preserve current distinctions:

### Best-effort cleanup

Failures stopping optional public-access configuration should:

* Be logged safely.
* Not skip remaining cleanup.
* Not necessarily force a fatal exit.

### Fatal cleanup

Gateway or backend shutdown failures should:

* Be collected.
* Not skip later cleanup.
* Produce the existing non-zero exit behaviour.

### Exit codes

Preserve:

* Successful SIGTERM shutdown: existing success code.
* SIGINT shutdown: `130`.
* Fatal shutdown failure: `1`.

## Readiness output

The exact JSON readiness contract must not change.

Do not emit:

* Auth tokens.
* Gateway token contents.
* Credentials.
* Extra non-JSON stdout before readiness if it would break the Electron supervisor.

## Environment lifecycle tracker

Do not migrate `EnvironmentLifecycleTaskTracker` in this milestone.

Continue using it through a Promise adapter until a later dedicated milestone proves:

* Synchronous admission closure.
* Lazy operation creation.
* Idempotent shutdown.
* Bounded waiting.
* Underlying operations are not incorrectly interrupted.

## Tests

Cover:

1. Successful startup and release order.
2. Storage initialisation failure.
3. Lifecycle reconciliation failure.
4. Agent-tools startup failure.
5. Gateway startup failure after backend acquisition.
6. Tailscale Serve startup failure.
7. Partial acquisition unwinds previously acquired resources.
8. SIGINT exit code.
9. SIGTERM exit code.
10. Fatal shutdown exit code.
11. Repeated shutdown signals share one shutdown.
12. Parent-reparent watchdog triggers the same shutdown path.
13. Optional cleanup failure does not skip gateway/backend cleanup.
14. Fatal gateway failure does not skip backend cleanup.
15. Activity lease fiber stops.
16. Readiness payload is unchanged.
17. No child process or server remains after integration-test shutdown.

## Exit criteria

* One process-level runtime owns backend service scopes.
* Startup partial failures unwind safely.
* Shutdown ordering remains correct.
* Signal handling is idempotent.
* Readiness and exit contracts are unchanged.
* Gateway internals remain untouched.
* All backend, desktop-supervision and root tests pass.

---

# 12. Milestone 7 — Decompose `commands.ts`

## Goal

Create clear resource-ownership boundaries before considering Effect in command-owned process infrastructure.

This milestone is primarily an architectural decomposition, not an Effect conversion.

## Suggested extractions

Extract cohesive services such as:

```text
apps/backend/src/core/terminal-supervisor.ts
apps/backend/src/core/local-server-supervisor.ts
apps/backend/src/core/container-bridge-supervisor.ts
apps/backend/src/core/environment-operations.ts
apps/backend/src/core/merge-recovery-service.ts
```

Potential ownership:

### `TerminalSupervisor`

Own:

* PTY processes.
* Session configurations.
* Output buffers.
* Revisions and generations.
* Retention timers.
* Activity timers.
* Stable session keys.

### `LocalServerSupervisor`

Own:

* Local Claude, Codex and OpenCode child processes.
* Bridge tokens and passwords.
* Per-environment start/stop serialization.
* Admission closure.
* Graceful shutdown.
* Process-tree termination.

### `ContainerBridgeSupervisor`

Own:

* Container bridge operations.
* Bridge start/stop ordering.
* Container-specific credentials.
* Container bridge health.

### `MergeRecoveryService`

Own:

* Active merge operations.
* Merge-cleanup recovery tasks.
* Cleanup ordering.
* Recovery after interruption.

## Rules

* First extraction PRs must preserve Promise interfaces.
* Existing tests should move with the extracted ownership.
* Do not add Layers for every helper.
* Do not introduce Effect into `commands.ts` itself.
* Command handlers should become thin validation and delegation functions.
* The command registry and command names remain unchanged.
* No protocol or storage changes.

After a service is extracted and independently tested, a separate PR may introduce Effect internally when it has:

* Long-lived resources.
* Timers.
* Child fibers.
* Bounded concurrency.
* Complex cleanup.
* Typed recoverable errors.

## Exit criteria

* `commands.ts` no longer directly owns most process registries.
* Ownership is explicit.
* Shutdown delegates to extracted services.
* Command behaviour and names are unchanged.
* All process and I/O coverage tests pass.
* No Effect migration is mixed into the extraction PRs.

---

# 13. Deferred milestone — Native bridges

Effect adoption in either native bridge is **not approved by this plan**.

Do not modify:

```text
bridges/codex-bridge/
bridges/claude-bridge/
```

A new ADR and separate review are required before any such migration.

The review must explicitly cover:

* App-server stdout must never await downstream work.
* Ambiguous dispatch cannot be auto-retried.
* Generation death invalidates old events.
* Approval failure defaults to denial.
* Ordered events remain bounded.
* Process ownership and PID files remain safe.
* Circuit-breaker semantics remain unchanged.
* Bridge HTTP contracts remain unchanged.
* Existing replay fixtures and live-contract tests remain valid.

Backend success is not sufficient evidence by itself. The bridge migration must demonstrate a concrete reduction in complexity without weakening any execution-safety invariant.

---

# 14. Effect coding conventions

## Use Effect for

* Expected typed failures.
* Scoped resource ownership.
* Supervised background tasks.
* Bounded retries.
* Timeouts and deadlines.
* Deterministic clocks.
* Controlled concurrency.
* Resource-safe interruption.

## Do not use Effect for

* Pure transformation functions.
* Simple synchronous validation.
* DTO definitions.
* Protocol schemas.
* UI state.
* Small one-shot wrappers with no meaningful failure or lifecycle complexity.

## Error convention

Internal functions should communicate meaningful error unions.

Conceptual example:

```ts
type ProviderOperationError =
  | PromptRejectedError
  | ProviderUnavailableError
  | AmbiguousPromptDispatchError
```

Do not reduce this to:

```ts
Effect.Effect<A, Error>
```

unless the operation genuinely has no useful narrower taxonomy.

## Promise wrapping convention

Use `Effect.tryPromise` around existing Promise APIs where rejection is expected.

The rejection mapper must:

* Preserve existing domain errors.
* Convert unknown external failures at the boundary.
* Avoid including sensitive payloads in messages.
* Avoid classifying ambiguous failures as definite rejection.

## Retry convention

Every retry must answer:

1. Is the operation idempotent?
2. Do we know it did not execute?
3. Which exact error tags qualify?
4. What is the maximum number of attempts?
5. What is the maximum elapsed time?
6. Does the schedule use jitter?
7. What happens during shutdown?
8. Is retry state required to survive restart?

Do not add a retry without tests answering those questions.

## Fiber convention

Every fiber must have a documented owner.

Allowed owners:

* Backend process.
* Backend service.
* Environment.
* Pipeline.
* Provider/session.

Disallowed owners:

* HTTP request.
* SSE client.
* React component.
* Browser tab.
* Active-environment selection.

Avoid unscoped daemon fibers.

## Layer convention

Use Layers only for meaningful long-lived services or resources.

Do not create Layers for:

* Pure helpers.
* Small option objects.
* Individual command arguments.
* Every existing constructor dependency.
* Simple stateless functions.

Existing constructor injection may remain where it is clearer.

## Finalizer convention

A finalizer must be:

* Safe to run after partial acquisition.
* Idempotent where repeated shutdown is possible.
* Bounded where external processes may hang.
* Free from user-content logging.
* Tested on both success and acquisition failure.

---

# 15. Test and verification checklist

Run for every milestone:

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/backend test
bun run build:backend
bun test
```

Run targeted tests while developing, but the final PR must include the full relevant suites.

For milestones involving timers:

* Prefer `TestClock`.
* Do not add arbitrary real sleeps.
* Prove interruption clears scheduled work.
* Prove no timers keep the process alive.

For milestones involving resources:

* Count acquisitions and releases.
* Test partial acquisition.
* Test release after failure.
* Test repeated shutdown.
* Test release ordering.
* Check for leaked child processes or listeners.

For milestones involving dispatch:

* Assert invocation count.
* Assert request-ID stability.
* Assert no blind retry after ambiguity.
* Assert durable claims remain authoritative.
* Assert two supervisors still produce one dispatch.

For milestones involving background work:

* Start the work.
* Disconnect or deactivate the renderer.
* Allow the work to progress.
* Reconnect.
* Verify state rehydrates correctly.

---

# 16. Programme completion criteria

The Effect adoption programme is successful when:

1. Effect remains confined to approved backend modules.
2. Existing external APIs remain Promise-based.
3. Durable recovery semantics remain storage-backed.
4. Ambiguous dispatches are never blindly retried.
5. Time-based tests are deterministic.
6. Service shutdown leaves no orphaned fibers, timers, listeners or providers.
7. Startup partial failures unwind acquired resources.
8. Background work continues independently of UI lifecycle.
9. `commands.ts` is decomposed before process infrastructure is migrated.
10. Gateway and bridge invariants remain untouched.
11. The amount of manual Promise, timer and cleanup coordination decreases.
12. New code is easier to review than the code it replaces.
13. Root tests remain green after every milestone.

---

# 17. Stop conditions

Pause further Effect adoption when any milestone produces one or more of these outcomes:

* Effect types spread into the frontend or protocol package.
* Typed errors are routinely erased to `unknown`.
* Reviewers cannot determine which operations are retryable.
* Durable state is replaced by process-local state.
* Fibers are scoped to requests or UI connections.
* Cancellation changes existing “stop waiting” behaviour.
* The same logic exists in legacy and Effect implementations for an extended period.
* Test setup becomes substantially harder.
* The implementation is longer without removing lifecycle complexity.
* Performance or startup regressions cannot be explained.
* Bridge or gateway changes become necessary merely to support the migration.

When a stop condition occurs, keep the completed useful milestones and do not force the remainder of the codebase into Effect.

---

# 18. Recommended PR sequence

Use this order:

```text
PR 1  — ADR, AGENTS.md rules and baseline
PR 2  — Add Effect v3 and managed runtime foundation
PR 3  — Provider typed-error pilot
PR 4  — PR monitor Effect scheduling
PR 5  — Native-agent supervisor loop
PR 6  — Native-agent keyed tasks and provider scopes
PR 7  — Build-pipeline tick supervisor
PR 8  — Build-pipeline keyed serialization and deadlines
PR 9  — Backend scoped composition and shutdown
PR 10 — Extract TerminalSupervisor
PR 11 — Extract LocalServerSupervisor
PR 12 — Extract remaining process services
```

Do not start PR 5 until PR 4 has passed its expansion gate.

Do not start backend composition until provider, PR-monitor, native-agent and build-pipeline scopes have clear ownership and shutdown behaviour.

Do not begin any bridge migration under these milestones.
