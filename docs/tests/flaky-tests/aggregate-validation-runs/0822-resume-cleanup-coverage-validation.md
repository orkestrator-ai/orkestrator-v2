# Resume cleanup coverage validation

- **ID:** 0822
- **Status:** open
- **Observed:** 2026-10-25
- **Implementation commit:** `126c0961`

The change preserves historical Claude launches when task IDs are recovered
after resume cleanup and adds notice grouping and controller ordering coverage.
The final focused adapter, pinning and controller run passed 269 tests. The
complete final web package passed (`cleanup-web-final`, 549.5 s), as did
formatting, lint, typechecking and the public-site browser suite
(`cleanup-public-browser`, 50.9 s).

## Repository validation

Command: `mise run test:logged -- --name cleanup-repository -- mise run test`.
Workspace/root/bridge/protocol worker reservations were 4/1/2/1; the component
browser suite also ran on this host. The aggregate finished in 1,316.2 s with
workspace, root and bridge groups failed; the protocol lockfile check passed.
Backend counts were 11,244 passed, 120 skipped and four failed across 668 files
(1,056.50 s). Root/support reported 3,415 passed, two failed and one between-test
error across 162 files (515.96 s).

| Owner and failure | Unchanged owner rerun |
| --- | --- |
| Codex command catalogue expected `stale`, received `ready` | Passed in 2.1 s; [0800](../agent-bridges/0800-codex-command-catalogue-armed-delay-race.md). |
| Firewall policy-2 host-port fixture exceeded five seconds | Passed in 37.3 s; [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md). |
| Disk report exceeded five seconds and produced a between-test error | Passed in 5.4 s; [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md). |
| Mermaid watchdog measured 6,135 ms against `< 5,000 ms` | Failed again at 7,281 ms; 12 passed, one failed. See [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md). |
| `apps/backend/tests/container-log-service.test.ts`: `bounded bridge output > the writer stays bounded on output without a single newline` and `the writer rotates by size, keeps N files and cuts oversize lines` found no log files | Both failed again, nine passed and two failed in 7.02 s. |
| `apps/backend/src/core/container-worktree-signal-install.test.ts`: `orkestrator-worktree-signal > start writes a private config from stdin and launches the watcher` expected `lost, ready`, received only `lost` (1,505.45 ms) | Complete unchanged owner passed (exit 0, 80.1 s); confirms an intermittent failure without establishing its cause. |

The first aggregate also loaded an earlier adapter implementation before the
agent-lifecycle regression was added during editing. That regression failed in
the in-flight run; the final focused run and fresh complete web-package run
passed after the implementation was finalized. This is not classified as a
flake.

Additional owner commands:

```sh
mise run test:logged -- --name cleanup-container-log-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-log-service.test.ts --parallel=1 --only-failures
mise run test:logged -- --name cleanup-worktree-signal-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-worktree-signal-install.test.ts --parallel=1 --only-failures
```

## Component browsers

`mise run test:logged -- --name cleanup-browser -- mise run test:browser` ran
842 component cases with five workers: 734 passed, 102 skipped and six failed
(18.9 minutes). The public-site suite did not run after the component failures;
its separate complete rerun passed.

| Failed test and viewport | Original symptom |
| --- | --- |
| `e2e/CodexSubagentCards.spec.ts:163`, `Codex sub-agent cards stay one per child through reload and a cold restart`, mobile | Grace explorer card count was zero instead of one at the five-second deadline. |
| `e2e/DesignCanvas.spec.ts:9`, `canvas edits, script isolation, missed events, conflict and reload`, mobile | Thirty-second deadline at replacement iframe CSS assertion; [0174](../design-canvas-and-artifacts/0174-design-canvas-parallel-browser-timeout.md). |
| `e2e/KeyboardShortcuts.spec.ts:75`, `Meta shortcut wins over Monaco Delete Line`, mobile | Monaco textbox missing at five seconds; [0792](../web-ui/0792-keyboard-shortcuts-monaco-startup.md). |
| `e2e/PaneBreakpoint.spec.ts:98`, `split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore)`, mobile | Terminal count zero instead of one at five seconds; [0342](../web-ui/0342-pane-breakpoint-terminal-startup.md). |
| `e2e/ToolGroupFold.spec.ts:442`, `a waiting group that fits its cap follows appended calls as it starts overflowing`, desktop | Inner scrollTop was 704 instead of zero; [0747](../web-ui/0747-tool-group-overflow-follow.md). |
| `e2e/AgentLaunchDialog.spec.ts:7`, `selects a native branch suggestion with the keyboard and confirms`, desktop | Branch value remained `rel` instead of `release/2.0`. |

The complete six owning files were rerun sequentially with one worker:

```sh
mise run test:logged -- --name cleanup-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/CodexSubagentCards.spec.ts e2e/DesignCanvas.spec.ts e2e/KeyboardShortcuts.spec.ts e2e/PaneBreakpoint.spec.ts e2e/AgentLaunchDialog.spec.ts e2e/ToolGroupFold.spec.ts --workers=1
mise run test:logged -- --name cleanup-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts
```

The rerun finished in 307.4 s: 80 passed, one skipped and three failed.
CodexSubagentCards, DesignCanvas, KeyboardShortcuts and PaneBreakpoint passed
across both viewports. The missing Codex Grace card therefore did not reproduce
in the complete unchanged owner rerun; its cause is unestablished. The native
branch suggestion still failed on both viewports, and the desktop tool-group
case still received 704 instead of zero. Those owner results remain failed;
neither is newly classified as flaky from this observation.

## Evidence

Artifact paths are below the host temporary directory:

- Repository groups: `orkestrator-test-run.TabHxj/`; outer log: `orkestrator-test-run.FoXYCv/cleanup-repository.log.gz`.
- Component browser aggregate: `orkestrator-test-run.lCCXje/cleanup-browser.log.gz`.
- Sequential complete browser owners: `orkestrator-test-run.h7cRtQ/cleanup-browser-owners.log.gz`.
- Mermaid owner: `orkestrator-test-run.UuiUGe/cleanup-mermaid-owner.log.gz`.
- Container log owner: `orkestrator-test-run.36lJ1k/cleanup-container-log-owner.log.gz`.

No unrelated implementation, assertion, timeout or skip was changed. The
aggregate results remain non-green; passing owner reruns do not turn those
results into passing aggregate runs.
