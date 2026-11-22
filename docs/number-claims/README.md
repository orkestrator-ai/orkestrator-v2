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

Pick the number with `mise run number:next -- todo` (or `-- flaky-tests`). It
prints a number above every one in use in your checkout and in the claims on
every branch origin has (it fetches first), plus a random step of 1 to 10, so
two branches cut from the same `main` rarely take the same one. The claims
below still catch the rare clash that remains.

When you add `docs/todo/<area>/7550-slug.md`, also add `todo/7550` containing
`<area>/7550-slug.md`. A new flake case gets a claim under `flaky-tests/` in
the same way.

- **Why it works.** Two branches that take the same number both add the same
  claim path with different contents. Git reports an add/add conflict, GitHub
  marks the later pull request as conflicting, and it cannot merge until it is
  rebased. Different numbers touch different paths and never conflict.
- **On a conflict here**, keep the claim already on the base branch: that
  number is taken. Renumber your file to the number `mise run number:next`
  prints (above the highest in use, files and claims), update its index row
  and every link to it, and add the claim for the new number.
- **On a move or slug rename**, keep the number and update the existing claim
  body to the new register-relative path in the same change. An absent owner
  may also mean a retired number: update the claim only for the same case or
  to-do, never to reuse its number for a different one.
- **A claim is permanent.** When its file is deleted or renumbered the claim
  stays, so the number is never reused.
- `tests/unit/number-claims.test.ts` fails when a file at or above the
  threshold has no claim, or when a claim names a different file. Tests read
  these files, so a conflict here is not a documentation-only conflict: run
  that test, `tests/unit/todo-index.test.ts` and
  `tests/unit/flaky-tests-index.test.ts` on the resolved result.
