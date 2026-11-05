# Local full suite on a loaded macOS host, 2026-11-05

- **ID:** 4845
- **Status:** open
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
WebKit mismatch is not explained by a timeout, and its detail was not examined. Keep this
case open until the mismatch is examined and its cause established; passing alone does
not establish an environmental cause. No test changed for this case.

## Merge validation on 2026-11-05

Merged `origin/main` at `df4445371740bf3099c5c50876b2dff397b69758`
into `f3fb609d91ddd758f01a0daa3b3a8909b39cd637`. The complete original
conflict list is retained with both parent IDs in local Git metadata.

`mise run test:logged -- --name merge-default-tests -- mise run test`
finished in 417.2 seconds, exit 1. Backend passed (15,891 pass, zero fail),
as did desktop, CLI, toolchain, web-public, bridges and the Codex protocol
lockfile. Web had 12,847 pass and three fail; protocol had 4,841 pass and
one fail; root had 3,635 pass, four fail and one error.

Root's two registry failures were corrected: branch case IDs 4842–4844
collided with upstream cases, so they became 6190–6192, and upstream case
4844 lacked required ID/status metadata. The final complete registry owner
passed (`merge-registry-final`). WebKit's concurrent reader EINVAL passed
alone; see case 6193.

The following complete owners reproduced their remaining failures alone:

- `tests/unit/components/HierarchicalSidebar.test.tsx`: stale merge-cleanup
  bulk deletion, 101 pass and one fail (`merge-sidebar-alone`, 3.9 s).
- `apps/web/src/components/federation/federation-ui.test.tsx`: remote fork
  startup and its rejected/unknown outcomes, 94 pass and three fail
  (`merge-federation-alone`, 4.4 s).
- `packages/protocol/src/node/standalone-service-install.test.ts`: unlocked
  release installation could not find `leaf/package.json`, five pass and one
  fail (`merge-install-alone`, 0.3 s).

These owner files match `origin/main`; they are not classified as flakes.
No implementation or assertions in these owners were changed. Each isolated
command used `mise run test:logged`, `bun test` with the explicit owner path
and `--parallel=1 --only-failures`; protocol also preloaded
`../../tests/setup-node.ts` from its package directory.

Formatting, lint and repository typechecking passed, as did the three
conflicted test owners. Formatting was rerun after registry edits. Application
behavior was unchanged by the resolutions; browser/native scenario suites
were not run. No live QA profile was created.

Compressed evidence is under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/`:

- `orkestrator-test-run.Bg16TH/merge-default-tests.log.gz` (outer result).
- `orkestrator-test-run.o1RGn7/` (aggregate group logs).
- `orkestrator-test-run.SYc2Tv/merge-sidebar-alone.log.gz`.
- `orkestrator-test-run.WfSLAK/merge-federation-alone.log.gz`.
- `orkestrator-test-run.VQW97F/merge-install-alone.log.gz`.
