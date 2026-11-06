# Move codemod rewrites paths that name a historical commit

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab7`.

### Tasks

1. **Leave `<revision>:<path>` strings alone in `scripts/move-backend-modules.ts`**: the path-string rewrite should skip a path that is part of a Git revision expression. Status: open.

### 1. Leave `<revision>:<path>` strings alone

**Problem.** The domain-folder codemod (todo
[0012](0012-backend-core-domain-folders.md)) rewrites every
`core/<old file>` path string in tracked text files, including ones that name
a file at an older commit, such as
`` `ff4026b4e^:apps/backend/src/core/http-bridge-catalog.ts:72-110` `` in a
bridge test comment or `git show 0d254a3a^:apps/backend/src/core/http-bridge-provider.ts`
in a flake record. At that commit the file had the old name, so the rewritten
reference points at nothing and the `git show` command fails. Each slice has
to find and revert these by hand.

**Context.** `pathStringRewrites` in `scripts/move-backend-modules.ts`
builds one regular expression per moved file, anchored only on
`(?<![\w-])` and `(?![\w-])`, so `<sha>^:apps/…` matches like any other
path. The `http-bridge` slice (2026-11-06) hit eight such strings: seven in
`bridges/acp-bridge/src/acp-http.test.ts`,
`bridges/codex-bridge/src/index-routes.test.ts`,
`bridges/cursor-bridge/src/http.test.ts` and
`bridges/pi-bridge/src/http.test.ts`, and one in
`docs/tests/flaky-tests/aggregate-validation-runs/0255-backend-fixtures-launch-defaults-validation.md`.
The `opencode` and `web-annotations` slices are likely to hit more, because
bridge tests cite the backend's pre-#827 sources this way.

**Investigation.** The revision form is always a revision token
(a hex SHA, optionally followed by `^`, `~N` or `^N`, or a ref name) followed by
`:` directly before the path, and `tests/unit/move-backend-modules.test.ts`
already runs the codemod against a temporary repository, so a case for it
fits there. Not changed in the `http-bridge` slice because that slice is a
pure move.

**Decisions.**

- **How should the codemod treat a revision path?**
  - **Skip a match whose path is preceded by `<revision>:` (recommended).**
    - Pros: the reference stays correct with no hand fix; one negative
      look-behind plus a test case.
    - Cons: a look-behind for a revision token is approximate (a ref name
      such as `main:` would need its own alternative); a path after an
      unrelated `word:` (for example `see:apps/…`) would also be skipped.
  - **Report revision paths in the dry run and leave them to the operator.**
    - Pros: no risk of skipping a path that should move.
    - Cons: still a manual step every slice, which is what this file removes.
  - **Leave the codemod as it is and keep the hand step in 0012's procedure.**
    - Pros: no code change.
    - Cons: easy to miss; a missed one silently breaks a reference.

## Related

- [0012](0012-backend-core-domain-folders.md) procedure step 2, which
  describes the hand step until this is done.
