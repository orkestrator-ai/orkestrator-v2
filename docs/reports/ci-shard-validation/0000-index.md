# CI shard validation: outstanding work

What is left to do from the [CI shard validation follow-up](../2026-11-03-ci-shard-validation.md).

Analysed 2026-11-03 against `main` at `a2bba9d8`.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.
Work that is already built has no file; the status table below records it.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md) | Medium | No | The test now names its stalled step, and the stall's cause is removed locally: `runCommand` no longer depends on the Bun events that get lost (0 misses and 0 stalled children in 300 Linux and 175 macOS runs). CI evidence is still needed, which is all that is left. | An intermittent failure may still take down the gate until CI confirms the fix, with the shard itself working; a flake with a known owner rather than a shipped defect. |

## Parallel running

The full plan, with every lane across all four folders, is in [batches.md](../batches.md).

Batches in the same lane run one at a time, in the order shown. Batches in different lanes can run together unless **Not at the same time as** names the other one. A batch with no lane only has to respect that column.

This index only changes when a branch merges, so it can't show what is running now. Before starting a batch, check the running environments and open PRs for its lane and its **Not at the same time as** list. Put the batch ID in the environment and branch name so that check can find it.

### Files built on their own

These still follow the lane and conflict rules above.

| Batch | Name | Files | Lane and position | Finish first | Not at the same time as |
| --- | --- | --- | --- | --- | --- |
| CI-0010 | [Backend shard timeout](0010-backend-shard-diff-base-override-timeout.md) | `0010` | No lane | None | None |

## Status of every item

5 done, 1 open, 2 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| Shard scenarios in `tests/unit/test-all.test.ts` | Done | Merged in #1636 (`49ee7a15`); `tests/unit/test-all.test.ts:335` reads the real CI matrix. |
| Fresh three-shard `test:full` results on clean runners | Done | All shards and the gate passed on `a2827f52`, `74d0bbe1` and `a62359f6`; run links are in [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md). |
| Retain the run URL, tested SHA and shard results | Done | Recorded under Current state in [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md), including the red PR run at `142f846d`. |
| Separate failures in the preparation's default suite | No action | The report makes no claim and asks for no repair. Those failures did not recur in the green runs above. |
| Separate failures in the preparation's browser suite | No action | The report names no failure and CI's shards do not run that suite, so the current state was not determined here. |
| Stable green on later runs (not a report item; found while checking) | Open | `a2bba9d8` is red on one test. The local cause is removed, and CI evidence is still needed: [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md). |

| `bounded test diagnostics` failing `main` since #1709 | Done | Incoming branch rewrote five files; recorded in [2922](../../todo/cross-cutting/2922-full-and-isolated-suite-failures-on-main.md). |
| Diff-base override deadline miss | Done locally | File capture supersedes the incoming 5 s pipe-close bound; case [1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md). CI confirmation remains open above. |

The incoming follow-up [0020](0020-git-output-lost-after-exit.md) records the
remaining trigger investigation and the limits of the retarget guarantee.
