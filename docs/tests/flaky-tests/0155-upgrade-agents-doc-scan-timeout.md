# Agent upgrade runbook removed-guide scan (tests/unit/docs/upgrade-agents-docs.test.ts)

- **ID:** 0155
- **Status:** open
- **Date observed:** 2026-09-21
- **Original command:** `mise run test`
- **Worker configuration:** Root and agent-support group with 3 Bun workers
- **Failure:** `agent upgrade runbook contracts > no tracked file anywhere still references the removed Codex guide` exhausted Bun's 5-second test timeout (reported duration: 5,000.10 ms)
- **Suite counts:** 4,348 total, 4,343 passed, 2 skipped, 3 failed, 1 unhandled error
- **Isolated rerun:** `mise run test:logged -- --name upgrade-docs-isolated -- bun test ./tests/unit/docs/upgrade-agents-docs.test.ts --parallel=1 --only-failures` → passed in 0.2s
- **Hypothesis:** The repository-wide tracked-file scan was delayed by aggregate resource contention. The owning file passed unchanged in isolation at a small fraction of its five-second timeout.
