# Efficiency baseline

Status: Living — step 01 baseline and method; later steps re-run it.

This directory holds the deterministic before/after measurements produced by
the function-level harness in
[`scripts/efficiency/`](../../../../scripts/efficiency/run.ts). See
[step 01](../plan/01-baselines-and-instrumentation.md) for the plan,
[the findings](../transcripts.md) for E01–E09 and
[frontend and workflows](../frontend-and-workflows.md) for E10–E14. The review's
original probes are in [validation.md](../validation.md); this harness
reproduces them exactly at the baseline commit.

## Files

| File | Contents |
| --- | --- |
| `step-01-summary.json` | Both runs side by side: every workload's fixture dimensions and method, each case's counters at the baseline and at the candidate, and the warm p50 per case. Generated with `--summary-out`; small enough to commit. |

Full per-run reports (all repetitions' timing percentiles and metadata) go to
`output/efficiency/<run-id>/<label>.json`, which is ignored by Git.

## How to run

```bash
# Current tree: writes output/efficiency/<run-id>/head.json
mise run efficiency:baseline

# The review baseline from a separate worktree (dependencies installed there)
git worktree add /tmp/eff-baseline-e8fbf1d0 e8fbf1d0
(cd /tmp/eff-baseline-e8fbf1d0 && mise exec -- bun install --frozen-lockfile)
mise run efficiency:baseline -- --root /tmp/eff-baseline-e8fbf1d0 \
  --label baseline-e8fbf1d0 --run-id step-01

# Compare the current tree with it and regenerate the committed summary
mise run efficiency:baseline -- --label head --run-id step-01 \
  --compare output/efficiency/step-01/baseline-e8fbf1d0.json \
  --summary-out docs/improvements/efficiency/baseline/step-01-summary.json
git worktree remove --force /tmp/eff-baseline-e8fbf1d0
```

Other options: `--workloads a,c,j` selects workloads, `--repetitions n`
(default 7) sets repetitions, `--out` overrides the report path, and
`--fail-on-change` makes any counter difference exit 1. A full run takes about
a minute and needs no provider, network, Docker or profile.
`tests/unit/efficiency/harness.test.ts` keeps the fixtures deterministic and
content-free and the delta accounting exact.

## Method

The harness imports the real exported functions of the repository root it is
pointed at (`--root`), so the same workload code measures the baseline
worktree and the current tree. Where the baseline predates an API, a case
either measures the path the baseline actually served (named in its
description) or reports itself unsupported; nothing is emulated.

- **Primary: deterministic operation counts.** Message and part
  serialization visits (a non-enumerable `toJSON`, the method the review's
  probes used; encodings stay byte-identical), `JSON.stringify` calls on
  projected rows, provider calls and messages returned, record-store payload
  reads/writes, full rollout parses, decoded and gzip bytes, and retained
  parts/bytes. Each case runs 7 times (3 for the storage, rollout and step-14
  cases); counters come from the first run and are checked for equality across
  the others, and any that varied are listed as `unstableCounters`. In
  `step-01-summary.json` only the baseline's 128-record cold-read KiB varied
  (syscall-byte noise at a KiB rounding boundary); every count was stable.
- **Syscall bytes** (display-tail storage) are `/proc/self/io` `rchar`/`wchar`
  deltas around the awaited call, reported in rounded KiB because the process
  reads a few dozen bytes lazily. They include backups and index files.
- **Secondary: wall-clock.** `performance.now()` around the measured
  operation only (fixture setup excluded). Repetition 0 is cold; p50/p95 are
  over the warm repetitions. These are machine-specific, never compared by
  `--compare`, and not a production speed-up claim.
- **Fixtures** are generated from a seed and a size (`fixtures.ts`): ASCII and
  multibyte prose, many short parts, 64 KiB tool results, 600-line diffs,
  192 KiB data-URL images, nested sub-agent activity, a rewritten history,
  interrupted rollout JSONL, and a long immutable prefix with one changing
  tail. Nothing is read from a user profile; reports hold only integers, ids
  digests and labels.
- **Ceilings.** The bridge display ceilings use the existing testable
  overrides the review's probes used: 256 KiB for Cursor and Pi, and ACP's
  configurable floor of 1 MiB (it cannot be lowered to 256 KiB). Codex cache
  budgets use `setTranscriptCacheLimitsForTesting`, as the step-10 tests do.

Run on 2026-09-27: **AMD Ryzen 5 PRO 5650U, 12 logical CPUs, 30.7 GiB RAM**,
Linux x64, Bun 1.4.2. Baseline `e8fbf1d0cf60`; candidate `d8796c28972d` plus
this step's metric-only instrumentation. Other agents were running tests on
the machine, so timings are noisy.

## Before and after by finding

Counts are exact. "p50" is warm wall-clock on the machine above.

| Finding | Workload (case) | Baseline `e8fbf1d0` | Candidate `d8796c28` | Minimum evidence (step 19) |
| --- | --- | --- | --- | --- |
| E01 | `c` Cursor, 600 × 1 KiB reasoning blocks, no reader | 600 parts / 712,206 B retained | 378 parts / 448,802 B; sampled peak 440 parts / 473,621 B (≤ 512 parts; ≤ 256 KiB + 256 KiB interval + one update) | Met at function level |
| E01 | same, after one read-side bound | 220 parts / 261,256 B | 220 parts / 261,256 B | Parity |
| E02 | — | Not measured | Not measured | Durability is covered by the step-04 functional tests, not by counts |
| E03 | `a` Claude route, unchanged read, 1,000 × 8 KiB | 1,000 message visits (p50 57.4 ms) | 0 visits (p50 1.2 ms); v2 summary query also 0 | Met |
| E03 | `a` same, 100 messages | 100 visits | 0 visits | Met |
| E03 | `a` generic helper without a revision (legacy fallback) | 1,000 / 100 visits | 1,000 / 100 visits (unchanged by design) | — |
| E04 | `d` 128 persisted tails: update one | 16,734 KiB read, 11,155 KiB written, 128 payloads parsed and rewritten (p50 32.3 ms) | 8 KiB read, 86 KiB written, 0 payload reads, 1 payload write (p50 1.9 ms) | Met (update/read) |
| E04 | `d` 128 tails: cold read one | 5,578 KiB read, 128 payloads | 43 KiB read, 1 payload | Met |
| E04 | `d` 32 / 1 tails: update one | 4,183 / 131 KiB read; 2,788 / 87 KiB written | 8 / 8 KiB read; 54 / 43 KiB written | The index write still grows with record count (43 → 86 KiB) |
| E05 | `f` backend changed read, 100-message window, one tail change | 400 projected-row serializations | 100 | Changed-only processing met; see step 14 below |
| E05 | `j` step-14 delta stream | See the step-14 decision | Identical on both: the whole-message delta path is unchanged | Decision recorded |
| E06 | `e` live window, 100 messages with 10 × 64 KiB tool results, 2 images, 3 diffs | v1: 517,504 B decoded / 237,900 B gzip; 27 of 100 messages retained | v2 summary: 219,127 B / 34,710 B gzip; 100 of 100 retained; 15 detail references deferring 1,346,932 B | Met at function level |
| E07 | `i` load all earlier history (250 messages, pages of 60) | Joined path: 5 provider calls (4 `interactiveSnapshot`), 1,100 messages returned by the provider | Direct pages: 4 calls (1 summary + 3 `transcriptPage`), 0 `interactiveSnapshot`, 250 messages returned. A v1 provider on the candidate still takes the joined path (5 calls / 1,100) | Met for v2 providers; v1 fallback cost documented |
| E08 | `h` one rollout above the hard cap, 20 tail reads | 20 full parses, 5,302,120 B read, cache self-evicted (0 retained) (p50 11.8 ms) | 1 cold scan, 265,106 B read, 55,872 B estimated retained ≤ 64 KiB cap (p50 1.6 ms) | Met |
| E08 | `h` small rollout / working set above the soft cap | 1 / 2 full parses | 1 / 2 cold scans | Parity. Retained estimates are not comparable: the baseline counted source bytes, the candidate estimates heap (3× source) |
| E08 | `h` interrupted JSONL (1 corrupt record, unterminated tail) | 62 records, loss not reported | 62 records, 1 unreadable marker, status `degraded` | Explicit degradation |
| E09 | `b` 100 × 8 KiB at 256 KiB, Cursor / Pi | 4,585 message visits (p50 38.3 / 33.0 ms) | 100 (p50 2.3 / 1.1 ms) | Met; retained ids identical |
| E09 | `b` ACP 100 × 16 KiB at 1 MiB | 3,097 message visits | 100 | Met; retained ids identical |
| E09 | `b` one message × 400 parts at 256 KiB, Cursor / Pi | 51,197 part + 159 message visits | 800 part + 1 message visits | Met; retained part ids identical |
| E09 | `b` ACP one message × 480 × 4 KiB at 1 MiB | 83,335 part + 228 message visits (p50 364 ms) | 960 part + 1 message visits (p50 7.5 ms) | Met |
| E09 | `b` shared helper, same inputs | 100 message / 800 part visits | Same | Reference |
| E10 | `g` tail update with 0 / 1 / 8 MiB retained history | 100 / 612 / 4,196 message visits (8 MiB p50 21.2 ms) | 1 / 1 / 1 (8 MiB p50 0.09 ms); accounted bytes exact | Met at function level |
| E11 | — | Not measured | Not measured | Needs browser visibility and hidden-tab runs |
| E12 | — | Not measured | Not measured | Step 18 has its own cache tests; no workload here |
| E13 | — | Not measured | Not measured | Step 15 not implemented |
| E14 | — | Not measured | Not measured | Step 16 not implemented |

### Not measured here

- Remote delivery through the supported proxy, constrained bandwidth,
  reconnects and slow clients (step 19's remote rows).
- Real providers, bridges over HTTP, and real rollouts or transcripts.
- Browser long tasks, input latency, and first/current-update visibility
  latency (needs the isolated profile and Playwright).
- Peak heap/RSS and event-loop lag; the harness reports counts and retained
  estimates only.
- Review/pipeline workloads with several active sessions (steps 15/16).

## Step 14 gate: repeated part content in whole-message deltas

Workload `j` drives the real `getTranscriptUpdate` over an in-memory provider
that answers with the v2 summary helpers (v1 raw at the baseline), for 40
observations of one changing assistant message after a 20-message prefix. A
client applies each delta; decoded bytes are the UTF-8 JSON of
`messageUpserts`. The gate metric is the fraction of those bytes that are
top-level parts byte-identical to the client's previous copy of the same part.

| Workload | Decoded upsert bytes | Identical-part bytes (fraction) | Any repeated content (fraction) |
| --- | --- | --- | --- |
| Growing prose: one text part +256 B per observation | 446,320 | 0 (0.000) | 0.941 — the grown part's old prefix and the `content` mirror |
| 30 completed tool parts + one growing text part | 704,320 | 256,800 (0.365) | 0.961 |
| Tool-heavy turn: 20 completed tools, one more completes per observation | 352,760 | 338,500 (**0.960**) | 0.960 |
| Sub-agent gaining one completed action per observation | 237,645 | 25,440 (0.107) | 0.886 — identical nested children |

Decision: **Prototype warranted** (recorded in
[step 14](../plan/14-part-level-deltas.md)). The numbers are identical at the
baseline and the candidate: steps 08–13 did not change what a whole-message
delta carries. The backend already defers tool bodies behind detail
references, so absolute per-delta sizes are small (about 8.8 KB per tool-turn
delta); the bridge-to-backend hop is not included.

## Limitations

- Function-level only: bridges are called in-process, not over HTTP; the
  provider stubs answer with the same protocol helpers a bridge uses.
- Serialization counting via `toJSON` undercounts work done on copies the code
  under test makes (`{ ...message }`), so visit counts are lower bounds.
- The baseline display-tail payload counts are derived (the shared file is
  parsed and rewritten whole); the candidate's come from
  `KeyedRecordStore.stats()`.
- The frontend workload reproduces the mounted hook's per-install calls
  (history measurement, then `setProjection`) rather than rendering React.
