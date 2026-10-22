# `container runtime environment wiring > Codex configuration copy helpers reject destination root, parent, and file symlinks` (`tests/unit/runtime-env-wiring.test.ts`)

- **ID:** 0103
- **Status:** resolved
- **Date observed:** 2026-08-05
- **Original command:** `bun test tests --parallel`
- **Failure:** `expect(received).toEndWith(expected)` for one of three shell invocations that all printed the same `continued` marker
- **Reproduction:** the exact test passed 40 of 40 isolated repetitions, so the precise environmental trigger was not reproduced
- **Root cause:** not conclusively established. The assertion was unnecessarily coupled to the marker being the final stdout bytes and did not identify whether the destination root, parent, or leaf symlink case failed.
- **Fix:** each invocation now prints a distinct `root-continued`, `parent-continued`, or `leaf-continued` marker and asserts that stdout contains it. This preserves the safety assertion — control returns after the unsafe copy is refused — while making any recurrence diagnostic.
- **Verification:** 50 of 50 repeated runs passed; the complete file passed 31 tests with 235 assertions.
