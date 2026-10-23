# In-app pull request viewer validation: coordinator fixture digest timing

- **ID:** 0721
- **Status:** open
- **Date observed:** 2026-10-23.
- **Baseline:** `eac5a2d9d`, with the in-app pull request viewer in the working tree.
- **Original command:** `mise run test` (default aggregate allocation).
- **Aggregate result:** failed. The bridges and Codex protocol lockfile groups
  passed; the workspace (670.7 s) and root and agent-support groups failed.

## Failures and complete owner reruns

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `tests/unit/hooks/usePullRequest.test.ts` | Five `viewPR` cases expected the browser to open. | **Not a flake.** This change makes "View PR" open the files panel by default; the tests now pass `{ external: true }` for the browser path and cover the panel path. 1 owner passes. |
| `tests/unit/test-diagnostic-bounds.test.ts` | Three new pull request component tests passed DOM queries straight to `toBeNull`. | **Not a flake.** The assertions now compare with `=== null`; the owner passes. |
| `apps/desktop/scripts/dev/coordinator-live.test.ts` | `fixture tree digest > names every class of change a coordinator could make` hit the five-second deadline (5,012 ms). | `mise run test:logged -- --name coordinator-live-owner -- bun test --cwd apps/desktop ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed (1.6 s). Existing case [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md). This change does not touch the coordinator. |

The original aggregate exit remains failed.

## Isolated browser suite

`mise run test:agent:browser:isolated` returned 28 passed, 53 skipped and 1
failed (6.7 m). `host path browsing › host picker creates and browses folders
through the authenticated gateway above fullscreen settings (narrow)` timed
out clicking the hidden `Repository settings` button (15 s), the recurrence
tracked in [0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md),
which also fails on `main`. The profile was stopped and reset automatically.

## Final aggregate

After the test fixes above and a crash fix in the files panel's
pull-request widening, a fresh `mise run test` passed every group (workspace
409.2 s, root and agent-support 122.2 s, bridges 81.3 s, Codex protocol
lockfile).
