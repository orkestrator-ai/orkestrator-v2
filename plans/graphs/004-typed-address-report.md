---
id: 004
title: "A typed Address report"
phase: 0
plan: "P0.4"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 004 · A typed Address report

- **Plan:** [P0.4 A typed Address report](../composable-graphs.md#p04-a-typed-address-report)
- **Decisions:** none (report §2.7, finding 4)
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Address → Verify becomes a typed handoff. Today Verify reads the Address session's last assistant text.

## Work

- [ ] Address turns open a `fix-result` result slot (tool or structured transport). The schema exists: `complete`, `summary`, `filesChanged`, `commandsRun`, `notes`, `limitations`.
- [ ] The missing-result reminder and stage failure apply to Address as to the other stages.
- [ ] `verificationPrompt` renders the accepted result as an evidence frame.
- [ ] Keep `latestAddressReport` as the fallback for Address turns started before the upgrade and for providers without a result transport.
- [ ] Store the accepted result on the Address session (bounded) so the inspector can show it.

## Tests

- [ ] An Address submission reaches the Verify prompt as a framed report.
- [ ] A pipeline record from before the upgrade still uses the last assistant text.
- [ ] A missing Address result triggers one reminder, then fails the stage.

## Done when

- [ ] New runs: Verify reads a typed Address report.
- [ ] Old runs stay readable and resumable.
- [ ] `build-pipeline-view.md` and `review-preparation.md` describe the handoff.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
