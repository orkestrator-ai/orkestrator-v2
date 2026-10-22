# mise-task document scan races a temporary protocol root (2026-09-12)

- **ID:** 0001
- **Status:** resolved
- **Original command:** `mise run test`, using the default worker plan (root group
  ran with four workers).
- **Test:** `mise task surface > every workspace script a document names is
  declared by that workspace`, in `tests/unit/mise-tasks.test.ts`.
- **Failure:** `ENOENT: no such file or directory, open
  '.../tests/unit/.protocol-write-root-QON4zO/generated/README.md'` while the
  test iterated markdown files (13.33 ms).
- **Suite counts:** root and agent-support group 4,171 passed, 3 skipped, 1
  failed across 193 files. The same aggregate run also reported the pre-existing
  `agent provider module boundaries` failure for the unmodified
  `opencode-provider.ts` (1,534 lines against a 1,500-line limit).
- **Isolated rerun:** `mise run test:logged -- --name mise-task-surface -- bun
  test ./tests/unit/mise-tasks.test.ts --parallel=1 --only-failures` → passed in
  0.2 s.
- **Hypothesis:** the document scan walks `tests/unit`, where a sibling protocol
  test creates and removes a `.protocol-write-root-*` directory during the same
  parallel run; the scan lists a file inside it and then reads after the owner
  removes the directory.
- **Root cause:** `tests/unit/codex-app-server-protocol.test.ts` created fixtures
  with `mkdtemp(join(import.meta.dir, prefix))`, so `.protocol-*` directories
  lived inside `tests/unit` and were visible to the markdown walk, oxfmt, oxlint,
  and git status.
- **Fix:** protocol fixtures now use `os.tmpdir()`. The document scan also skips
  dot-directories, so leftover in-tree `.protocol-*` dirs from older runs are
  not walked.
- **Verification:** owning files passed alone, then
  `codex-app-server-protocol.test.ts` and `mise-tasks.test.ts` passed together
  five times at `--parallel=2`.
