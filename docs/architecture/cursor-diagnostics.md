# Cursor stall investigation

Status: Historical — 2026-09-09 and 2026-09-14 stall investigations. Current logging is in bridge-diagnostics.md.

> Historical incident record from 2026-09-09. The sandbox bootstrap barrier
> described here is in `bridges/cursor-bridge/src/sandbox-bootstrap.ts`. For
> current operator logging, use [shared bridge diagnostics](bridge-diagnostics.md).

Cursor now uses the [shared bridge diagnostics](bridge-diagnostics.md).

## Multi-review tool stall on 2026-09-14

The `fix-linting-issues` review's Cursor / Grok 4.6 reviewer stopped making
progress while its three peer reviewers completed. This was a live run stall,
not merely an orphaned tool card. The production bridge and the checked-out
bridge both used `@cursor/sdk` 1.0.31, also used in the September 9 incident.
The investigation did not cancel, restart, or redispatch the production run.

### Evidence

Times below are UTC (the screenshot shows BST, one hour ahead). Evidence came
from the production application's September 14 log, the matching SDK
`run_events.ndjson` and `runs.ndjson`, persisted Multi Review progress, the
packaged bridge/backend code, and read-only process/file inspection. Raw
transcripts and checkpoints were not copied into the repository.

| Time | Observation |
| --- | --- |
| 10:50:49 | The reviewer dispatched successfully. |
| 10:54:59.126 | Last persisted SDK event: `read`, `running`, for `useNativeAgentSession.progressive.test.tsx`. The bridge's last delta was explicitly `tool-call-started`. |
| 10:55:50.084 | Multi Review's periodic probe last observed transcript progress. |
| 11:05:50.646 | Multi Review recorded `stalledSince`, ten minutes after that observation. |
| 11:14:49.267 | Bridge still reported `phase=following`, `terminal=pending`, `stream=pending`, and no cancellation. Neither public SDK channel had progressed for 1,190,142 ms. |

Diagnostic correlation hashes are session `29b8c1c38caa274d` and run
`9f90472db3671b84`. During the stall, the counters remained at 2,331 deltas,
1,107 stream events, 54 completed tools, zero translation failures, and zero
active subagents. Diagnostic timer delay stayed around 0–2 ms. The bridge
process remained alive with its local listener and established HTTPS sockets;
these facts establish process responsiveness, not upstream run health.

The target was a regular 51,560-byte file. An independent local read took
approximately 0.05 ms. The SDK had already reported three successful reads of
that same path during this turn, at 10:51:22, 10:51:46, and 10:53:52. A
persistently unreadable file is therefore not the explanation; this check does
not prove what happened inside Cursor's executor at the final read.

There was also an unmatched earlier read of `.git/HEAD`, after which the run
continued for several minutes. Successful unrelated runs likewise retained
unmatched starts. Pending-tool counts alone do not prove that those operations
are still executing. The stronger evidence here is that both SDK channels and
the SDK's own terminal record stopped advancing together.

### Why the previous fix does not cover this incident

Commit `fc0bf53c` (#734) settles abandoned tool cards and backfills terminal
text when the run ends. This run never supplied a terminal result, so
`finishTurn` and its cleanup could not run. The September 9 sandbox bootstrap
fix addresses attach failure before a turn starts; this turn successfully
executed dozens of tools. Neither change repairs an in-flight SDK stall.

The installed recovery policy also explains the prolonged workflow lock:

- `multi-review-progress.ts` warns after ten minutes without observed progress,
  but its abandonment threshold is 45 minutes. For the recorded progress time,
  that threshold is approximately 11:40:50 UTC, subject to the next supervisor
  tick and cancellation/teardown. This was a prediction, not an observed recovery.
- `cursor-bridge/src/config.ts` gives the complete turn six hours, with no
  separate bridge deadline for loss of SDK progress. Its cancellation grace
  period applies after that timeout; it is not an inactivity detector.
- Keeping the session busy until it stops avoids claiming completion or
  starting overlapping work while the old run might still execute.

### Remaining boundary and follow-up

The evidence locates the failure inside Cursor's SDK/execution/remote-service
path, before Orkestrator receives completion. It does **not** identify the exact
blocked SDK handler or prove that Grok, the network, or the local file executor
caused it. SDK 1.0.31 drops upstream heartbeat interaction frames before its
public callback, and a tool-start update is not proof of a local filesystem
operation starting. An established socket does not resolve that ambiguity.

The next useful diagnostic is bounded, content-free visibility at the SDK
transport/executor boundary: received heartbeat age, last request/response
category, and active executor-handler age. Public transcript counters cannot
provide those observations. Any SDK instrumentation should keep the shared
diagnostic privacy rules; enabling raw vendor logs would expose more than is
needed. A vendor escalation can use the locally retained run/request IDs and
this timeline without sending prompts or file contents.

Recovery work should use meaningful progress and the type of outstanding work,
with acknowledged cancellation before replacing a run. Reducing the six-hour
total budget alone would also terminate legitimate long turns. Never replay an
ambiguous dispatch automatically.

Code inspection additionally found an independent recovery gap in `followRun`:
both terminal-result paths do an unbounded `await drained` after their bounded
terminal wait. A resolved terminal result with a stream that never closes could
therefore remain busy indefinitely. This is **not** the observed incident
(`terminal` was still pending), and needs a separate regression with a resolved
`wait()` and non-closing `stream()` before changing that path.

The logging follow-up adds the SDK transport and execution observations
described in [Cursor SDK boundary snapshots](bridge-diagnostics.md#cursor-sdk-boundary-snapshots).
It uses the existing debug setting and does not change the recovery policy.

## Investigation on 2026-09-09

A Grok 4.6 review through Cursor SDK 1.0.31 stopped emitting persisted SDK
events at 08:27:27 UTC. The bridge remained responsive, with one shell call and
three task calls pending and no shell subprocess remaining. The equivalent
read-only Git diff completed independently in 13 ms. No terminal result or
exposed approval explained the wait.

The installed SDK drops upstream heartbeat frames before its public interaction
updates, and its persisted SDK messages collapse partial and started tool calls
into the same `running` status. Therefore those historical messages cannot
establish whether the tools actually began execution or locate the upstream
stall. The diagnostics preserve that distinction for future incidents without
changing cancellation, retry, approval, or timeout behaviour.

## Multi-review startup failure on 2026-09-09

The 23:25 UTC local review failed in `agent.send` before producing an assistant
message. Its persisted bridge session contained `Local SDK sandboxing was
requested, but sandboxing is not supported in this environment`; the backend
presented that as a generic dispatch HTTP 500. The installed macOS sandbox
helper was present and executable.

SDK 1.0.31 registers `cursorsandbox` only when constructing a sandbox-enabled
executor. An earlier unsandboxed preparation can request environment metadata,
which asks whether sandboxing is supported. The SDK caches the negative answer
before the helper is registered and never invalidates it. A subsequent read-only
review or consolidation therefore fails despite the helper being available.

`sandbox-bootstrap.ts` initializes sandbox discovery through the SDK's public
workspace prewarm API before the first *unsandboxed* host attach. Concurrent
attaches await the same initialization. The temporary executor has no settings
sources or MCP servers, dispatches no turn, and releases its lease. Container
sessions skip it; their outer sandbox remains the boundary. A sandbox-enabled
host preparation skips it too: its own options construct the executor that
registers `cursorsandbox`, so the probe would only repeat the workspace scan
that is the dominant cost of the first attach on a large checkout. The options,
not the policy label, control this exemption; any unsandboxed host preparation
is primed because its sandbox-support read can cache the negative verdict.
Unsupported hosts still admit normal unsandboxed sessions, while read-only
sessions retain their sandbox requirement and closed tool allowlist.

The barrier is settled by a probe that reached a lease, or by the SDK's
"sandboxing is not supported in this environment" verdict, which is final. Any
other failure leaves `cursorsandbox` unregistered, so the next host attach
probes again rather than letting one transient error reinstate the failure for
the rest of the process. Neither swallowed failure changes the attach it was
observed on; both write a single `setup-failed` diagnostic line, carrying the
error message only, under the cursor bridge debug flag.

The diagnosis was reproduced against the installed SDK by constructing an
unsandboxed executor, invoking its sandbox-support metadata callback, then
constructing a sandboxed executor. The latter threw the same error. Performing
the bootstrap first made both executors succeed and the metadata report support.
The earlier unused-initial-run fix addresses a separate failure and remains
necessary.
