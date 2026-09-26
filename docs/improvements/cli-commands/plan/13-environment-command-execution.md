# 13 — Execute bounded commands inside an environment

Status: Planned; second-stage feature, not a core CLI release prerequisite.
Depends on: [05](05-operation-receipts-and-idempotency.md),
[07](07-environment-lifecycle.md), [10](10-run-completion-and-waiting.md).
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

`environment exec ID -- <argv…>` runs a command in the selected local/container
workspace and returns an authoritative process result. Tests can invoke a
focused repository check, disconnect, and inspect its exit status later.
Terminal bootstrap or an output marker is never treated as command success.

## Owners and starting points

- [Terminal job commands](../../../../apps/backend/src/core/commands-registry-terminal.ts).
- [Container execution helpers](../../../../apps/backend/src/core/commands-container-exec.ts).
- [Review validation service](../../../../apps/backend/src/core/review-validation-service.ts),
  [worker](../../../../apps/backend/src/core/review-validation-worker.ts), and
  [artifacts](../../../../apps/backend/src/core/review-validation-artifacts.ts).
- [Review validation protocol](../../../../packages/protocol/src/review-validation.ts).
- Step-05 operation receipts and step-10 generic observation behavior.

## Work

1. Audit reusable validation-worker process ownership, artifact bounds,
   cancellation, and scheduler admission. Extract only proven common process
   execution helpers; do not require arbitrary exec to create a multi-review
   workflow or independently reimplement worker supervision.
2. Define argv, cwd, environment override, stdin, output, timeout, and terminal
   behavior. Initial exec is non-PTY and argv-preserving. Shell expansion occurs
   only through an explicitly chosen shell; never concatenate user arguments
   into a generated shell command. Backend paths are resolved against the
   selected environment, with documented confinement and validation.
3. Resolve execution authority and workspace identity server-side. Require
   running/setup-ready state, correct Docker owner, and no deletion admission.
   Do not let callers choose an unrelated host path or container ID by changing
   a CLI option. Reuse the environment's runtime/toolchain setup.
4. Admit and persist an immutable command operation before process creation.
   Record process/worker identity with protection against PID reuse, environment
   identity, execution timestamps, queue/execution budgets, and artifact paths.
   Do not place raw command arguments or environment values in routine logs.
5. Decide background ownership explicitly. The preferred worker outlives the
   observing CLI and publishes state/results independently. If the backend
   restarts, reconcile that exact worker; a missing/unverifiable process becomes
   interrupted/unknown and is not automatically rerun.
6. Capture stdout and stderr separately into bounded private artifacts, with
   explicit truncation or output-limit termination. Provide metadata and bounded
   page/tail reads through the backend. Drain pipes off the provider/transport
   read loops; a disconnected or slow CLI must not stall execution.
7. Persist exit code, terminating signal, timeout/output-limit reason, and final
   process-tree state before reporting completion. Expose `run wait` and a
   structured cancellation action targeting the exact worker. SIGTERM/SIGKILL
   escalation must wait for owned descendants to drain.
8. Define exit mapping without ambiguity: default CLI mapping follows step 01
   and JSON includes the actual child exit code/signal. An optional child-code
   passthrough mode must be explicit and distinguish transport failure. Do not
   overwrite the process result with the observer's timeout code.
9. Integrate repository test scenarios with the existing host-capacity runner
   and leases. Avoid double admission when a command already participates in
   the cooperative scheduler. General user exec should have bounded local
   concurrency rather than silently claiming a test-only scheduler slot.
10. Stop/delete/recreate must account for active command workers before changing
    their workspace. A successful environment deletion cannot leave an exec
    process modifying an untracked directory or surviving container.

## Verification

Use real local and container commands for success, nonzero exit, signal,
multibyte/large separate streams, argv containing shell metacharacters, bounded
stdin, timeout, output limit, and descendants. Test disconnect/reconnect,
backend restart, duplicate request, wrong owner, PID reuse simulation, and
environment deletion during execution.

Do not assert success by grepping output. Read the final authoritative process
result and independently check descendant cleanup. Run focused fixture checks
through the existing logged test/scheduler paths where applicable.

## Acceptance and handoff

- [ ] Exec preserves argv/cwd and enforces environment ownership.
- [ ] Exit code/signal and failure reasons are authoritative and persistent.
- [ ] Client/backend disconnection never triggers automatic re-execution.
- [ ] Output, runtime, concurrency, and process-tree cleanup are bounded.
- [ ] Local and container execution are individually qualified.

Keep exec unavailable until both ownership and result semantics are proved.
Withdrawing new exec admission must leave worker status/cancellation and cleanup
available for already accepted operations.
