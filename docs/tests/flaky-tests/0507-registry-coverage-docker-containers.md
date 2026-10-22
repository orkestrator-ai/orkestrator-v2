# `direct backend command registry coverage > reports Docker maintenance state; unreviewed removal is refused`

- **ID:** 0507
- **Status:** open
- **Date observed:** 2026-10-20
- **Original command:** `mise run test` (as `mise run test:logged -- --name final-suite`)
- **Worker configuration:** workspace group (web, backend, desktop, web-public, cli, protocol, toolchain), backend package alongside six others
- **Failure:** `apps/backend/tests/commands-registry-coverage.test.ts:252` —
  `invoke("get_orkestrator_containers", {}, context)` rejected where the test
  expects it to resolve, 350.1 ms. The preceding
  `get_docker_system_stats` assertion passed. The backend package ran 9,630
  tests across 537 files in 408.1 s. Docker was running on the host at the
  time of the isolated rerun.
- **Isolated rerun:** `mise run test:logged -- --name own-registry -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  tests/commands-registry-coverage.test.ts` passed (0.9 s).
- **Recurrence:** failed again (280.3 ms) in the immediately following
  `mise run test` on the same tree, as the only failure of that run; the
  unchanged owning file passed alone again. Observed a third time on
  2026-10-21 (278.1 ms), again as the only failure of a full `mise run test`
  (429.2 s; root, bridges and codex-protocol groups all passed), with the
  owning file passing alone in 1.0 s. Three aggregate runs out of five on this
  host, so it reproduces readily under group load.
- **Hypothesis:** the container listing reaches the real Docker daemon, and the
  same aggregate run logs `container cases skipped: Docker or image
  orkestrator-artifact-preview-worker:1 unavailable` from
  `preview-modules.test`. Concurrent Docker work in the same group appears able
  to make the daemon briefly unavailable to this command, which then rejects
  rather than returning an empty list. Whether the right answer is a stubbed
  daemon for this coverage test or a tolerated rejection is undecided.
- **Notes:** unrelated to the branch it was observed on (the settings Usage
  tab); that change touches no Docker or container code path.
