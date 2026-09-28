# 04 — Runtime readiness and graceful shutdown

Status: Implemented on branch; awaiting review. Dependencies:
[02](02-lifecycle-authority-and-durable-operations.md),
[03](03-image-contracts-and-daemon-preflight.md).
Return to [index](00-index.md).

## Goal

Make every container start establish fresh readiness, and make explicit stop or
replacement drain owned work before Docker terminates the process namespace.
Stopping visibility must remain unrelated to stopping execution.

## Integration points

- [Entrypoint](../../../../docker/entrypoint.sh),
  [workspace setup](../../../../docker/workspace-setup.sh),
  [root setup wrapper](../../../../docker/run-root-setup.sh),
  [firewall initialization](../../../../docker/init-firewall.sh).
- [Environment lifecycle](../../../../apps/backend/src/core/commands-environment.ts),
  [server lifecycle](../../../../apps/backend/src/core/commands-servers.ts),
  [server health](../../../../apps/backend/src/core/commands-server-health.ts),
  [container servers](../../../../apps/backend/src/core/commands-containers.ts).
- [Native-agent service](../../../../apps/backend/src/core/native-agent-service.ts),
  [shutdown admission tracker](../../../../apps/backend/src/core/environment-lifecycle-tasks.ts).

## Readiness model

Add a proposed bounded boot-status record with `runtimeGeneration`, a fresh
`bootId`, phase, capability version and a fixed failure code. Generate `bootId`
on each entrypoint invocation. The backend must bind its observation to the
current Docker `StartedAt`/container identity and reject records from the prior
boot; reading a nonce from an old file is not enough.

| State | What it permits |
| --- | --- |
| Docker started | Backend diagnostics only; no user workload dispatch |
| Firewall and portable inputs ready | Workspace validation/preparation |
| Workspace prepared | Project setup if required for this workspace/runtime |
| Setup ready | Terminal/agent launch subject to the existing execution policy |
| Agent-server healthy | Requests to that specific authenticated server |
| Draining or recovering | Status/history reads; reject new mutating workload requests |

Preserve existing environment status values where possible and add structured
readiness details. Do not report agent activity as idle while a turn is being
cancelled/reconciled; pipelines must not advance on ambiguous work.

## Implementation tasks

### Startup gates

- [x] Clear legacy ready markers before other entrypoint work, and publish the
  new status atomically. Include failure status when an initialization step
  fails. A missing firewall executable in restricted mode is fatal.
- [x] Make the backend wait for a current-boot initialization result before
  workspace preparation or launch. Recheck the boot identity immediately
  before dispatch to handle an intervening Docker restart.
- [x] Remove workspace setup's timeout-and-proceed behavior. Return a typed,
  retryable initialization failure with bounded phase diagnostics.
- [x] Keep initialization deadlines distinct from clone/setup/agent startup
  deadlines. Start with existing timeout budgets; record phase timing before
  tuning them. Never extend an outer command timeout without handling its
  in-flight child and recovery state.
- [x] Treat readiness files as orchestration evidence, not a security guarantee
  against the same container user. Enforce restricted-network failure outside
  untrusted repository setup and keep privileged policy inputs immutable.

### Setup semantics

- [x] Replace a global setup-complete shortcut with completion associated with
  workspace generation, setup-definition revision and relevant runtime/image
  capabilities. Preserve `createdFromCommit` for a retained checkout.
- [x] Separate checkout preparation from repository-controlled setup side
  effects. Record setup attempt identity and outcome durably.
- [x] If backend death interrupts setup after commands may have run, inspect
  owned process/completion state. Report an interrupted/unknown attempt rather
  than automatically rerunning non-idempotent repository commands.
- [x] Require explicit retry for an ambiguous setup attempt. Describe what
  may already have run; do not claim a rollback can undo external side effects.
- [x] Verify the immutable delegation baseline before allowing a resumed
  delegated workload. Never reset a dirty preserved checkout automatically.

### Process lifecycle

- [x] Add `--init` for capable images and verify child reaping. Keep a minimal
  keepalive if needed; init does not replace bridge lifecycle management.
- [x] Before explicit stop/rebuild, persist a draining state and fence new
  prompts, terminals, scheduled jobs and setup. Acquire locks in step 02 order;
  do not wait on a provider lock while holding a resource it needs to complete.
- [x] Drain through existing provider/terminal lifecycle APIs: interrupt live
  turns, settle/withdraw approvals using existing deny/abandon semantics, flush
  journals/transcripts and close owned PTYs/tmux jobs as appropriate.
- [x] Signal remaining registered processes with a bounded grace period, then
  escalate through Docker stop/kill only as the explicit operation requires.
  Record forced termination as an outcome, not successful graceful drainage.
- [x] New bridge launches register their identity with the backend so stop does
  not depend on a mounted tab or broad `pkill` matching unrelated processes.
- [x] Check `/proc/1/environ` reads with init enabled and retain the exact
  restricted-mode sudo policy. Never let caller-provided environment variables
  widen it.
- [x] Backend shutdown drains admitted mutations within its bounded deadline;
  it does not implicitly stop all persistent user containers. On restart,
  rehydrate their surviving processes and reconcile uncertain operations.
- [x] If this introduces a new long-lived Bun entrypoint, install the existing
  fatal-rejection guard next to its watchdog, preserving its inert behavior
  under tests. Handle owned abort/cancel rejections locally rather than treating
  the guard as normal error handling.

## Verification

- [x] Restart the same container after seeding stale ready files; delay current
  firewall/input setup and prove no agent/setup launch passes the gate.
- [ ] Test missing firewall script, failed DNS/bootstrap, permission failure,
  timeout, atomic-status-write interruption and Docker restart during launch.
- [x] Recreate a ready environment and verify it cannot inherit readiness from
  a different runtime. Keep a retained workspace's baseline unchanged.
- [x] Exercise long-running child/grandchild processes, orphan reaping,
  graceful completion, forced stop and signal-ignoring children on real Docker.
- [x] Interrupt setup around each command boundary; no automatic duplicate
  setup after backend restart and no false completion from old markers.
- [ ] Run agent work with a pending approval, switch away, stop explicitly and
  return. The approval must not be approved by timeout or generation death.

## Delivery and exit criteria

Land image support and capability declaration before enabling backend gates.
Legacy images remain guarded by step 01 and a compatibility explanation.
Expose capability-specific failures without silently falling back to the old
timeout behavior. Exit when readiness always belongs to the current boot,
ambiguous setup is recoverable and explicit stop has a measured bounded outcome.

## Implementation record

- **Image.** `docker/entrypoint.sh` declares `boot-status=1`: removes legacy
  markers and the previous record first, publishes an atomic per-boot record
  (`bootId`, `pid1Start`, phase, fixed failure code) and writes `failed` from an
  exit trap; a missing firewall in restricted mode is fatal
  (`firewall-missing`). `docker/workspace-setup.sh` waits for the current
  boot's record and fails retryably on failure or timeout instead of
  proceeding. `docker/orkestrator-drain.sh` declares `graceful-shutdown=1`.
- **Readiness.** `apps/backend/src/core/container-readiness.ts`: bounded probe,
  current-boot binding through PID 1's start time, `waitForContainerBoot`
  (typed `not-ready`, exited-container detection), `ensureCurrentBootReady`
  before workspace preparation and bridge/OpenCode launch.
- **Lifecycle.** Capable starts wait for readiness and record `boot` and the
  runtime `bootId`; setup completion records runtime/workspace generation
  (`setupCompletionIsCurrent`); interrupted setup remains fenced as failed.
- **Stop.** Capable images get `--init`; an explicit stop persists `draining`,
  fences bridges/terminals/setup, runs the drain, then `docker stop`, and
  records `signalled`/`remaining`/`forced`. Decision: the drain protects the
  keepalive and its whole ancestor chain (under `--init` that includes the
  entrypoint's `sudo`) and its own descendants, and signals every other process;
  per-bridge stop commands keep their specific process patterns, so no pidfile
  registry was added.
- **Tests.** `tests/unit/electron/container-readiness.test.ts` (probe parsing,
  stale-record rejection, failed/exited/timeout typing, no gating for legacy or
  unanswered probes, drain fence and parsing, setup currency).
  Live (`container-live-qualification.test.ts`, real Engine 29.7.2): restart
  never reports the previous boot, forged record ignored, drain under `--init`
  terminates trees and orphans without zombies and reports a TERM-ignoring
  survivor, network policy readable under init.
- **Limitations.** Failure injection for DNS/permission/status-write
  interruption and the pending-approval stop cycle with a real provider are
  part of step 14. Bridge approval denial on SIGTERM relies on each bridge's
  existing close semantics.
