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

## Investigation (2026-11-15) — left open

Not fixed; the cause is narrowed but not proven as the recorded failure.

- The package script runs `bun test ... --parallel=1`, which isolates each file. The
  test passes there and in the isolated rerun. A two-file non-isolated run
  (`bun test ./src/services/session-manager-runtime-regressions.test.ts
  ./src/services/session-manager-core.test.ts -t "unknown bundled|reports the bundled"
  --preload ../../tests/setup-node.ts`) also passed, so the recorded sequential
  failure was **not reproduced**.
- Supporting the module-registry hypothesis: re-running this file inside one
  process (`bun test ./src/services/session-manager-core.test.ts -t
  "getClaudeRuntimeVersions" --preload ../../tests/setup-node.ts --rerun-each=5`)
  fails the three mock-dependent cases on every repeat after the first, in 0.2 to
  12 ms (this case, the malformed-manifest case and `parses the managed CLI
  --version output when configured`): the repeated file
  re-installs `mock.module` doubles with new mock functions, while
  `session-manager-interactions.ts` keeps the first run's `readFile` and
  `execFile` bindings. That is the same sub-millisecond, detail-free signature as the
  recorded failure, but it is a different invocation and the cause for the original
  one remains unobserved.
- No code was changed. A fix would be to make the `session-manager-test-mocks.ts`
  doubles survive re-evaluation, a shared-harness change affecting every
  session-manager suite, which was out of scope here. Run this file with
  `--parallel` (the package script) or alone.
