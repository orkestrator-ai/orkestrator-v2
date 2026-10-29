# Pi commands before the first turn (0069) validation

- **ID:** 0860
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** Pi lists its templates and skills before its session attaches (`bridges/pi-bridge/src/command-preview.ts`), with an additive `attachPending` catalogue field through protocol, backend cache and renderer (todo 0069, retired on 2026-10-29; see [native-agent-commands.md](../../../architecture/native-agent-commands.md#provider-notes)).
- **Original command:** `mise run test:logged -- --name full-test-0069 -- mise run test`, while a `dev:test` profile was building the container image (`--fixture-environments local,container`) on the same host.
- **Aggregate result:** failed after 1089.5 s. One failure was the change's own new test (`command-preview.test.ts`, "matches what the attach path's loader lists"): it expected each fixture extension to be imported exactly once by the attach path, which held alone but not in the suite. The assertion now compares the set of loaded extensions, and the pi-bridge suite passes (620 pass). The remaining failures were five-second (or 30 s) timeouts in files the change does not touch:
  - `apps/backend/tests/codex-subagent-cards.test.ts`: `each child keeps one card, its transcript and status across a fresh backend and a cold restart` (31164.83 ms).
  - `apps/backend/src/core/looped-review-scheduling.test.ts`: `retained history is enumerated only by the safety scan` (5003.31 ms).
  - `apps/backend/src/core/transcript-artifacts/content-server.browser.test.ts`: `served executable document in Chromium` (5003.24 ms).
  - `apps/backend/src/core/environment-move.test.ts`: `moves a worktree with nested submodules (same disk)` (5057.29 ms); see [0820](0820-multi-review-scale-cost-validation.md) and [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md).
- **Owner reruns:** each complete unchanged owner run alone with `bun test <file>` from `apps/backend`: codex-subagent-cards 1 passed, looped-review-scheduling 7 passed, content-server browser 1 passed. environment-move alternated over three runs: 36/1 (`restart recovery re-links submodules of an adopted or abandoned copy`, 5076.41 ms), 37/0, 36/1 (`a failed submodule re-link restores the original checkout`, 5057.48 ms), each failure a five-second timeout on a different submodule case, with the worktree on an external volume.
- **Evidence:** `orkestrator-test-run.EmUGIL/` under the host temporary directory.

No assertion, timeout or skip was changed for these four tests. The concurrent Docker image build and the external-volume worktree are possible contributors, not established causes.
