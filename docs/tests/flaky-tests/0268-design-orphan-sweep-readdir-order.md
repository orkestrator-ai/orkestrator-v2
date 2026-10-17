# Design orphan sweep unreadable-owner listing order

- **ID:** 0268
- **Test:** `design lifecycle: tombstones, restore, purge, duplicate and fencing >
  the orphan sweep keeps a canvas with an unreadable owner`
  (`apps/backend/src/core/design/lifecycle.test.ts:555`)
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Original command:** GitHub Actions run 38820059736 (`pull_request`,
  branch `approval-modes-bd174765c904-r1`, head `edd45c97`), job "Unit and
  integration tests"; `@orkestrator/backend:test:workspace` ran
  `bun test --preload ../../tests/setup-node.ts src tests --only-failures --parallel=${ORKESTRATOR_TEST_WORKERS:-2}`.
- **Worker configuration:** backend used two parallel Bun workers inside the
  workspace group, alongside the bridges, protocol and root groups.
- **Failure:** `expect(await canvasFiles(canvasId)).toEqual(before)` failed
  only on order, at 35.01 ms. Expected
  `["<id>.orkrec", "history/<id>", "history/<id>/<file>.json"]`, received
  `["<id>.orkrec", "history/<id>/<file>.json", "history/<id>"]`. The same
  three paths appeared on both sides.
- **Suite counts:** backend 8,074 passed, 42 skipped, 1 failed across 8,117
  tests in 438 files (518.14 s).
- **Isolated rerun:** the unchanged file, filtered with
  `-t "orphan sweep keeps" --rerun-each 20` (from `apps/backend`), passed
  40 of 40 on macOS.
- **Root cause:** the test's `canvasFiles` helper returned
  `readdir(..., { recursive: true })` unsorted. Bun's async recursive
  `readdir` lists subdirectories on concurrent tasks and appends each
  directory's entries when its task finishes. Entry order is therefore not
  stable between calls, and a child can come before its parent. This
  standalone probe shows it with Bun 1.4.2 on macOS, using 20 directories
  `dN/eN/f.json` and 500 calls: 500 distinct orders. In 2,000 calls,
  `dN/eN/f.json` came before `dN/eN` 17 times. The sweep did not change the
  canvas, because both snapshots held the same paths. This is a test artefact,
  not a production mutation.
- **Fix:** this branch. `canvasFiles` sorts the filtered paths
  (`.toSorted()`), so the helper compares the set of files, not the traversal
  order. Every assertion is unchanged: the exact file list before and after
  the sweep, and `[]` after removal. No production code changed.
- **Verification:**
  - `bun test --preload ../../tests/setup-node.ts ./src/core/design/lifecycle.test.ts --rerun-each 50`
    → 1,050 pass, 0 fail (48.7 s).
  - CPU stress: 18 `yes` burners on 18 cores, with `--rerun-each 20`, alongside
    the 0205 runs → 420 pass, 0 fail.
  - `oxfmt --check`, `oxlint` and `tsc --noEmit -p tsconfig.json` /
    `tsconfig.test.json` in `apps/backend` passed.
