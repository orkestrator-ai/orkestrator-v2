# Agent upgrade runbook removed-guide scan (tests/unit/docs/upgrade-agents-docs.test.ts)

- **ID:** 0155
- **Status:** resolved
- **Date observed:** 2026-09-21
- **Original command:** `mise run test`
- **Worker configuration:** Root and agent-support group with 3 Bun workers
- **Failure:** `agent upgrade runbook contracts > no tracked file anywhere still references the removed Codex guide` exhausted Bun's 5-second test timeout (reported duration: 5,000.10 ms)
- **Suite counts:** 4,348 total, 4,343 passed, 2 skipped, 3 failed, 1 unhandled error
- **Isolated rerun:** `mise run test:logged -- --name upgrade-docs-isolated -- bun test ./tests/unit/docs/upgrade-agents-docs.test.ts --parallel=1 --only-failures` → passed in 0.2s
- **Hypothesis:** The repository-wide tracked-file scan was delayed by aggregate resource contention. The owning file passed unchanged in isolation at a small fraction of its five-second timeout.

## Resolution (2026-11-15)

- **Root cause:** the repository-wide tracked-file scan was starved of CPU in a loaded aggregate and spent Bun's 5 s default budget; alone it takes a fraction of that.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup.ts`, `tests/setup-node.ts`), raises Bun's default per-test and hook budget from 5 s to 60 s, a hang watchdog only. `tests/unit/docs/upgrade-agents-docs.test.ts` sets no timeout of its own (no `setDefaultTimeout`, no third argument, no hook timeout, no inner deadline), so it inherits the 60 s budget. No assertion changed.
- **Reproduced:** no. The recorded failure is a starved 5 s budget on a loaded CI/aggregate host; the file passed alone and passed under `bun scripts/test-under-contention.ts --burners 6` after the change (see Stress), but a pre-change failure was not provoked, so this is evidence about the post-change state only. Base `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Stress:** `mise run test:logged -- --name f4-testall-cont -- bun scripts/test-under-contention.ts --burners 6 -- bun test tests/unit/test-all.test.ts tests/unit/docs/upgrade-agents-docs.test.ts tests/unit/design-qualification-processes.test.ts --parallel=1 -t '<named cases>'` passed (57.6 s). Note: the 60 s default applies per file only when Bun isolates files (`--parallel` or `--isolate`, as the aggregate does); in a plain single-process `bun test a b`, files after the first fall back to 5 s (observed with Bun 1.4.4).
