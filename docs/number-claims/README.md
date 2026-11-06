# Number claims

To-do files (`docs/todo/`) and flake cases (`docs/tests/flaky-tests/`) are
numbered across all their folders. Two branches cut from the same `main` can
both take "the next number" for files in different folders, and each passes
its own checks. This folder turns that clash into a Git conflict, so the
second pull request cannot merge until it renumbers.

Each file here is named by one number and holds one line: the path of the
file that owns the number, relative to its register.

| Folder | Register | Claims required from |
| --- | --- | --- |
| `todo/` | `docs/todo/` | 7500 |
| `flaky-tests/` | `docs/tests/flaky-tests/` | 9800 |

When you add `docs/todo/<area>/7550-slug.md`, also add `todo/7550` containing
`<area>/7550-slug.md`. A new flake case gets a claim under `flaky-tests/` in
the same way.

- **Why it works.** Two branches that take the same number both add the same
  claim path with different contents. Git reports an add/add conflict, GitHub
  marks the later pull request as conflicting, and it cannot merge until it is
  rebased. Different numbers touch different paths and never conflict.
- **On a conflict here**, keep the claim already on the base branch: that
  number is taken. Renumber your file to the next number after the highest in
  use (files and claims), update its index row and every link to it, and add
  the claim for the new number.
- **A claim is permanent.** When its file is deleted or renumbered the claim
  stays, so the number is never reused.
- `tests/unit/number-claims.test.ts` fails when a file at or above the
  threshold has no claim, or when a claim names a different file. Tests read
  these files, so a conflict here is not a documentation-only conflict: run
  that test, `tests/unit/todo-index.test.ts` and
  `tests/unit/flaky-tests-index.test.ts` on the resolved result.
