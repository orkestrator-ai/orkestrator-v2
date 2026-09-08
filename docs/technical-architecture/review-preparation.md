# Multi-review preparation

Manual multi-review and pipeline review preparation use the same three stages:

1. An agent commits the relevant safe changes and discovers a validation plan.
2. An environment-owned worker executes that plan and captures evidence.
3. The backend seals one package, then gives every reviewer its reference.

The agent is no longer responsible for waiting on commands, ingesting their
output, calculating exit codes, or assembling the evidence package. Pipeline
implementation and fix prompts request focused development checks; the following
preparation stage owns the final full validation pass.

## Fresh discovery for arbitrary repositories

There is deliberately no cross-round command-plan or result cache. Each round
examines the current instructions, tree, changes, CI, manifests, task definitions,
scripts, and toolchain. The prompt assumes no language or package manager and
does not use a fixed list of configuration filenames as a freshness heuristic.
An explicit preparation retry also discovers a new plan.

The plan identifies the exact committed HEAD, commands, relative working
directories, prerequisites, exclusive resources, weights, timeouts, and coverage
limitations. Runtime validation bounds the plan to 32 commands and 24,000 UTF-8
bytes. Dependencies must refer to earlier commands, so cycles are rejected.
Missing prerequisites are limitations, not implicit permission to install tools.

The worker uses Orkestrator's Bun runtime and Bash, including inside Docker; the
reviewed repository needs neither a JavaScript manifest nor application code to
host the worker. Project commands still need their own declared tools installed.

## Execution and parallelism

Commands with satisfied prerequisites can overlap. The initial concurrency
budget is two: weight-one commands can run together, while internally parallel
or memory-heavy commands use weight two. Overlapping resource names serialize;
`*` reserves the runner exclusively. Discovery must explicitly assess parallel
safety rather than infer it from a command's name.

A failed prerequisite skips its dependants with an explicit reason. Independent
checks continue, preserving useful evidence from a failing suite. Command
timeouts range from one second to two hours. Cancellation, timeout, and output
overflow terminate the command's process group. A worker-death watchdog also
terminates its command groups. Intentionally detached commands are unsupported.

Each workspace has one validation lock, preventing separate review jobs from
interfering. Waiting for another job is bounded to two minutes. Backend or UI
restarts reconnect to the existing run rather than launching duplicate commands.
An uncertain/stale worker is reported as an error and requires explicit recovery;
it is never treated as evidence that a command did not run.

## Evidence and sealing

The worker streams stdout and stderr directly into private files under
`.orkestrator/review-artifacts/<run-id>/`. Captures are bounded to 32 MiB per
stream and 256 MiB per run. Exceeding a bound fails that check and records that
the evidence is incomplete. Raw output does not return in control responses or
enter the preparation agent's context.

Durable result metadata records actual exit status, duration, byte counts,
artifact paths, and SHA-256 digests. Files become read-only when closed. Clean
Git status and HEAD are checked before and after execution; a changed snapshot
cannot be certified. Package generation checks the expected HEAD again and
verifies captured artifact hashes.

The sealed manifest contains the plan and validation metadata alongside the
existing diff and review context. Reviewers share its immutable package
reference. Integrity verification checks both the manifest and hashed logs.
Reviewer prompts request summaries first, targeted reads of failure evidence,
and no duplicate full validation pass. Large successful logs are not injected
into reviewer prompts. Read-only files and hashes detect accidental changes;
they are not a security sandbox against a malicious project command.

## Lifecycle and visibility

Authoritative worker state lives in an atomically replaced, size-bounded state
file with a heartbeat. Workflow snapshots project that state to both review UIs.
Switching tabs/environments or unmounting a component does not cancel validation.
Explicit cancellation, pipeline pause, and environment stop/delete drain active
workers. A persistent cancellation marker prevents delayed launch requests from
starting a cancelled run.

The UI shows per-command status and duration, limitations, and separate discovery
and snapshot, validation, and packaging timings. Progress remains recoverable
after reload. Legacy in-flight preparation results and older packages without
log hashes remain readable during upgrades.

## Performance boundary and verification

Without reusing earlier results, preparation cannot finish before its required
commands finish. This design removes agent round trips and log processing from
execution, avoids the pipeline's duplicate final pass, and overlaps safe work.
Its target is discovery plus the command dependency critical path plus small
sealing overhead. Discovery latency still depends on the selected agent and
repository; no fixed speedup is assumed.

Real-process worker tests cover overlapping commands, resource exclusion,
dependency failures, idempotent launch/reconnect, cancellation, timeout, output
bounds, snapshot changes, and same-size artifact replacement. Controller tests
cover manual and pipeline handoff and controller replacement. Service tests
exercise the backend command path, sealing, integrity, and environment cleanup.
The browser gateway suite includes a real-worker test that switches environments,
lets validation finish, reloads, and reads the same completed snapshot.
