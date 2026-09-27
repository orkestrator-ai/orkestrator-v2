# Multi Review efficiency baseline

Date: 2026-09-23

This records the step-01 control-plane baseline and the same measurements after
steps 02–09 were implemented on the `multi-review-efficiency` branch. It turns
the index's relative goals into absolute gates. All numbers come from fake
providers and synthetic reports: they measure control-plane work, not
production latency, model time, tokens or cost.

## How it was measured

Harness:
[`apps/backend/src/core/multi-review-efficiency.bench.test.ts`](../../../../apps/backend/src/core/multi-review-efficiency.bench.test.ts).
It counts only through the fake provider, the command invoker and storage spies,
so the identical file runs against the code before and after the change.

```bash
MULTI_REVIEW_BENCH_OUT=/tmp/multi-review-bench.json \
  mise run test:logged -- --name multi-review-bench -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/multi-review-efficiency.bench.test.ts --parallel=1
```

Add `MULTI_REVIEW_BENCH_REPORT_ONLY=1` to measure an older build without the
new assertions. The "before" column was produced by copying the harness into a
temporary worktree at the unmodified merge base and running it there.

| Field | Value |
| --- | --- |
| Before commit | `d680ccdb` (origin/main merged into the branch, no efficiency changes) |
| After | Working tree of this branch on top of `d680ccdb` |
| Host | Linux 7.2.5 x86_64, AMD Ryzen 5 PRO 5650U, 12 logical cores, 30 GiB |
| Runtime | Bun 1.4.2, warm module cache, desktop workload running concurrently |
| Iterations | 3 per build; timing columns report median / max |
| Provider timing | 20 ms session setup, 2 ms send, 1 ms status; one case with a 250 ms setup |
| Reports | Synthetic, 6 issues each, representative field lengths (`multi-review-efficiency-fixtures.ts`) |
| Evidence | One package declared at 64 MiB; bytes hashed = verifications × package bytes |
| Running phase | 10 supervision passes inside one 60 s progress-probe interval |

## Admission and evidence

| Case | Verifications | Evidence bytes hashed | Admission ms (median / max) | Dispatch skew ms (median / max) | Max concurrent setups |
| --- | --- | --- | --- | --- | --- |
| 1 reviewer | 2 → 2 | 128 → 128 MiB | 38 / 38 → 40 / 41 | 0 / 0 → 0 / 0 | 1 → 1 |
| 2 reviewers | 3 → 2 | 192 → 128 MiB | 62 / 63 → 33 / 33 | 31 / 31 → 1 / 1 | 1 → 2 |
| 4 reviewers | 5 → 2 | 320 → 128 MiB | 118 / 122 → 37 / 37 | 88 / 91 → 3 / 3 | 1 → 4 |
| 8 reviewers | 9 → 2 | 576 → 128 MiB | 238 / 241 → 80 / 82 | 208 / 210 → 44 / 47 | 1 → 4 |
| 32 reviewers | 33 → 2 | 2112 → 128 MiB | 965 / 966 → 283 / 284 | 934 / 936 → 248 / 249 | 1 → 4 |
| 8 reviewers, 2 providers | 9 → 2 | 576 → 128 MiB | 237 / 238 → 70 / 71 | 206 / 207 → 35 / 38 | 1 → 4 |
| 4 reviewers, one slow (250 ms) setup | 5 → 2 | 320 → 128 MiB | 353 / 354 → 262 / 262 | 88 / 90 → 229 / 230 | 1 → 4 |

Reading the slow-setup row: before, the slow reviewer was created first and
every later reviewer waited behind it. After, the other three are admitted and
dispatched while it is still being created, so total admission falls and the
skew is simply the slow reviewer finishing last.

## Running observation, persistence and consolidation

| Case | Status reads (10 passes) | Transcript reads (10 passes) | Saves per running pass | Workflow saves (whole run) | Backup rotations | Lease writes with backup | Consolidation prompt bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 reviewer | 10 → 10 | 10 → 0 | 1 → 1 | 22 → 22 | 25 → 23 | 2 → 0 | 23,532 → 23,911 |
| 2 reviewers | 20 → 20 | 20 → 0 | 2 → 1 | 37 → 26 | 40 → 27 | 2 → 0 | 42,000 → 40,087 |
| 4 reviewers | 40 → 40 | 40 → 0 | 4 → 1 | 67 → 34 | 70 → 35 | 2 → 0 | 78,936 → 72,441 |
| 8 reviewers | 80 → 80 | 80 → 0 | 8 → 1 | 127 → 50 | 130 → 51 | 2 → 0 | 152,808 → 137,149 |
| 32 reviewers | 320 → 320 | 320 → 0 | 32 → 1 | 487 → 146 | 490 → 147 | 2 → 0 | 596,355 → 525,713 |
| 8 reviewers, 2 providers | 80 → 80 | 80 → 0 | 8 → 1 | 127 → 50 | 130 → 51 | 2 → 0 | 152,776 → 137,145 |

The benchmark drives passes directly, so it counts work *per pass*. Status
reads per pass are unchanged by design — every running reviewer is still
observed on every pass. What changed is how often a pass runs:

| Supervision cadence | Before | After |
| --- | --- | --- |
| Running reviewers | Every 1 s, plus an immediate catch-up pass whenever a pass overran | 3 s after the previous pass *completed*, plus 0–1 s stable per-workflow jitter |
| Admission, dispatch journal, consolidation of results, cancellation | Every 1 s | 1 s after the previous pass completed |
| Discovery of workflows from storage | Full scan every 1 s | Full scan every 15 s; user actions wake a workflow immediately |

For a panel of running reviewers that is at least a 3× reduction in status,
interaction and fence reads per wall-clock minute, and no back-to-back passes
when a pass is slow (`multi-review-scheduler.test.ts`).

Consolidation input on this synthetic corpus shrank about 12% at 32 reviewers:
the repeated scope, validation and test fields are deduplicated, but most of a
report is reviewer-specific prose and findings, which are kept. The larger
effect is that the input is now bounded: 525,713 bytes at 32 reviewers is under
the 640 KiB evidence budget, and anything over it fails before dispatch.

## Gates

These are the absolute gates the later steps enforce. The benchmark and the
focused tests named here assert them.

| Dimension | Gate | Enforced by |
| --- | --- | --- |
| Evidence I/O | Exactly 2 verifications per generation (fan-out + consolidation), for 1–32 reviewers | bench, `multi-review-service.test.ts`, `build-pipeline-review-fanout.test.ts` |
| Transcript I/O | 0 provider transcript reads on a throttled pass; ≤ 1 progress read per live session per 60 s | bench, `review-fanout-efficiency.test.ts` |
| Persistence | ≤ 1 observational workflow write (and so ≤ 1 announcement) per pass, for any reviewer count | bench, `review-fanout-efficiency.test.ts` |
| Lease writes | 0 backup rotations for lease-only writes | bench, `storage-multi-review.test.ts` |
| Admission | Max concurrent setups = min(reviewers, admission cap 4); per-provider cap 4 | bench, `review-fanout-efficiency.test.ts` |
| Dispatch skew | Admission follows ceil(R / 4) setup waves (measured: 32 reviewers in 29% of the serial time) | bench (measured), slow-setup case asserted |
| Isolation | A retryable, ambiguous or slow reviewer does not delay its peers | `review-fanout-efficiency.test.ts`, bench slow case |
| Supervision | Running cadence ≥ 3 s from completion; no catch-up pass | `multi-review-scheduler.test.ts` |
| UI transcript | Unchanged polls carry 0 messages; snapshots ≤ 500 messages and ≤ 2 MiB | `multi-review-reviewer-transcript.test.ts`, `multi-review-service-efficiency.test.ts` |
| Reports | Each report ≤ 1 MiB, ≤ 100 issues, ≤ 16 KiB per prose field | `structured-review/budgets.test.ts` |
| Consolidation | Envelope ≤ 640 KiB with every source ID preserved; overflow fails before dispatch | `review-consolidation-evidence.test.ts` |

### Why these budget values

- **640 KiB consolidation evidence.** Roughly 160k tokens at four bytes per
  token, which leaves room for instructions and the output inside a 200k-token
  context. The 32-reviewer synthetic panel uses 82% of it.
- **1 MiB per report, 16 KiB per prose field, 100 issues.** Well above any
  report in the synthetic corpus (about 18 KiB with six issues), so they
  reject only runaway output. They apply only to answers received in the
  multi-reviewer fan-out, never to stored reports or other review features.
- **Admission cap 4, observation cap 8, per-provider cap 4, hard maximum 16.**
  Four overlapping setups remove most of the serial cost at 2–8 reviewers
  (the common panels) without launching a 32-process burst.
- **Running cadence 3 s.** Reviews take minutes; a 3 s cadence keeps the tab's
  status fresh while cutting provider traffic by at least two thirds.

## Rollout observations

No rollout has happened yet. Record each gated stage here as it is enabled:
the date, the observation window, the rates watched (retries, parked
dispatches, verification failures, legacy fallbacks, oversize reports,
transcript fallbacks) and the decision.
