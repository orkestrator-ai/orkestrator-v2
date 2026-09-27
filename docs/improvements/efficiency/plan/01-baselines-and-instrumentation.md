# 01 — Establish baselines, counters, and synthetic fixtures

Status: Not started. Prerequisites: none. Findings: all.

## Outcome

Every later step can show which work was removed, while correctness tests
remain independent of machine timing. Reuse the existing synthetic probes from
[validation.md](../validation.md); do not inspect live user histories to build
fixtures.

## Code and artifacts

- [Progressive read metrics](../../../../apps/backend/src/core/native-agent-progressive-metrics.ts).
- [Projection read paths](../../../../apps/backend/src/core/native-agent-service-projection.ts).
- [Gateway metrics](../../../../apps/backend/src/gateway-support-core.ts).
- [Storage writes](../../../../apps/backend/src/core/storage-base.ts).
- [Frontend session hook](../../../../apps/web/src/hooks/useNativeAgentSession.ts).
- Proposed `scripts/efficiency/` harness and small synthetic fixture generators;
  integrate repository-level invocation through mise using existing task style.
- Per-run output under the isolated testing artifact directory, with an explicit
  run ID. Never commit generated multi-megabyte fixtures or profiler dumps.

## Implementation

1. Define a measurement vocabulary: source bytes read; parsed records; message
   and part serialization visits; normalization visits; detail-cache hits;
   projected bytes; encoded wire bytes; disk bytes written/copied; queue wait;
   cache evictions; and maximum admitted/in-flight bytes. Keep metrics grouped
   by provider/domain/outcome, not session ID, path, prompt, or content digest.
2. Populate the existing optional scheduler/source/normalization timing fields
   at actual phase boundaries. Use a monotonic clock for durations. Separate
   time awaiting provider I/O from synchronous processing and serialization.
3. Instrument counts through narrow injectable test hooks or bounded optional
   counters. Do not add unconditional per-token logging or capture payloads.
   If counting a byte size would require an extra serialization, consume the
   size already computed by the real path instead.
4. Track coalesced and joined requests separately from provider reads. One
   frontend refresh may perform several independent domain reads; count those
   explicitly so total request reductions are not hidden by a renamed metric.
5. Generate fixture families: ASCII/multibyte prose; many short parts; a large
   tool result; a large diff; a data-URL image; nested-agent activity; rewritten
   history; interrupted JSONL records; and a long immutable prefix with one
   changing tail. Parameterize sizes without storing private example content.
6. Add workload runners for idle reads, streaming without readers, history
   paging, multiple clients, shared-store updates, and workflow polling. A
   lightweight function-level runner comes first; real-stack runs use the
   existing isolated profile launcher and exact-owner fixtures.
7. Record Bun/app versions, fixture dimensions, iteration counts, warm/cold
   status, GC/heap measurement method, and wall-clock window. Use multiple
   repetitions for latency percentiles; report variance and sampling limits.

## Baseline matrix

| Workload | Minimum baseline |
| --- | --- |
| Unchanged transcript | 100 and 1,000 messages, revision and no-revision paths |
| Trimming | 100 messages and many parts; same retained output across algorithms |
| Background Cursor | More than 512 parts with no read route invoked |
| Display storage | 1/32/128 records; update and cold-read one record |
| Renderer | 0/1/8 MiB retained history while one tail changes |
| Codex | Small rollout, working set above soft cap, single file above hard cap |
| Review/pipeline | Several active sessions plus completed historical stages |
| Remote | Supported proxy, constrained bandwidth, reconnect, slow client |

## Acceptance and tests

- Counters never retain source objects or secret-bearing strings. Sample and
  label collections have explicit bounds and disposal tests.
- The three original probes reproduce their structural behavior at baseline.
- Turning instrumentation off preserves the output and execution semantics.
- Counters distinguish source bytes from encoded bytes and estimated heap.
- No pass/fail unit assertion depends on achieving a fixed number of ms.
- A baseline report is available for the first urgent fixes. Larger remote and
  workflow baselines can be filled in before their respective implementation.

## Delivery and rollback

One initial instrumentation/fixture PR is sufficient; avoid a broad observability
rewrite. Hooks are internal and disabled or low-cost by default. Removing an
optional metric must never change admission or budget enforcement. Subsequent
steps append their before/after results using the same fixture definitions.
