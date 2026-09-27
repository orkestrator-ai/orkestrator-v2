# `the bridge process > configures the SDK with the production store rooted below bridge state` (bridges/cursor-bridge/src/config.test.ts)

- **ID:** 0158
- **Status:** open
- **Date observed:** 2026-09-22
- **Original command:** `mise run test`
- **Worker configuration:** default `scripts/test-all.ts` plan; bridges group via turbo, cursor-bridge `test:bridge` with `--parallel`, running concurrently with the root and workspace groups
- **Failure:** `error: bridge script exited null: ` (empty stderr), thrown by `runBridgeScript` at `config.test.ts:136` (duration: 58.34ms)
- **Suite counts:** 443 total, 442 passed, 1 failed (19 files)
- **Isolated rerun:** `cd bridges/cursor-bridge && bun test src/config.test.ts` → passed (11 pass, 0 fail). The next full `mise run test` on the same tree also passed.
- **Hypothesis:** `runBridgeScript` runs `spawnSync(process.execPath, ["-e", …], { timeout: 60_000 })` and treats any non-zero `status` as failure. A `null` status after 58ms cannot be the 60-second timeout: `spawnSync` gives `status: null` either when the child is killed by a signal or when the spawn itself fails (`result.error`, e.g. `EAGAIN` under process pressure), and both leave `stderr` empty. The helper reports neither `result.signal` nor `result.error`, so this run cannot tell them apart. The same run had just bumped `@cursor/sdk` 1.0.31 → 1.0.32, but the isolated pass and the clean follow-up suite point to aggregate load rather than the SDK. A next step is to include `result.signal` and `result.error` in the thrown message, so a recurrence identifies the cause.
