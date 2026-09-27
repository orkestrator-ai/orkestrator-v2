# 11 — Bounded logs and diagnostic subscriptions

Status: Not started. Dependencies:
[02](02-lifecycle-authority-and-durable-operations.md),
[04](04-runtime-readiness-and-graceful-shutdown.md).
Return to [index](00-index.md).

## Goal

Keep diagnostic collection useful without unbounded Docker followers, memory
buffers or files. Make subscription disconnect/reconnect behavior explicit and
keep raw user content separate from product telemetry.

## Integration points

- [Log commands](../../../../apps/backend/src/core/commands-registry-docker.ts):
  `stream_container_logs` and `get_container_logs`.
- [Bridge startup diagnostics](../../../../apps/backend/src/core/commands-containers.ts),
  [exec helpers](../../../../apps/backend/src/core/commands-server-health.ts),
  [shell runner](../../../../apps/backend/src/core/shell.ts).
- [Gateway event transport](../../../../apps/backend/src/gateway-events.ts),
  [event replay](../../../../apps/backend/src/gateway-event-replay.ts),
  [Docker client](../../../../apps/web/src/lib/backend/docker-skills.ts).
- [Existing log storage](../../../../apps/backend/src/core/log-storage.ts) and
  [diagnostic guide](../../../architecture/bridge-diagnostics.md).

## Initial bounds to implement and qualify

These are proposed starting limits. Make them constants with tests and revisit
using actual failure diagnostics; they are not claims about current behavior.

| Resource | Proposed initial bound |
| --- | --- |
| Docker stdout/stderr log | `local` driver, 10 MiB per file, 3 files per container |
| Each bridge diagnostic file | 5 MiB per file, 3 files; include aggregate environment budget |
| Startup failure tail | At most 64 KiB and 200 lines, whichever is smaller |
| Live diagnostic event | 16 KiB, with incremental UTF-8 decoding/splitting |
| Follower replay ring | 1 MiB and 2,000 records per active source |
| Client pending queue | 256 KiB and 256 records, explicit gap on overflow |
| Concurrent followers | One per source/generation; proposed cap 16 per backend |
| Idle follower grace | 5 seconds after last consumer, then terminate |

## Implementation tasks

### File and process ownership

- [ ] Set explicit bounded Docker logging options for newly created runtimes
  and validate the selected daemon supports them. Apply to old containers via
  safe rebuild, not an implicit daemon configuration change.
- [ ] Separately rotate bridge files. Docker logging does not rotate files
  written under `/tmp`. Prefer a launch wrapper/logger that owns the open file
  and can reopen on rotation; avoid losing writes through naive rename while
  the bridge keeps writing the old inode.
- [ ] Preserve bridge output draining: no pipe consumer may block Codex's
  stdout read loop or session execution waiting for rendering/network clients.
  Separate diagnostics from authoritative transcript/state events.
- [ ] Track total retained diagnostic bytes per environment and backend, with
  bounded cleanup. Never delete transcript/journal/session data as log rotation.
- [ ] Replace whole-file `cat` in health failures with bounded tail extraction
  at the source plus a second output limit in the host runner. One enormous
  line must not defeat a line-count-only limit.

### Subscription contract

- [ ] Introduce a proposed `ContainerLogService` owned by backend lifetime.
  Resolve ownership before reading logs, not only before mutating containers.
- [ ] Add open/close subscription handles, keyed by source and runtime/boot
  generation. Reference-count shared Docker follower processes. Attach the
  handle to gateway/client lifecycle and explicit UI disposal.
- [ ] Keep a short replay cursor with source generation. Subscribe before
  calculating replay, and echo the client's cursor before replay is complete.
  On overflow or expired cursor send an explicit gap/reconciliation frame.
- [ ] Fetch a bounded authoritative tail on reconnect; report truncation
  honestly. Diagnostic gaps must never be reused as permission to drop
  authoritative lifecycle, approval or transcript events.
- [ ] Own child exit/error handlers and abort rejection handlers. Backend
  shutdown stops followers even when clients disappeared without closing them.
- [ ] Reject excess subscriptions with a bounded-resource result. Do not spawn
  another follower for every rerender or reconnect retry.
- [ ] Keep legacy stream commands as adapters with disconnect-bound lifetime
  during transition. An old command with no disposal handle must not create an
  immortal process.

### Privacy and UI

- [ ] Keep telemetry to durations, counts, fixed failure categories and hashed
  ownership identifiers. Never persist raw tails in operation errors/metrics.
- [ ] Display requested diagnostic content only in authorized log views using
  existing redaction safeguards. Redaction is not proof that logs contain no
  prompts or file contents; private artifacts still require retention bounds.
- [ ] UI distinguishes source-ended, disconnected, truncated and complete-tail
  states. A replaced runtime opens a new source, never appends output to the old
  source under the same cursor.
- [ ] A hidden log view can release its subscription; this releases only the
  observer, not the container, bridge or running user task.

## Verification, rollout and exit criteria

- [ ] Repeat open/close/remount/disconnect cycles and assert follower count
  returns to baseline within grace. Include backend restart and replaced source.
- [ ] Feed huge lines, binary-looking bytes, split multibyte characters and slow
  consumers. Memory remains bounded and every dropped range is signaled.
- [ ] Test rotation while a bridge is writing and verify output continues in
  the new file without blocking the underlying process.
- [ ] Create a very large fixture log; startup failure response remains within
  the specified byte/line limit and safe errors contain no injected secret.
- [ ] Exercise inactive-environment reconnect and expired cursors using the
  actual gateway path, preserving existing replay invariants.

Ship tail bounds first, service ownership second and rotation/subscription UI
afterward. Rollback may fall back to bounded one-shot tails; it must not restore
unbounded followers or whole-file reads. Exit when file, queue and child-process
limits are enforced independently and missing diagnostic output is explicit.
