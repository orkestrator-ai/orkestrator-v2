# Claude first-turn probe: a bridge variant saw no model request for 60 s

- **ID:** 10054
- **Status:** open
- **Date observed:** 2026-11-23
- **Base:** `ab25de23e` (pull request #2552, CI run 45237991442, job
  137914740030 `Tests (root-bridges)`).
- **Test:** `a parked spare calls no model, keeps a session id and refuses a
  resume` (`bridges/claude-bridge/src/services/claude-first-turn.live.test.ts`,
  probe `claude-first-turn.live-probe.ts`).
- **Failure:** after 61,218.27 ms the probe exited 1 with `No model request in
  60 s`.
- **Original command:** the CI `Tests (root-bridges)` shard of the complete
  non-iOS suite.
- **Isolated rerun:** the runner's lone rerun of the file passed (9.9 s).

## Investigation (2026-11-24)

- The failing run printed 12 CLI pids. A healthy local run of the probe also
  prints 12, and the bridge variants' CLIs are not printed, so every SDK
  variant got as far as it should and a bridge variant is the one that
  stalled. The wait began about 1.2 s after start, so it was that bridge's
  first prompt.
- `startBridge` read a free port by binding port 0, released it and started
  the bridge on it. It then asked only `/global/health`, which needs no token,
  and sent the bridge's output nowhere. `bridgeRun` never read the prompt's
  status until a model call had been seen. A bridge that lost its port would
  therefore pass the health check against another server, be refused there,
  and show only as a missing model request. That is how case
  [9967](9967-codex-account-switch-bridge-health-under-load.md) failed on
  2026-11-18.

## Change (2026-11-24)

The probe now retries a start whose port was taken on a fresh port (up to five
times), treats a bridge as started only when `/global/auth-check` accepts its
own token, keeps the bridge's stderr tail, and rejects the wait as soon as a
prompt is refused or a session does not go idle.

- **Reproduced:** no — the port was not lost again locally, so the cause is
  inferred from the code and the pid count.
- **Verification:** the file passed alone (3 tests, 8.6 s).

The case stays open: a recurrence now names the refusal.
