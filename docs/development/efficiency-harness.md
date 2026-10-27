# Efficiency harness

Status: Living — how to run `efficiency:baseline`, what it measures and what
it cannot.

`scripts/efficiency/` is a deterministic, function-level harness for
transcript, projection and storage cost. It imports the real exported
functions of a repository root, drives them with generated fixtures, and
reports exact operation counts. It needs no provider, network, Docker or
profile, and a full run takes about a minute. Use it to show which counters a
transcript, bridge-trimming, projection or storage change moves, and to
compare a change with an older commit.

The recurring-work harness (scheduling cadence and physical work per owner)
is separate; see
[testing-guide.md](testing-guide.md#recurring-work-harness).

## Running

```bash
# Current tree: writes output/efficiency/<run-id>/head.json
mise run efficiency:baseline

# An older commit, from its own worktree with dependencies installed there
git worktree add /tmp/eff-base <commit>
(cd /tmp/eff-base && mise exec -- bun install --frozen-lockfile)
mise run efficiency:baseline -- --root /tmp/eff-base --label base --run-id cmp

# The current tree against it, plus a compact before/after summary
mise run efficiency:baseline -- --label head --run-id cmp \
  --compare output/efficiency/cmp/base.json \
  --summary-out output/efficiency/cmp/summary.json
git worktree remove --force /tmp/eff-base
```

| Option | Effect |
| --- | --- |
| `--root <repo>` | Repository whose modules are imported (default: this checkout) |
| `--label <name>` | Report label (default `head`, or `baseline` for another root) |
| `--run-id <id>` | Output directory name (default: a timestamp) |
| `--workloads a,c,j` | Run only these workloads |
| `--repetitions <n>` | Repetitions per case (default 7) |
| `--out <file>` | Override the report path |
| `--compare <report>` | Print every deterministic counter that differs from a stored report |
| `--summary-out <file>` | With `--compare`, also write both runs' counters and warm p50 per case, without per-run detail |
| `--fail-on-change` | Exit 1 when any counter differs |

Reports go to `output/efficiency/`, which Git ignores. Path arguments resolve
against the directory the command was run from.

`tests/unit/efficiency/harness.test.ts` keeps the fixtures deterministic and
content-free, the comparison and delta accounting exact, and module loading
correct for current and historical layouts:

```bash
mise exec -- bun test tests/unit/efficiency/harness.test.ts
```

## Workloads

| ID | Workload | Main counters |
| --- | --- | --- |
| `a` | Unchanged transcript read, with and without a revision | Message serialization visits |
| `b` | Bridge trimming functions (Cursor, Pi, ACP) and the shared helper | Message and part visits, retained ids |
| `c` | Background Cursor stream with no reader | Retained parts and bytes, sampled peak |
| `d` | Display-tail storage: update one of many tails, and one cold read; checkpoint age of streaming and quiet tails (1 and 128 sessions, 5 and 50 ms writes) | Payload reads and writes, syscall KiB; scheduler writes and coalesced updates, write-pool concurrency, checkpoint age p50 and max |
| `e` | Bridge live window: v1 raw against v2 summary | Decoded and gzip bytes, messages retained, deferred detail bytes |
| `f` | Backend projection: changed read of a 100-message window | Projected-row serializations |
| `g` | Frontend accounting: tail update with 0, 1 and 8 MiB retained history | Message visits, accounted bytes |
| `h` | Codex rollout reads under soft and hard cache budgets, plus interrupted JSONL | Full parses, bytes read, retained estimate, degraded status |
| `i` | History paging: provider calls to load all earlier history | Provider calls by kind, messages returned |
| `j` | Whole-message delta stream for 40 observations of one changing message | Decoded upsert bytes, bytes repeated from the client's previous copy |
| `k` | Activity sweep over 1, 10 and 100 sessions, with the batch route and against an older bridge without it | Bridge requests by route, request and response bytes, sessions applied |
| `l` | Files panel tree cache: 20 reads under qualified watcher coverage (unchanged, a hint, a mutation) and under the age bound | Walks, walked nodes, cache hits, misses and joins, revisions |
| `m` | Progress probes and reviewer windows over 200 messages: unchanged, moved, and a provider without a snapshot surface | Reads by kind (`unchanged`, `snapshot`, `fallback`), provider calls, messages and bytes returned |
| `n` | Build-pipeline transcript checkpoints over 20 passes: unchanged, moving, and no snapshot surface | Probes by kind, whole reads, saves, transcript-store commits, chunk writes and bytes |
| `o` | History cursor coverage: 40 seeded sessions each of tool steps with short, mixed and large outputs over a v2 bridge stub, plus OpenCode steps with short outputs | Live views with a direct cursor, views whose byte bound dropped rows the provider sent, joined mints (whole transcript reads) and messages they returned |

## Method

- **Same code against any root.** Workloads import the selected root's
  modules, so one harness measures an older worktree and the current tree.
  Where an older root predates an API, a case either measures the path that
  root actually served (named in its description) or reports itself
  unsupported; nothing is emulated. Protocol modules resolve under
  `packages/protocol/src/node/` first and fall back to the older
  `packages/protocol/src/` path; an import failure is never hidden by falling
  back to this checkout.
- **Primary: deterministic counts.** Serialization visits are counted with a
  non-enumerable `toJSON`, so encodings stay byte-identical. Other counters:
  `JSON.stringify` calls on projected rows, provider calls and messages
  returned, record-store payload reads and writes, full rollout parses,
  decoded and gzip bytes, and retained parts and bytes. Counters come from
  the first repetition and are checked for equality across the rest; any that
  varied are listed in `unstableCounters`.
- **Syscall bytes** (workload `d`) are `/proc/self/io` `rchar`/`wchar` deltas
  around the awaited call, rounded to KiB. They are Linux-only and include
  backups and index files.
- **Checkpoint age** (workload `d`, `age-*` cases) runs the real
  `NativeAgentDisplayTailScheduler` with its default quiet period (2 s),
  maximum age (10 s) and write pool (2) on a virtual clock and timer queue,
  so the ages are exact and machine-independent. Sessions update on a fixed
  cadence and each write takes a fixed virtual time. Age is the virtual time
  from a key first becoming dirty to its write starting: how far a restart
  preview can lag. It is a scheduling bound, not a measured disk latency;
  the `records-*` cases give the real write cost.
- **Secondary: wall-clock.** `performance.now()` around the measured
  operation only. Repetition 0 is cold; p50 and p95 are over warm
  repetitions. Timings are machine-specific, never compared by `--compare`,
  and not a production speed-up claim.
- **Secondary: heap, RSS and event-loop lag** (`resources` on each case,
  `scripts/efficiency/resources.ts`). Each repetition forces a collection,
  samples `process.memoryUsage()` and timer lateness every 5 ms, and forces
  another collection when it ends. `coldRetainedHeapDeltaBytes` is the heap
  the cold repetition left reachable; `heapUsedPeakBytes` and `rssPeakBytes`
  are the largest samples over all repetitions; `eventLoopLag` is how late
  the 5 ms timer ticks fired (nearest-rank p50, p99, max). These describe the
  harness process running one function-level case, not a production backend
  or browser. Bun refreshes heap figures only at a collection, so the heap
  peak undercounts short-lived allocation; a case shorter than one interval
  that never blocks reports no lag samples. Like timings they are
  machine-specific, never compared by `--compare`, never part of
  `unstableCounters`, and left out of `--summary-out`. Heap bytes are not
  encoded JSON bytes or source-file bytes; never read one as the other.
- **Fixtures** come from a seed and a size (`fixtures.ts`): ASCII and
  multibyte prose, many short parts, 64 KiB tool results, 600-line diffs,
  192 KiB data-URL images, nested sub-agent activity, rewritten history,
  interrupted rollout JSONL, and a long immutable prefix with one changing
  tail. Nothing is read from a user profile; reports hold only integers, ids,
  digests and labels.
- **Ceilings** use the existing test overrides: 256 KiB bridge display
  ceilings for Cursor and Pi, ACP's configurable 1 MiB floor (it cannot go
  lower), and `setTranscriptCacheLimitsForTesting` for Codex cache budgets.

## Limitations

- Function-level only. Bridges are called in-process, not over HTTP; provider
  stubs answer with the same protocol helpers a bridge uses. For the activity
  sweep against real bridge processes over HTTP (latency p50, p95 and max for
  1, 10 and 100 sessions, Codex and Claude, with and without the batch route),
  run `bun scripts/activity-sweep-live.ts --codex <pinned codex binary>`; it
  sends no prompts.
- Counting via `toJSON` misses work done on copies the code makes
  (`{ ...message }`), so visit counts are lower bounds.
- The frontend workload reproduces the mounted hook's calls rather than
  rendering React. Workload `n` likewise reproduces the build supervisor's
  `refreshMovedTranscript` call for call instead of running the supervisor,
  and treats every pass as a persist boundary.
- Not measured: remote delivery through a proxy, constrained bandwidth,
  reconnects and slow clients; real providers, bridges and rollouts; browser
  long tasks, input latency, visibility latency and browser heap; heap, RSS
  and event-loop lag of a real backend or bridge under load (the `resources`
  figures cover only the harness process); workloads with several active
  review sessions. Those gaps
  are tracked in
  [0050-transcript-history-efficiency.md](../todo/transcripts-and-observation/0050-transcript-history-efficiency.md)
  and [0052-remote-client-bandwidth.md](../todo/transcripts-and-observation/0052-remote-client-bandwidth.md).
