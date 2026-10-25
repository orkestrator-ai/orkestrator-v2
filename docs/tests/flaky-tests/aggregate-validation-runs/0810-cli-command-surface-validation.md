# CLI command surface validation

- **ID:** 0810
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Change under test:** todo 0017, the post-release CLI command surface (public API protocol, `apps/backend/src/core/public-api/*`, `commands-files.ts`, `commands-environment.ts`, `commands-projects.ts`, `commands-registry-control.ts`, `packages/cli`).
- **Original command:** `mise run test` (default reservations; other worktrees validating concurrently on the same host, 17–18 of 18 slots reserved).
- **Aggregate result:** failed after 1951.5 s. One failure was caused by the change and fixed in it: `apps/backend/tests/commands-registry-environments.test.ts` `marks local environment errored when the project repository has no origin remote` (the local-only start point now applies only to `project init` projects; the owner passes, 75 with the new tests). The rest were in files the change does not touch:
  - `apps/backend/src/core/terminal-history.test.ts`: `terminal history > normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages` (5001.17 ms).
  - `apps/backend/src/core/coordinator-service.test.ts`: `project coordinator > a dirty submodule needs enhanced confirmation before a discarding switch` (5119.15 ms).
  - `bridges/pi-bridge/src/prompt-cancel-preflight.test.ts`: `concurrent cancels for one claim > repeat cancels of an accepted run share one abort` (47.80 ms).
  - `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts`: `a cold app-server child > its first answer is stale until a settling re-read confirms the plugin skills` (2176.95 ms, its own 2 s `waitFor`).
  - `apps/desktop/scripts/dev/coordinator-live.test.ts`: `fixture tree digest > names every class of change a coordinator could make` (5021.43 ms; also in [0790](0790-settings-machine-strip-validation.md)).
- **Owner reruns:** passed alone with `bun test <file>` from their packages: terminal history 25, coordinator service 56, Pi cancel preflight 16, Codex command catalogue 30. `coordinator-live.test.ts` did **not** pass alone: it failed the same way twice on this branch and once in a detached checkout of unmodified `main` (`ba7cc8d4`), with `git rev-parse exited 128: fatal: Unable to read current working directory` after the five-second limit. It is therefore not classified as a flake of this change; it passed alone on 2026-10-24 in 0790.
- **Evidence:** `orkestrator-test-run.rS8Pfu/` under the host temporary directory.

No assertion, timeout or skip was changed for these tests. Shared-host contention is a possible contributor, not an established cause.

## Triage 2026-10-25

Resolved: run record only. The registry-environments failure was a branch defect fixed in the change. Terminal history is [0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md), coordinator service [0165](../coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md), Pi cancel [0500](0500-agent-mail-main-merge-validation.md), and the digest, including its failing-alone `Unable to read current working directory` runs, is [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md). The Codex catalogue case `its first answer is stale until a settling re-read confirms the plugin skills` is a sibling of [0791](../agent-bridges/0791-codex-command-catalogue-stale-race.md) and [0800](../agent-bridges/0800-codex-command-catalogue-armed-delay-race.md) in the same `describe`; the lead should fold it into 0791.
