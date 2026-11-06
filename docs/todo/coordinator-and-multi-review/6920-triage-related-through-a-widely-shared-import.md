# Failure triage calls a test related because it reaches a widely shared changed module

## Task analysis

Analysed 2026-11-05 against `main` at `e6c3da899`.

### Tasks

1. **Decide how far a changed import may be from a test before it alone makes the failure `related`**: today any depth counts. Status: open.

### 1. Decide how far a changed import may be from a test before it alone makes the failure `related`

**Problem.** `imports-changed-file` makes a failure `related` whenever the test's static import graph reaches a changed file, at any depth. Backend and CLI test graphs hold over a thousand files, so a branch that changes one widely shared module makes most of the repository's failures `related`, and Verify treats `related` as blocking. The verifier then has to argue each one away by hand, which is the cost to-do 6601 found for a doc comment.

**Context.** `classify` in `apps/backend/src/core/validation-failure-classifier.ts` takes `importClosure(...).changedHit`, the first changed file the breadth-first walk meets, and pushes `imports-changed-file` with the verdict `related`. `docs/architecture/review-preparation.md` settles that "a test that ... imports a changed file ... is `related`" and says nothing about depth, so this to-do does not change the rule; it records the evidence and the proposal. A change to the rule adds or changes a reason in `packages/protocol/src/validation-failure-triage.ts`, which is wide-reaching.

**Investigation.** Measured while closing 6601 with a scratch script that walks each test file's imports with `Bun.Transpiler.scanImports` and `Bun.resolveSync`, as the classifier does, but without preloads and without the classifier's budget. There are 3,151 test files outside `e2e/`. The number whose graph reaches each file:

| Changed file | Test files reaching it | Mostly in |
| --- | --- | --- |
| `packages/protocol/src/logger.ts` | 2,084 | 1,085 backend, 523 web, 297 bridges |
| `packages/protocol/src/validation-failure-triage.ts` | 1,585 | 961 backend, 466 web |
| `packages/protocol/src/web-annotations.ts` | 918 | 718 backend, 129 web |
| `apps/backend/src/core/storage.ts` | 808 | 786 backend |
| `apps/web/src/hooks/native-agent-live-head.ts` | 41 | 39 web |

The owners of to-do 4520's failures have graphs of 1,053 (`container-readiness.test.ts`), 1,107 (`packages/cli/tests/service-install.test.ts`), 1,252 (`commands-container-exec.test.ts`) and 1,255 (`coordinator-worker-turns.test.ts`) files, and each reaches `web-annotations.ts`, which they load for one constant through several layers. Replaying 4520's recorded failures through the shipped classifier against this checkout with 4520's changed files gave no `imports-changed-file` reason: those cases were the comment match alone, now fixed. Had that branch changed `web-annotations.ts` instead, all of them would be `related` by imports.

**Decisions.**

- **What makes a reached changed file enough for `related`?**
  - **Keep any depth (today).**
    - Pros: never under-reports a dependency; matches the document; no protocol change.
    - Cons: a branch touching a shared module blocks Verify on every unrelated failure until the verifier argues it away.
  - **Only a close import is `related`; a distant one is `undetermined` with a new reason such as `reaches-changed-file-indirectly` (recommended).** Close means the changed file is the test's or one of its helpers' direct import, or one hop further. Report the hop count beside `changedPath`.
    - Pros: removes the bulk of the over-match; a distant hit still reaches the verifier, never `unrelated`, so no regression is excused; cheap, since the walk already has the distances.
    - Cons: a protocol reason and a document change; the hop limit is a heuristic, and a real regression deep in a chain becomes the verifier's call instead of blocking outright.
  - **Use fan-in: when more than some share of all test files reach the changed file, imports alone make a failure `undetermined`.**
    - Pros: targets shared modules directly, whatever the depth.
    - Cons: needs the reverse graph of every test per triage (about 3 s here, against today's half second); the threshold is arbitrary; the same protocol change.
  - **Use the failure's stack frames: `related` only when a frame or message names a changed file.**
    - Pros: evidence about this failure rather than about the graph.
    - Cons: timeouts, the most common unrelated failure, carry no useful frames; Bun's frames usually name only the test file.

## Constraints and rationale

- A change here must never turn a reached changed file into `unrelated`: the verifier has to see it.
- Measure on a real recorded triage (a branch that changes a shared protocol module) before and after, as 6601 did with 4520's failures.

## Related

- [`docs/architecture/review-preparation.md`](../../architecture/review-preparation.md#failure-triage), the triage rules.
- [Flake case 6600](../../tests/flaky-tests/aggregate-validation-runs/6600-live-head-preparation-owners-vary-with-load.md), the run whose failures 6601 replayed.

## Replaces

- To-do 6601, "Failure triage calls a test related because a production comment names a changed directory". Its two tasks were done on 2026-11-05: `references-changed-path` now comes from the test and its own helpers, with comments ignored and only a changed file's full path counting from other modules; and an open flake-registry row is documented as context that never changes a verdict. This file carries its follow-up check of `imports-changed-file`.
