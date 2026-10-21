# Paused-interaction qualification main-merge validation

- **ID:** 0625
- **Status:** open
- **Date observed:** 2026-10-21
- **Merge:** `origin/main` at `d4171748` into `eb9da37a` on
  `qualify-paused-interactions-past-10min-2a03d32f86f4`.
- **Confirmed intermittent owner:** `tests/unit/host-test-scheduler.test.ts`,
  `resource exclusion, queue bounds, cancellation and frozen budgets`.
  `mise run test:logged -- --name merge-tests -- mise run test` reported a
  5090.30 ms timeout against the 5000 ms deadline in the one-worker root group.
  `mise run test:logged -- --name merge-owner-host-test-scheduler -- bun test
  ./tests/unit/host-test-scheduler.test.ts --parallel=1 --only-failures` passed
  the complete unchanged owning file (exit 0, 16.8 seconds logged).
- **Configuration:** the aggregate requested workspace/root/bridges/protocol
  reservations of 4/1/2/1 slots. Every group initially queued behind the host's
  18 reserved worker slots; root/support was admitted after 437.6 seconds.
  Browser, Electron and Docker checks also ran on the host. Host contention is
  a hypothesis, not an established cause.
- **Evidence:** aggregate outer log directory `orkestrator-test-run.qew3QD`,
  root/support directory `orkestrator-test-run.xNKvA2`, below the host temporary
  directory. Passing owner output was removed by `test:logged` as designed.
- **Changes:** evidence only; no implementation, assertion, timeout or skip was
  changed to hide a failure.

## Other validation limitations

These observations do not independently establish flakes:

- Root owners `firewall-refresh`, `firewall-policy`, `pi-bridge-vendor`,
  `test-diagnostic-bounds` and `disk-report` timed out in the aggregate and in
  separate unchanged owning-file reruns with `--parallel=1`. Their logged
  reruns took 36.8, 37.9, 36.2, 40.1 and 7.8 seconds respectively. Failing
  evidence directories: `orkestrator-test-run.yhO7yd`, `.RCCqFb`, `.2vR2O9`,
  `.OJWdSR` and `.lgnb1M` (each suffix uses the `orkestrator-test-run` prefix).
- `mise run test:agent:browser:isolated`, through `test:logged` as
  `merge-browser`, reached its 15-minute browser deadline (948.4 seconds
  including lifecycle). It reported narrow host-picker, capped-file-tree and
  both host-maintenance viewport failures before stopping at case 24/70.
  Its disposable `qa-browser-308ee3d5-6b9` profile was stopped/reset.
  Evidence: `orkestrator-test-run.L04OZf`.
- `mise run test:agent:electron`, logged as `merge-electron`, finished with
  19 passed, one skipped and three failed in 1204.5 seconds: both regular
  `electron-main.spec.ts` window scenarios timed out, and terminal resume
  could not find its project/environment entry. Evidence:
  `orkestrator-test-run.edAmg1`.
- `mise run test:agent:docker`, logged as `merge-docker` against credential-free
  profile `merge-main-validation`, finished with seven passed, two skipped and
  two failed in 750.0 seconds. The new access-only Codex/Grok import test
  reached its `docker rm --force` cleanup, which exceeded 30 seconds; a later
  exact-owner inventory found no remaining test container. The rebuild case
  could not find `Before a rebuild` after reload. Artifact sanitization also
  rejected that case's trace above its 16 MiB limit. The new withheld-login
  summary passed, including environment switching and reload. Evidence:
  `orkestrator-test-run.Hb55Bk`.
- The complete unchanged rebuild owner repeated its missing recovery-copy
  label failure (177.9 seconds logged, `orkestrator-test-run.sQipza`).
- The unchanged terminal-resume Electron owner repeated its missing
  project/environment entry failure (132.0 seconds logged,
  `orkestrator-test-run.7a9v3y`).
- The unchanged Electron-main owner repeated both regular window failures
  (two failed, one passed, one skipped; 285.6 seconds logged,
  `orkestrator-test-run.cJSkfv`). The first exceeded 120 seconds; the
  nickname case timed out waiting for the persisted remote label.
- The complete gateway owner rerun used the same disposable profile with
  Docker enabled and one worker. It finished with 16 passed, four skipped
  and three failed (664.0 seconds): narrow host picker, capped file tree and
  narrow host maintenance. Trace sanitization also exceeded its 16 MiB bound.
  The new access-only import test passed unchanged in this rerun. This does
  not establish that the complete owning file is intermittent. Evidence:
  `orkestrator-test-run.aoiFNv`.
- The aggregate's outer logger reached its configured 1800000 ms deadline
  (1801.0 seconds logged) and terminated the process tree. Workspace tests
  remained queued and were reported incomplete. Root/support had recorded
  failures but did not finish. Protocol regeneration passed after waiting
  1652.0 seconds; bridges were admitted after 1781.7 seconds and the runner
  reported them passed during shutdown. The overall result was exit 1, not
  a passing complete suite. No aggregate pass is claimed.

Formatting, lint, typechecking, the desktop build, the development Docker image
build and focused backend, desktop, renderer and protocol tests passed. Local
Markdown link targets and conflict-marker/whitespace checks passed. CLI scenario,
iOS and billed provider suites were not selected because those implementations
were unchanged; ordinary isolated browser, Electron and Docker scenarios were
selected for the incoming renderer and container changes.

Cleanup: `dev:stop` and `dev:reset` both exited 0 for
`merge-main-validation`; reset removed three exact-owner containers, six
volumes, one network and the disposable profile state.

## Follow-up merge: `448800c6` into `479918b8`

Fetched `origin` again on 2026-10-21. Conflicts were limited to the flake
registry and todo totals. Both sets of registry entries were retained; this
report moved from 0515 to 0625 because main already assigned 0515 to the
Electron nickname case. Checklist totals were recomputed (1 very high, 16 high,
269 medium, 283 low; 569 total). Incoming application and bridge code matches
`origin/main`; no product code was manually resolved or altered.

Passing checks through `test:logged`: `main2-format`, `main2-lint`,
`main2-types`, `main2-build`, `main2-docker-build`, focused backend account and
Docker-registry owners, desktop connection/preview owners, renderer preview
owners, Codex engine owner, and `main2-flake-index`. `main2-docker` passed in
210.4 seconds against credential-free profile `paused-main2-validation`.

### Confirmed intermittent observations

The aggregate command was `mise run test:logged -- --name main2-tests -- mise
run test`, with workspace/root/bridges/protocol reservations of 4/1/2/1.
Root started immediately, bridges waited 90.3 seconds and workspace waited
819.4 seconds. Other worktrees and browser/native validation were active.
Contention is a hypothesis, not an established explanation for each failure.

- Codex `session lifecycle > a failed escalation restart keeps the guard and
  re-arms the backstop` (`bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts`):
  109.49 ms aggregate failure. The complete unchanged owner passed with
  `main2-codex-lifecycle-owner`, `bun test --cwd bridges/codex-bridge --preload
  ../../tests/setup-node.ts ./src/app-server-runtime-lifecycle.test.ts
  --parallel=1 --only-failures` (5.4 seconds logged). Existing case [0214](0214-codex-escalation-restart-backstop-timing.md).
- Cursor `authentication > reports an authenticated credential as ready`
  (`bridges/cursor-bridge/src/http.test.ts`): 10007.34 ms timeout. The complete
  unchanged owner passed using the same command shape and `--parallel=1`,
  logged as `main2-cursor-http-owner` (6.0 seconds). Existing case [0182](0182-cursor-auth-readiness-aggregate-timeout.md).
- ACP `serves filesystem and bounded terminal requests from the fake agent`
  (`bridges/acp-bridge/src/acp-generalization.test.ts`): 60026.33 ms timeout.
  The complete unchanged owner passed with `main2-acp-generalization-owner`,
  the matching Node-only preload and `--parallel=1` (3.6 seconds). Existing case [0219](0219-acp-generalization-hook-timeout.md).
- Root `AddProjectDialog > detects the Git remote for a directory selected by
  the host picker` expected the fixture Git URL but received an empty string
  (171.20 ms). `main2-add-project-unit-owner`, running the complete unchanged
  `./tests/unit/components/AddProjectDialog.test.tsx` with `--parallel=1`,
  passed (56.2 seconds).
- Component-browser `long GitHub repository text ellipsizes inside the
  add-project dialog` timed out during `page.goto` on mobile. The complete
  unchanged `e2e/AddProjectDialog.spec.ts` passed both projects with one worker
  on its own free fixture port (`main2-add-project-owner`, 49.7 seconds).
  This does not classify the other component-browser failures.
- The service-preview Electron attachment-count case failed at line 1965 in
  the full native suite; the complete unchanged 14-case owner passed with
  one worker (`main2-service-preview-electron-owner`, 131.0 seconds).
- Annotation startup timed out in its GitHub-CLI dialog handler in the full
  native suite. The complete unchanged annotation owner passed with one
  worker (`main2-web-annotations-electron-owner`, 69.4 seconds).

### Remaining validation gaps

- `main2-component-browser` stopped at the checkout-ownership guard because
  port 1422 belonged to another checkout. It was retried without stopping
  that server, using freshly discovered private fixture/public ports.
  `main2-component-browser-private` finished with 323 passed, 80 skipped and
  49 failed (13.2 minutes). Many failures were 30-second navigation timeouts.
  Only the AddProjectDialog owner was independently requalified; the other
  failures are not newly classified as flakes. Evidence:
  `orkestrator-test-run.OrHkaz` below the host temporary directory.
- `main2-agent-browser` reached the 15-minute browser deadline (925.2 seconds
  including lifecycle), after starting 57/70 cases. Narrow socket selection
  stayed disabled, and the design-canvas deep-file fallback was absent from
  its persisted layout. Coverage is incomplete. The runner stopped/reset
  `qa-browser-60409f57-e71`. Evidence: `orkestrator-test-run.Gz966r`.
- The unchanged whole gateway owner, with one worker and Docker opt-in off,
  reported 12 passed, nine skipped and two failed (358.6 seconds): capped
  file-tree folder visibility and narrow host maintenance. Trace sanitization
  also exceeded 16 MiB. The narrow picker passed in this run, but the complete
  file remained non-green. Evidence: `orkestrator-test-run.VyB0DG`.
- `main2-electron` reported 17 passed, one skipped, three failed and nine not
  run (585.8 seconds): nickname reload, the service-preview attachment count,
  and annotation startup. The complete unchanged Electron-main owner repeated
  the nickname failure (two passed, one skipped, one failed; 163.1 seconds).
  Native-suite evidence: `orkestrator-test-run.0Uj95z`; nickname owner:
  `orkestrator-test-run.xdeh1t`. The service-preview and annotation owners
  passed as recorded above.
- Pi runtime vendoring and disk report timed out again in the complete
  unchanged owning files, with `--parallel=1`: `main2-owner-pi-bridge-vendor`
  (34.7 seconds, `orkestrator-test-run.AYQVU7`) and
  `main2-owner-disk-report` (6.8 seconds, `orkestrator-test-run.maWbfL`). These
  observations do not establish new flakes.

The manual profile was stopped/reset (both exit 0); reset removed two exact-owner
containers, four volumes, one network and its disposable state. No assertions,
timeouts, skips or product code were changed to hide these failures.

### Aggregate outcome and final checks

`main2-tests` completed all four groups, exit 1 in 1535.9 seconds. Protocol
regeneration passed. Bridges failed three cases; every unchanged owning file
passed separately as recorded above. Root/support reported 3166 passed, one
skipped, three failed and one between-test error across 3170 tests in 151
files (1000.33 seconds). The AddProjectDialog owner passed; Pi staging and
disk-report owners remained non-green.

Workspace backend tests passed (9766 passed, 67 skipped), as did protocol,
public web, CLI and toolchain. Desktop reported 973 passed, one failed and one
between-test error: `fixture tree digest > names every class of change a
coordinator could make` (`apps/desktop/scripts/dev/coordinator-live.test.ts`)
exceeded five seconds (5013.35 ms). Renderer tests reported 8551 passed, ten
skipped, one failed and one between-test error: the bounded long-transcript
fixture exceeded 120 seconds (120082.59 ms).

Both complete unchanged workspace owners passed separately with `--parallel=1`:
`main2-coordinator-digest-owner` used the desktop's Node-only preload (1.6
seconds logged), and `main2-long-transcript-owner` ran
`apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx` from the web
package (13.4 seconds). Existing digest case: [0258](0258-coordinator-fixture-digest-aggregate-timeout.md).

Full-run evidence: `orkestrator-test-run.VPPFmj/main2-tests.log.gz`; private,
bounded group logs and summary in `orkestrator-test-run.o0bdOw`, below the host
temporary directory. No complete aggregate pass is claimed after the owner
reruns. The other component-browser failures were not all independently
requalified and are not newly classified as flakes.

The separate public-site smoke run passed on a discovered free port
(`main2-public-browser`, 21.9 seconds), after the component failure prevented
the aggregate browser task from reaching that step. CLI scenario, iOS and
billed-provider suites were not selected because those implementations were
unchanged by this snapshot. Final format, local-link and conflict-marker checks
cover the resolved documentation and the renumbered registry report.

## Federated client refresh at 3da8e0cf — 2026-10-21

Merged `origin/main` at `3da8e0cf59b07cddef64afd08044153cc1e0704b` into
pre-merge HEAD `8e695b7de20dfffe4fb6084e595dd37d6519c6a3`. The incoming
merge changed 31 paths: attachment rendering and protocol, qualification
harnesses, test-runner wiring and documentation. Only the flake index
conflicted. Both histories were preserved, with branch-specific older cases
placed beside their matching IDs so upstream's newest-entry insertion stays
at the top. A new documentation sentence was reconciled with this branch's
already isolated Codex home.

Every validation used `mise run test:logged -- --name <label> --`. The default
suite used the testing guide's GNU-tool PATH with 4/1/2/1
workspace/root/bridges/protocol slots. Focused Bun owners used `--parallel=1`;
Playwright's component suite used its default workers and the real-stack
suite used one worker.

| Label | Command / scope | Result |
| --- | --- | --- |
| refresh-main-format | `mise run format:check` | Passed, 0.4 s |
| refresh-main-lint | `mise run lint` | Passed, 1.6 s; existing repository warnings remain |
| refresh-main-types | `mise run typecheck` | Passed, 9.1 s |
| refresh-main-build | `mise run build` | Passed, 36.0 s |
| refresh-main-attachment-owners | Web native-message adapters, NativeMessage, AgentNativeTab and initial-prompt attachment owners, one worker | Passed, 34.2 s |
| refresh-main-runner-owners | Root test-all, mise-tasks, flake-index and Playwright-loading owners, plus paused-interaction helper regressions, one worker | Passed, 27.8 s |
| refresh-main-tests | `mise run test` after the incoming attachment/protocol rebuild | 522.8 s; workspace packages, bridges and protocol passed. Root/support failed only the unchanged disk-report five-second timeout, whose complete unchanged owner passed alone (1.1 s). Recurrence recorded in 0259. |
| refresh-main-browser | `mise run test:browser` | Passed, 213.6 s, including public-site smoke |
| refresh-main-agent-browser | `mise run test:agent:browser:isolated` | 28 passed, 42 skipped, one failed, 468.4 s including cleanup. File-tree case could not find the build folder after narrow reload at its five-second visibility deadline. Sanitization also rejected an individual trace member over 16 MiB. |
| refresh-main-gateway-owner | Complete unchanged `browser-gateway.spec.ts`, one worker, in a fresh disposable profile | 13 passed, ten skipped, one failed, 124.2 s. The file-tree case passed, but narrow Repository settings still missed its 15-second click deadline. |
| refresh-main-registry | Flake-index consistency after reordering | Passed, 0.2 s |

The gateway owner ran with
`ORKESTRATOR_AGENT_TEST_PROFILE=refresh-main-007d-gateway` and run ID
`refresh-main-007d-gateway-owner`, using `bunx playwright test --config
e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts
--workers=1`. The profile was started with `mise run dev:test --profile
refresh-main-007d-gateway --fixture --no-agent-credentials
--agent-platforms codex`. Both it and the one-shot profile
`qa-browser-3f80afe1-9b8` were stopped and reset. No live launcher or
disposable profile state was retained.

Compressed logs below the host temporary directory:
`orkestrator-test-run.7Cy5zX/refresh-main-tests.log.gz` (group logs in
`orkestrator-test-run.ATUpLq`),
`orkestrator-test-run.t97qYk/refresh-main-agent-browser.log.gz`, and
`orkestrator-test-run.sthlts/refresh-main-gateway-owner.log.gz`. Browser
artifacts use `output/agent-testing/<run-id>/browser/`; oversized trace
content is removed by the sanitizer rather than kept unredacted.

The file-tree failure did not repeat, but the complete owner stayed
non-green, so this observation does not independently establish a flake.
The narrow navigation failure remains unresolved, matching 0494. No test
assertion, timeout, skip or product implementation was changed for either
result. Electron, Docker, CLI-scenario and iOS suites were omitted because
this refresh changes no corresponding runtime implementation. The billed
paused-interaction qualification remained opt-in; its credential-free helper
regressions ran in the focused and default suites.

**Warm complete-suite observation:** the same GNU-tool PATH with
`mise run test:logged -- --name refresh-main-warm-tests -- mise run test`
exited 1 after 490.4 seconds. Root/support, bridges, protocol and every
workspace package except backend passed. Backend failed only the known
receipt-fixture cleanup EPERM (0261); its complete unchanged owner passed
alone with the matching Node preload in 2.7 seconds. The first complete
observation passed every workspace package, so these are two different
recorded intermittent failures, not a claim that either aggregate was green.
Both required cold-enough and warm observations were completed. Evidence:
`orkestrator-test-run.520NxN/refresh-main-warm-tests.log.gz` with group
artifacts in `orkestrator-test-run.Xoy0uL`, below the host temporary directory.
Final registry, formatting, conflict-marker and local-link checks passed.
