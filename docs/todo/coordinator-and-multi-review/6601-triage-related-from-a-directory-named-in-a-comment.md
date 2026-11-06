# Failure triage calls a test related because a production comment names a changed directory

## Task analysis

Analysed 2026-11-05 against `main` at `41f9eb638`.

### Tasks

1. **Stop a directory named anywhere in the import closure making a test related**: `references-changed-path` should come from the test and its helpers, as the architecture document says. Status: open.
2. **Decide what an open flake-registry row does to a verdict**: the document says it makes a failure `unrelated`; the classifier does not. Status: open.

### 1. Stop a directory named anywhere in the import closure making a test related

**Problem.** Any branch that changes a file under `apps/web` has nearly every backend and CLI failure triaged `related`, and a `related` failure blocks a pipeline's verification unless a later commit repairs it. On the branch for to-do 4520, which changed only `apps/web/src/hooks/` and documents, 17 backend and CLI failures were `related` with `changedPath: apps/web/src/hooks/native-agent-live-head.test.ts`. No such test can load that file.

**Context.** `classify` in `apps/backend/src/core/validation-failure-classifier.ts` calls `referencedChange(closure.files)`, and the closure is the test's whole static import graph, over 1,000 files for these tests. `pathTokens` adds every parent directory of a changed file down to two segments, so `apps/web` is a token. `docs/architecture/review-preparation.md` describes something narrower: a test "whose test or helper files name a changed path or a changed directory".

**Investigation.** The match is a doc comment, `packages/protocol/src/web-annotations.ts:346`: "for example `apps/web`;". A static walk of the eight owning test files found that each closure imports no changed file, and that this comment is the only directory reference in each. `changedPath` then names the first changed file under the directory, which makes the verdict read as though the test referred to that file. The existing test, "a test that names a changed path is related" in `validation-failure-classifier.test.ts`, uses a literal in the test file itself, so it does not pin the wider behaviour.

It recurred on 2026-11-06 for a different directory. The to-do 6602 branch changed only `packages/cli/tests/service-install.test.ts`, one e2e spec, its fixture host and documents. Five backend failures were triaged `related` with `changedPath: packages/cli/tests/service-install.test.ts`. No module imports that test file. Doc comments naming `packages/cli` exist in `packages/protocol/src/public-api.ts`, `public-api-cli.ts`, `node/build-commit.ts` and `apps/backend/src/core/bridge-runtime-install.ts`. Flake case 6880 records it.

**Decisions.**

- **Which files may name a changed path?**
  - **Only the test file and test helpers, as the document says (recommended).**
    - Pros: matches the documented rule; removes this whole class, including string literals in production modules; reads far fewer files.
    - Cons: a production module that reads a changed directory at run time is no longer caught this way, so such a failure needs another source of evidence; "helper" needs a definition, such as `tests/` folders and `*test-support*` files.
  - **Keep the whole closure but ignore comments.**
    - Pros: small change; keeps production string literals as evidence.
    - Cons: needs comment stripping in a string-matching pass; a production literal such as a worktree-watch path still makes unrelated tests `related`.

### 2. Decide what an open flake-registry row does to a verdict

**Problem.** `review-preparation.md` says an open row in the flake registry naming a test makes it `unrelated`. In the recorded triage for 4520, `hook writers serialize counters and retain a completed turn without any config` has the reasons `known-flaky` and `references-changed-path` and the verdict `related`, and `a sweep's lock > a capture's write finishes while a long sweep is still walking` has `known-flaky` and `test-file-unknown` and the verdict `undetermined`.

**Context.** `classify` pushes `known-flaky` but its verdict chain never reads it: `passed-on-retry` gives `unrelated`, the three change reasons give `related`, `no-changed-dependency` gives `unrelated`, and everything else is `undetermined`.

**Investigation.** Read from the code and the recorded package only. Whether the document or the code is the intended behaviour was not established; the git history of the rule was not searched.

**Decisions.**

- **Which one changes?**
  - **Correct the document, and keep `known-flaky` as information (recommended).**
    - Pros: a registry row cannot excuse a real regression in code the branch changed; no verdict changes.
    - Cons: known flakes in untouched files keep reaching the verifier as `undetermined`.
  - **Make the classifier follow the document.**
    - Pros: fewer known flakes reach the verifier.
    - Cons: adding a row would silence a failure even on a branch that broke that test; it would need an exception for changed code.

## Related

- [Flake case 6600](../../tests/flaky-tests/aggregate-validation-runs/6600-live-head-preparation-owners-vary-with-load.md), the run this was found in.
