# `ACP bridge > bounds remembered provider message ids during a large replay` (`bridges/acp-bridge/src/acp-transcript.test.ts:136`)

- **ID:** 0131
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at
  `5b9c6e68` on `investigate-sub-agent`, with an uncommitted codex-bridge
  sub-agent-status change in the tree.
- **Worker configuration:** the full concurrent cross-platform suite via
  `scripts/test-all.ts`, so the bridges group ran alongside the root, web and
  protocol groups rather than on its own. Production Orkestrator was also live on
  this host (its Electron, backend, and per-environment claude/codex bridge
  children), so host load was well above a quiet single-group run.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration
  15,021.46 ms), thrown from the shared `waitFor` helper
  (`acp-test-harness.ts:184`) via `spawnBridge` (`acp-test-harness.ts:234`) at
  `acp-transcript.test.ts:137`. The expired wait is the `GET /global/health` poll
  against the freshly spawned bridge child, so the child never reported healthy
  and none of the replay-bounding behaviour under test was reached.
- **Suite counts:** bridges group `2678 pass, 11 skip, 1 fail, 8904 expect() calls.
  Ran 2690 tests across 92 files. [67.00s]`. It was the only failure in the run.
- **Isolated rerun:** `bun run test:logged -- --name acp-transcript-alone -- bun test bridges/acp-bridge/src/acp-transcript.test.ts`
  → exit 0 in 18.1 s; the target passed. The same file had also passed earlier in
  the same session under `bun test bridges --parallel=2 --only-failures`
  (bridges group green in 49.2 s).
- **Related:** same `spawnBridge` health-wait family as
  `ACP bridge > keeps a completed turn idle when Cursor replay is failed`
  (`acp-transcript.test.ts:1410`) and
  `ACP bridge > rejects a concurrent second turn that carries a different requestId`
  (`index.test.ts:4956`). This is the first recurrence in this family recorded
  from a full `test-all.ts` run rather than a bridges-only run.
- **Hypothesis:** spawn contention, with this occurrence adding the evidence the
  `:1410` entry asked for on the load axis — the whole file takes 18.1 s alone
  while a *single* child startup exceeded 15 s here, so the budget was missed by
  a wide margin under four-group concurrency plus a live production instance,
  not marginally. It still does not measure how long the child actually took to
  bind, which remains the measurement needed before `BRIDGE_STARTUP_TIMEOUT_MS`
  is raised again; the open question from `:1410` — whether a prior test's child
  was still shutting down and holding its state directory or port — is also
  untested here. Note this file spawns a bridge child per test, and the change in
  flight touched only `bridges/codex-bridge` sub-agent status derivation, which
  no ACP path loads.
