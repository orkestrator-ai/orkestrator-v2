# Federated client benchmarks

> **Historical:** the measured client runtime and `scripts/benchmark-federation.ts`
> were removed in favour of command nodes
> ([command-nodes-handoff.md](command-nodes-handoff.md)). The numbers below
> describe the removed design.

Evidence for `docs/temp/remote.md` section 17 (performance budgets). These are
measurements on one development Mac, not thresholds or support guarantees.

## What was measured

`bun scripts/benchmark-federation.ts [--json]` drives the renderer's real
`BackendClientRegistry` and `BackendRuntime` (`apps/web/src/lib/federation/`)
against synthetic in-process backends:

- 1, 3, 10 and 25 configured machines, 200 environments each (10 projects),
  every machine using the same local project and environment IDs.
- From 3 machines up, one machine answers every read after 300 ms and one is
  unreachable.
- Reported: time until the first machine's summaries are usable, time until
  every reachable machine is current, summary reads issued, transcript-class
  reads issued (must be zero), serialized summary size per machine, and
  subscriptions left after 50 sync/dispose cycles.

Run on 2026-10-21 (Bun 1.4.2, Apple Silicon):

| Machines | Environments loaded | First usable | All reachable current | Summary reads | Transcript reads | Summary KiB / machine | Leaked subscriptions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 7 ms | 7 ms | 11 | 0 | 52 | 0 |
| 3 | 400 | 16 ms | 1202 ms | 23 | 0 | 52 | 0 |
| 10 | 1800 | 30 ms | 1204 ms | 100 | 0 | 52 | 0 |
| 25 | 4800 | 64 ms | 1241 ms | 265 | 0 | 53 | 0 |

Reading the table:

- The first machine is usable within tens of milliseconds regardless of the
  slow and unreachable machines (RT-01). "All reachable current" is bounded
  by the slow machine (300 ms × ceil(10 projects / 4 concurrent reads) plus
  the project list), not by the machine count.
- Summary reads scale linearly with machines (1 project list + 1 environment
  read per project) and no transcript or detail read is issued by a summary
  (PF-02).
- No subscription survives repeated connect/disconnect cycles (PF-01).

Related deterministic tests: `apps/web/src/lib/federation/federation-runtime.test.ts`
(PF-01 demand cycles, PF-02 bounded summaries, PF-03 event-flood coalescing)
and `apps/desktop/tests/connection-manager-federation.test.ts` (RT-01 with real
connection-manager concurrency limits).

## Not measured

The plan's full matrix needs real backends and is **not** covered here:

- the Electron IPC hop and real gateway latency per backend;
- encoded bytes per backend per minute, active sockets and CPU;
- 1/2/4 visible detail panes and streaming terminal output;
- approval/completion visibility p95 against the 2 s / 3 s targets;
- several clients observing one server;
- single-backend startup against a recorded pre-change baseline.

No transport defaults (SSE or SSH compression, terminal transport) were
changed by the federation work, so the existing single-backend bandwidth
measurements in `docs/todo/transcripts-and-observation/0052-remote-client-bandwidth.md` still apply to the
bound machine's own window.
