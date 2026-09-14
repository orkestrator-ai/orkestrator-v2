# `Electron backend process supervisor > reports backend readiness before slow managed Serve initialization finishes` (`tests/unit/electron/backend-process.test.ts`)

- **ID:** 0041
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Direction:** the inverse of this file's usual pattern — it failed *in isolation* and passed in the aggregate suite, so it is recorded here rather than dismissed.
- **Original command:** `bun run test:logged -- --name cred-focused2 -- bun test tests/unit/electron/backend-process.test.ts tests/unit/claude-credential-injection.test.ts --parallel=2 --only-failures`
- **Worker configuration:** two Bun workers over two files, while an isolated `dev:test` profile (`agent-cred-inject`) was live on the same machine.
- **Failure:** `Unable to inspect Tailscale Serve configuration: Command failed: <tmp>/tailscale serve status --json` from `apps/backend/src/tailscale-serve.ts:176` via `managed-web-client.ts:170` (duration: 7,977.82 ms).
- **Suite counts:** 54 passed, 1 failed; 55 tests across 2 files.
- **Isolated rerun:** `bun test tests/unit/electron/backend-process.test.ts -t "reports backend readiness before slow managed Serve initialization finishes"` → also failed (7,439.62 ms), and failed identically on a stashed clean tree (8,964.33 ms), confirming it is not caused by the credential-injection change on this branch.
- **Follow-up:** after the live `dev:test` profile finished starting, the owning file passed alone (32 passed, 14.18 s) and the complete aggregate `bun run test` passed in 104.9 s.
- **Recurrence:** during credential-isolation follow-up on the same date, `bun test tests/unit/electron/backend-process.test.ts --parallel=2 --only-failures` failed at `waitForPath(.../status-started)` after 7,182.99 ms (27 passed, 1 failed); an immediate single-test rerun with `-t "reports backend readiness before slow managed Serve initialization finishes"` passed in 7.1 s.
- **Aggregate recurrence:** `bun run test` at `ea9d79bdfdd3b2d4f5e0754b1ed6d2adf619e98e` timed out at the same `status-started` wait after 5,497.76 ms; the exact test passed alone in 3.1 s.
- **Recurrence (2026-08-27):** `bun run test` timed out waiting for
  `status-started` after 10,448.97 ms. The owning file then passed alone: 29
  tests, zero failures.
- **Hypothesis:** the case drives real backend startup against a fake `tailscale` shim in a temp directory. Concurrent process pressure from a starting `dev:test` profile appears to make the shim invocation fail rather than merely run slowly, so the failure is contention-shaped like the existing "Standalone backend shutdown and Tailscale Serve lifecycle" family. A recurrence should capture whether the shim was ever created and whether the failure is a spawn error or a non-zero exit before changing the Serve assertions.
