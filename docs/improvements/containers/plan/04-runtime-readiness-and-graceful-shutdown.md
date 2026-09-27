# 04 — Runtime readiness and graceful shutdown

Status: Not started. Dependencies:
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

- [ ] Clear legacy ready markers before other entrypoint work, and publish the
  new status atomically. Include failure status when an initialization step
  fails. A missing firewall executable in restricted mode is fatal.
- [ ] Make the backend wait for a current-boot initialization result before
  workspace preparation or launch. Recheck the boot identity immediately
  before dispatch to handle an intervening Docker restart.
- [ ] Remove workspace setup's timeout-and-proceed behavior. Return a typed,
  retryable initialization failure with bounded phase diagnostics.
- [ ] Keep initialization deadlines distinct from clone/setup/agent startup
  deadlines. Start with existing timeout budgets; record phase timing before
  tuning them. Never extend an outer command timeout without handling its
  in-flight child and recovery state.
- [ ] Treat readiness files as orchestration evidence, not a security guarantee
  against the same container user. Enforce restricted-network failure outside
  untrusted repository setup and keep privileged policy inputs immutable.

### Setup semantics

- [ ] Replace a global setup-complete shortcut with completion associated with
  workspace generation, setup-definition revision and relevant runtime/image
  capabilities. Preserve `createdFromCommit` for a retained checkout.
- [ ] Separate checkout preparation from repository-controlled setup side
  effects. Record setup attempt identity and outcome durably.
- [ ] If backend death interrupts setup after commands may have run, inspect
  owned process/completion state. Report an interrupted/unknown attempt rather
  than automatically rerunning non-idempotent repository commands.
- [ ] Require explicit retry for an ambiguous setup attempt. Describe what
  may already have run; do not claim a rollback can undo external side effects.
- [ ] Verify the immutable delegation baseline before allowing a resumed
  delegated workload. Never reset a dirty preserved checkout automatically.

### Process lifecycle

- [ ] Add `--init` for capable images and verify child reaping. Keep a minimal
  keepalive if needed; init does not replace bridge lifecycle management.
- [ ] Before explicit stop/rebuild, persist a draining state and fence new
  prompts, terminals, scheduled jobs and setup. Acquire locks in step 02 order;
  do not wait on a provider lock while holding a resource it needs to complete.
- [ ] Drain through existing provider/terminal lifecycle APIs: interrupt live
  turns, settle/withdraw approvals using existing deny/abandon semantics, flush
  journals/transcripts and close owned PTYs/tmux jobs as appropriate.
- [ ] Signal remaining registered processes with a bounded grace period, then
  escalate through Docker stop/kill only as the explicit operation requires.
  Record forced termination as an outcome, not successful graceful drainage.
- [ ] New bridge launches register their identity with the backend so stop does
  not depend on a mounted tab or broad `pkill` matching unrelated processes.
- [ ] Check `/proc/1/environ` reads with init enabled and retain the exact
  restricted-mode sudo policy. Never let caller-provided environment variables
  widen it.
- [ ] Backend shutdown drains admitted mutations within its bounded deadline;
  it does not implicitly stop all persistent user containers. On restart,
  rehydrate their surviving processes and reconcile uncertain operations.
- [ ] If this introduces a new long-lived Bun entrypoint, install the existing
  fatal-rejection guard next to its watchdog, preserving its inert behavior
  under tests. Handle owned abort/cancel rejections locally rather than treating
  the guard as normal error handling.

## Verification

- [ ] Restart the same container after seeding stale ready files; delay current
  firewall/input setup and prove no agent/setup launch passes the gate.
- [ ] Test missing firewall script, failed DNS/bootstrap, permission failure,
  timeout, atomic-status-write interruption and Docker restart during launch.
- [ ] Recreate a ready environment and verify it cannot inherit readiness from
  a different runtime. Keep a retained workspace's baseline unchanged.
- [ ] Exercise long-running child/grandchild processes, orphan reaping,
  graceful completion, forced stop and signal-ignoring children on real Docker.
- [ ] Interrupt setup around each command boundary; no automatic duplicate
  setup after backend restart and no false completion from old markers.
- [ ] Run agent work with a pending approval, switch away, stop explicitly and
  return. The approval must not be approved by timeout or generation death.

## Delivery and exit criteria

Land image support and capability declaration before enabling backend gates.
Legacy images remain guarded by step 01 and a compatibility explanation.
Expose capability-specific failures without silently falling back to the old
timeout behavior. Exit when readiness always belongs to the current boot,
ambiguous setup is recoverable and explicit stop has a measured bounded outcome.
