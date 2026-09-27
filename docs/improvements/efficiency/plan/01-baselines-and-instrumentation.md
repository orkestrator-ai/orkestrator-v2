# 01 — Establish baselines, counters, and synthetic fixtures

Status: Implemented, validation pending (function-level baseline recorded; real-stack and remote baselines pending). Prerequisites: none. Findings: all.

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

## Execution record

```text
Status: Implemented, validation pending
Implementation commit / PR: branch implement-efficiency-improvements-7f0993836777-r1,
  commit "perf(efficiency): baseline harness, phase metrics and step-14 gate".
  Harness: scripts/efficiency/ (run.ts CLI; harness.ts runner/compare/summary;
  counters.ts; fixtures.ts; delta-analysis.ts; workloads-*.ts), mise task
  `efficiency:baseline`, reports under output/efficiency/<run-id>/ (ignored).
  Results: docs/improvements/efficiency/baseline/ (README.md table,
  step-01-summary.json, 34 KB).
Protocol or storage decisions: none. Instrumentation is metric-only:
  - native-agent-progressive-metrics.ts: monotonicMs() now uses
    performance.now(); new ProgressiveReadPhaseTimer splits a read into
    sourceMs (awaiting the provider read), normalizeMs (projection after the
    provider answered + commit) and schedulerWaitMs (time in the shared-read
    scheduler that was not this caller's own read), and marks `joined` when
    the caller's own read never ran. Phases sum to at most durationMs; only
    durations are kept.
  - native-agent-service-projection.ts: getTranscriptUpdate's awaited read and
    the direct history page record those phases; read durations use the
    monotonic clock (transcript, state and direct-page reads). Wall-clock
    timestamps stay on the injected `now`. Background refreshes behind a cached
    answer are not attributed to the response.
Design: the harness imports repository modules from `--root`, so one set of
  workloads measures a baseline worktree and the current tree; a case whose API
  is absent at a root measures the path that root served (named) or reports
  itself unsupported. Primary metrics are deterministic counts (serialization
  visits via non-enumerable toJSON as in validation.md, JSON.stringify calls on
  projected rows, provider calls/messages returned, record-store payload I/O,
  full rollout parses, decoded/gzip bytes, retained parts/bytes); every count
  was stable across repetitions. Syscall bytes come from /proc/self/io,
  rounded to KiB (one baseline KiB value varied at a rounding boundary and is
  flagged in the summary). Wall-clock p50/p95 are secondary, labelled
  machine-specific and never compared. Fixtures are seeded and sized (ASCII/
  multibyte prose, many parts, large tool result, large diff, data-URL image,
  nested agent, rewritten history, interrupted JSONL, immutable prefix +
  changing tail); nothing is read from a profile.
Tests and isolated profiles:
  - apps/backend/src/core/native-agent-progressive-metrics.test.ts (new):
    sample bound/rounding, monotonic clock, phase split on a manual clock,
    joined caller, failed provider read, and a service-level read where the
    reading and the joined caller both record bounded phases and no payload,
    id, session key or token appears in the samples.
  - tests/unit/efficiency/harness.test.ts (new; root runner picks up ./tests,
    not scripts/): fixture sizes/determinism, content-free id digests,
    counting encodes byte-identically, stringify interception always restored,
    step-14 delta accounting, percentile/runCase/compare/summary.
  - Ran: backend suite `bun test --cwd apps/backend ... src tests
    --parallel=2`: 4,969 pass, 9 fail — all nine in tests/standalone.test.ts,
    which needs the built apps/backend/dist/main.js (not built in this
    worktree; unrelated). New metrics test file: 6 pass. Root:
    tests/unit/efficiency (18 pass), mise-tasks/gitignore/monorepo/docs guards:
    2 pre-existing failures in files this step does not touch
    (validation.md's stdin probe commands and plan 13's browser-suite
    wording; both since fixed). Backend typecheck, ad hoc strict tsc
    over scripts/efficiency, mise run format / format:check / lint: pass
    (pre-existing warnings only). Harness run end to end against both roots.
  No real-stack, browser, Docker or remote run.
Before/after measurements: e8fbf1d0 (review baseline) vs d8796c28 on AMD Ryzen 5
  PRO 5650U, 12 logical CPUs, 30.7 GiB, Bun 1.4.2 — full table in
  baseline/README.md. The three original probes reproduce exactly at the
  baseline: 1,000 vs 0 visits (unchanged read without/with revision); Cursor
  trim 4,585 visits / 31 kept vs shared helper 100 / 31 kept; Cursor stream 600
  parts / 712,206 B, 220 / 261,256 B after the read bound. Headlines at the
  candidate: Claude unchanged read 1,000 -> 0 visits; trimming 4,585 -> 100
  (parts 51,197 -> 800) with identical retained ids; unobserved Cursor stream
  600 -> 378 parts; one display-tail update at 128 records 16,734 -> 8 KiB read
  and 11,155 -> 86 KiB written; v1 -> v2 window 517,504 -> 219,127 B with 27 ->
  100 messages; history paging 4 -> 0 interactive snapshots (v2 providers;
  1,100 -> 250 provider messages); rollout above the
  hard cap 20 -> 1 full parses; frontend tail update at 8 MiB history 4,196 ->
  1 visits; backend changed read 400 -> 100 row serializations. Step 14 input
  recorded there (Prototype warranted).
Compatibility/migration result: none; no protocol, storage or behaviour change.
Remaining limitations:
  - Function-level only. Not measured: remote proxy/bandwidth/reconnect/slow
    clients, real providers and bridges over HTTP, browser long tasks and input
    latency, peak heap/RSS, event-loop lag, review/pipeline workloads (E11-E14
    rows are explicit "not measured").
  - Bytes-written counters come from /proc/self/io (Linux; -1 elsewhere).
  - Serialization counting cannot see work on copies the code makes, so visit
    counts are lower bounds; baseline display-tail payload counts are derived
    from the shared-file design.
  - The frontend workload reproduces the hook's per-install calls, not React.
  - Phase metrics cover the transcript read path only; state and discovery
    reads report duration without phases.
```
