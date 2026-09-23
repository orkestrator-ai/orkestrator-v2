# Interactive Fix environment activity settlement

- **ID:** 0152
- **Status:** open
- **Date observed:** 2026-09-20
- **Test:** `MultiReviewService settles the interactive Fix card in the background with final usage`
- **File:** `apps/backend/src/core/multi-review-service.test.ts:741`
- **Original command:** `mise run test`
- **Worker configuration:** Backend package 1 Bun worker within the workspace
  group's 2 slots; root 3 workers, bridges 2 slots, protocol 1 slot.
  Browser validation also ran on this host.
- **Failure:** Environment `agentActivitySources.multi-review.state` did not
  match `idle` after the session had settled (190.60ms).
- **Suite counts:** Backend package: 3484 passed, 3 skipped, 1 failed;
  3488 tests across 150 files in 180.17s.
- **Isolated rerun:** `mise run test:logged -- --name review-isolated -- bun --cwd=apps/backend test ./src/core/multi-review-service.test.ts --parallel=1 --only-failures`
  passed in 10.6s.
- **Hypothesis:** The test waits for `fixSession.status` to become idle, then
  immediately asserts environment activity. Those projections may settle at
  different times under aggregate load. Root cause is not confirmed.
- **Failure artifacts:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.g2MjVi/workspace-web-backend-desktop-web-public-cli-protocol.log.gz`

Observed while validating design-pane dividers; no multi-review code changed.
