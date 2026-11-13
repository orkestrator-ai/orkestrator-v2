# Integrate review validation intermittence

- **ID:** 5362
- **Status:** open
- **Observed:** 2026-11-05, Integrate branch at `d96a45c1c`.

The exact preparation rerun was `mise run test:logged -- --name review-default-tests -- mise run test`.
Workspace/root/bridge/protocol reservations were 6/1/2/1; the groups waited about
1,200 seconds for the shared exclusive resource. Final suite totals were not
available at the time these isolated reruns finished.

Two complete unchanged owners failed in the aggregate and passed alone:

| Test | Aggregate failure | Isolated rerun |
| --- | --- | --- |
| `the resumable session list > a timeout is reported, not an empty history, and stops the read`, `bridges/pi-bridge/src/session-list-cache.test.ts:165` | Expected `signal?.aborted` true, received undefined; 41.86 ms | `mise run test:logged -- --name pi-list-isolated -- bun test --cwd=bridges/pi-bridge --preload ./src/testing/test-isolation.ts ./src/session-list-cache.test.ts --parallel=1 --only-failures`: exit 0, 2.2 s |
| `what a renderer's console can place in the saved log > no renderer logger uses the area whose lines read as markers`, `apps/desktop/tests/renderer-diagnostics.test.ts` | Exceeded 5,000 ms at 6,260.38 ms | `mise run test:logged -- --name renderer-diagnostics-isolated -- bun test --cwd=apps/desktop --preload ../../tests/setup-node.ts ./tests/renderer-diagnostics.test.ts --parallel=1 --only-failures`: exit 0, 1.1 s |

Evidence: inner `bridges.log` and `workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
in `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.tjKud0/`;
the outer run is `orkestrator-test-run.lBswTp/review-default-tests.log` in the same parent.
The logged runner compresses failing logs on completion. The Pi owner and its
implementation are unchanged by the branch. The diagnostics owner scans renderer
sources, including changed files; its isolated pass establishes intermittence,
not a proven root cause. Scheduling delay under host contention is a hypothesis.
No assertions, deadlines, or skips were changed.

The logging-shutdown recurrence is recorded in case 0712. The standalone installer
failure also reproduces alone and is **not** classified as a flake here.

## Final aggregate and root-owner results

The aggregate exited 1 at its 1,800-second deadline, terminating the unfinished
workspace group. Protocol lockfile passed; bridges and root groups failed. Root
reported 3,594 passes and three failures across 182 files. Final workspace totals
are unavailable. The original preparation artifacts were preserved; the rerun's
outer compressed artifact is `orkestrator-test-run.lBswTp/review-default-tests.log.gz`.

Two more complete owners passed alone after root aggregate scan timeouts:

- `MCP fixture cleanup contract > every test importing createFixture from MCP test-support awaits or returns cleanup`, `tests/unit/mcp-fixture-cleanup.test.ts`: aggregate 7,451.20 ms, 5,000-ms deadline. `mise run test:logged -- --name mcp-fixture-isolated -- bun test ./tests/unit/mcp-fixture-cleanup.test.ts --parallel=1 --only-failures` passed (5.3 s logged).
- `raw console > no linted source holds a raw console site`, `tests/unit/raw-console.test.ts`: aggregate 10,279.51 ms, 5,000-ms deadline. `mise run test:logged -- --name raw-console-isolated -- bun test ./tests/unit/raw-console.test.ts --parallel=1 --only-failures` passed (10.3 s logged).

These are intermittent scan timeouts; the raw-console owner reads changed source
files, so its isolated pass is the evidence, rather than an unrelated-code claim.

`tests/unit/workspace-setup-git-mirror.test.ts` failed the aggregate's fallback
clone test at 8,304.65 ms. Its complete isolated rerun
`mise run test:logged -- --name git-mirror-isolated -- bun test ./tests/unit/workspace-setup-git-mirror.test.ts --parallel=1 --only-failures`
also failed (0 pass, 15 fail, 78.5 s), repeatedly timing out in fixture Git pushes
and commits. It is **not** classified as a flake or excused here. Evidence:
`orkestrator-test-run.IsEWfZ/git-mirror-isolated.log.gz` under the same temporary parent.

## Recurrence (2026-11-13)

- **Base:** `17d28238c098b4443d1289df5c4ed75e7cc2802e`; `mise run flaky:recurrence -- 5362 --base 17d28238c --registry-ref origin/main` answered open.
- **Observed head:** branch `remove-dead-bridge-be98778b92d1-r1` at `16561abbc`
  (7571 removals). It does not touch `tests/unit/raw-console.test.ts` or the
  lint rule it drives.
- **Test:** `raw console lint rule > rejects console in apps/web-public/src/probe.ts, used directly or passed as a value`
  (`tests/unit/raw-console.test.ts`): exceeded its 5,000 ms deadline at
  5,036.10 ms.
- **Command:** `mise run test:logged -- --name review-default-tests-rerun2 -- mise run test`
  on Linux while other worktrees' aggregates held host slots. The root group
  reported 4484 pass, 1 skip and 23 fail across 254 files; the other 22 were
  `tests/unit/components/ClaudeTmuxChatTab.test.tsx`, caused by the branch and
  fixed in it. The workspace group was cut off by the 1,800 s deadline.
- **Isolated rerun:** `mise run test:logged -- --name raw-console -- bun test tests/unit/raw-console.test.ts --parallel=1 --only-failures`
  passed in 3.3 s.
- **Evidence:** inner `root-and-agent-support-tests.log` in
  `orkestrator-test-run.Lm95pw/` under the host temporary directory.
