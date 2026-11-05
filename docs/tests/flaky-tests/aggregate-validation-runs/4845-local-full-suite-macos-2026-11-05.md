# Local full suite on a loaded macOS host, 2026-11-05

- **ID:** 4845
- **Status:** environmental
- **Date observed:** 2026-11-05
- **Original command:** `mise run test:logged -- --name ci-fix-full -- mise run test:full` on
  macOS at `48d2ed40c` plus uncommitted test fixes, on a host also running production
  Orkestrator. Groups finished in 1659.7 s; bridges and the codex protocol lockfile passed.
- **Artifacts:** `orkestrator-test-run.AHk6EP` below the host temporary directory.

None of the failures below appeared in the `main` CI logs checked on 2026-11-04, which covered
the failed runs from 11:48 UTC to `e198fd4a7`. Each owner passed alone, except the case noted.

| Test | Owner | Failure | Alone |
| --- | --- | --- | --- |
| `container firewall policy > GitHub ranges come from a fresh backend seed, else live, else this container's cache` | `tests/unit/firewall-policy.test.ts` | 5 s timeout | Pass (33.9 s) |
| `in-page deadlines > (unnamed)` | `tests/unit/multi-environment-ui-perf.integration.test.ts` | 5 s timeout; see 2711 and 2882 | Pass (4.1 s) |
| `import ownership failures`: unreadable paths stamp, sums stamp and ownership bookkeeping | `apps/backend/tests/portable-inputs-stamps.test.ts` | 5 s timeouts | Pass (137.8 s) |
| `executable document policy in webkit > network, image, font and WebSocket attempts reach the sink zero times` | `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | `toEqual` mismatch, 2.7 s | Pass (103.3 s) |
| `status timeout reports ETIMEDOUT and retries without fsmonitor` (bun, node) | `apps/backend/src/core/review-validation-worker.test.ts` | Failed alone too; resolved as 2883 | Fail, then fixed |

Hypothesis, not established: host load, since the timeouts all sit at the 5 s default. The
WebKit mismatch is not explained by a timeout, and its detail was not examined. No test
changed for this case; reopen it or add a case if one of these recurs on CI.
