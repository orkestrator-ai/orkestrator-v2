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
| 1 | [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md) | Medium | No | The one test still turning the backend shard red: find the stall, then fix it. | An intermittent failure that takes down the gate in about one `main` run in ten, with the shard itself working; a flake with a known owner rather than a shipped defect. |

## Status of every item

3 done, 1 open, 2 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| Shard scenarios in `tests/unit/test-all.test.ts` | Done | Merged in #1636 (`49ee7a15`); `tests/unit/test-all.test.ts:335` reads the real CI matrix. |
| Fresh three-shard `test:full` results on clean runners | Done | All shards and the gate passed on `a2827f52`, `74d0bbe1` and `a62359f6`; run links are in [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md). |
| Retain the run URL, tested SHA and shard results | Done | Recorded under Current state in [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md), including the red PR run at `142f846d`. |
| Separate failures in the preparation's default suite | No action | The report makes no claim and asks for no repair. Those failures did not recur in the green runs above; the DOM-assertion scanner stays with todo 2922. |
| Separate failures in the preparation's browser suite | No action | The report names no failure and CI's shards do not run that suite, so the current state was not determined here. |
| Stable green on later runs (not a report item; found while checking) | Open | `a2bba9d8` is red on one test: [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md). |
