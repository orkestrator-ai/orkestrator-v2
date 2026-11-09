# Agent account loading after controls appear

- **ID:** 9903
- **Status:** open
- **Date observed:** 2026-11-09
- **File:** `apps/web/src/components/layout/AgentInfoButton.test.tsx:1064`

## Observation

Observed 2026-11-09 on coordinator-actions-panel-6721917eb07f-r1, based on
`c0b02ace0188988773bd540ed132d9f99d0529c5`; implementation commit `bd80009d4`.

The default suite (`mise run test:logged -- --name repair-default-final -- mise run test`)
failed `AgentInfoButton usage panel > places the claude account controls directly
below usage in the popover` in
`apps/web/src/components/layout/AgentInfoButton.test.tsx:1064`.
The web package used two parallel workers. After the Add an account button
appeared, `queryByText("Reading account…") === null` was false (expected true).
Duration: 40.87 ms. Web totals: 14,140 passed, 10 skipped, 1 failed.
Evidence: `/tmp/orkestrator-test-run.pO50wT/repair-default-final.log.gz`.
The aggregate also failed the separate backend-runtime ownership test.

## Isolated rerun

`mise run test:logged -- --name repair-agent-info-isolated -- env NODE_ENV=test bun test --cwd apps/web ./src/components/layout/AgentInfoButton.test.tsx --parallel=1 --only-failures`
passed unchanged in 11.1 seconds. The passing log was retired by the logged runner.
The earlier aggregate run in this same attempt also passed the web package.

## Investigation

The assertion observes the loading label immediately after finding an independently
rendered account control. That is consistent with a render/async-account-read gap,
but the root cause is unconfirmed. Neither the owning component nor its test is
changed by this branch. No timeout, assertion or production behavior was altered.

## Follow-up

Reproduce the competing loading/control renders before changing the test or
component; determine whether the UI should settle atomically or the test should
await the completed account read. This is the first recorded observation.
