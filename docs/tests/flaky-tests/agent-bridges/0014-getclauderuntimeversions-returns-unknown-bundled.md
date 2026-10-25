# `getClaudeRuntimeVersions > returns unknown bundled versions when the SDK manifest cannot be read` (`bridges/claude-bridge/src/services/session-manager-core.test.ts`)

- **ID:** 0014
- **Status:** open
- **Date observed:** 2026-09-06
- **Original command:** `bun test bridges/claude-bridge` — a *sequential* run
  with no `--parallel`, so no `--isolate` and one shared module registry across
  all 27 files.
- **Worker configuration:** single worker, no isolation.
- **Failure:** reported as failing at 0.42 ms, with no assertion detail in the
  captured output.
- **Suite counts:** not recorded — the sequential run was cancelled at its
  600 s budget before it printed a summary, which is itself the reason not to
  invoke the suite this way.
- **Isolated rerun:** `bun test
  bridges/claude-bridge/src/services/session-manager-core.test.ts -t "unknown
  bundled versions"` -> 2 passed, 0 failed in 0.30 s. The same suite under
  `bun test bridges/claude-bridge --parallel=4 --only-failures` -> 793 passed,
  0 failed in 7.68 s.
- **Hypothesis:** module-registry leakage rather than a race. The test asserts
  the *failure* branch of reading the SDK manifest, which it reaches by mocking
  the read; `--parallel` implies `--isolate`, so under the repository's own
  invocation each file gets a fresh registry and the mock cannot be pre-empted
  by a sibling that already resolved the real manifest. Sequential runs share
  one registry and do not have that guarantee. Not reproduced under any
  documented invocation, so this is recorded rather than acted on — see the
  `mock.module()` rules in `AGENTS.md`.
