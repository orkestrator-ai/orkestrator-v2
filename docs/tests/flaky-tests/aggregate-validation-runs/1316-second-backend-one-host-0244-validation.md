# Second backend on one host (todo 0244) branch validation

- **ID:** 1316
- **Status:** open
- **Date observed:** 2026-10-30
- **Branch:** `todo-0244-second-backend-one-host-1bf2521d817d`, base
  `cd7bbe3e5`. The branch changes the Control MCP port rule and bind retry
  (`control-mcp-server.ts`, `core/index.ts`, `data-dir.ts`), the instance
  descriptor (`packages/protocol/src/backend-instance.ts`,
  `instance-descriptor.ts`, `main.ts`), their tests and docs. No owner below
  changed or depends on those files.

## Run: `mise run test`

- **Host admission:** other worktrees' suites ran at the same time; load
  average 45 to 77 when the run finished. The groups finished in 740 s. The
  codex protocol lockfile group passed; the workspace, root and bridges groups
  each failed one test.
- **Evidence:** `orkestrator-test-run.6ZoAlz/` and
  `orkestrator-test-run.GJpNxY/` under the host temporary directory.

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | `a cold app-server child > an explicit refresh cannot replace the baseline for an already armed delay`: expected `stale`, received `ready` (80.7 ms). Recurrence of [0800](../agent-bridges/0800-codex-command-catalogue-armed-delay-race.md). | Passed alone (`bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=2`). |
| `tests/unit/disk-report.test.ts` | `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` timed out after 5,000 ms with a null subprocess status. Recurrence of [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md). | Failed the same way with `--parallel=2`; with `--parallel=1 --only-failures` it passed once (5.3 s) and timed out once (6.3 s) under the same load. |
| `apps/backend/tests/container-replacement-inputs.test.ts` | `migration binds fresh read-only Codex inputs and retains the source revision` timed out after 5,000 ms. | Passed alone (`bun test --cwd apps/backend ./tests/container-replacement-inputs.test.ts --parallel=2`, 2.6 s). |

The first aggregate run on this branch failed only the branch's own new
`control-mcp-port.test.ts` (a test race between the listener's `running` flag
and its state notification); the test now waits for the notification and
passed five solo runs. No implementation, assertion, wait, timeout or skip in
the owners above changed.


## Review fixes — 2026-10-30

Implementation commit `dd38d2ddf` fixes credential stability across bind retries,
refreshes mounted MCP settings on listener changes and stream resync, and
preserves Linux service `XDG_CONFIG_HOME`. Regression coverage also exercises
real Control MCP events during an in-flight descriptor write and shutdown,
late preview-port reservation, and the backend constructor's port ownership.

### Targeted validation

All passed through `test:logged`:

- Backend owners: `control-mcp-port.test.ts`, `control-mcp-server.test.ts`,
  `control-mcp-credentials.test.ts`, `index.test.ts`, `instance-descriptor.test.ts`,
  `instance-descriptor-publication.test.ts`, and `data-dir.test.ts` (119 tests).
- Renderer owner: `McpSettings.test.tsx`, including mounted recovery through
  both a state event and an event-stream resync.
- CLI owners: `service-command.test.ts`, `service-install.test.ts`, and
  `service-setup.test.ts`; packaged `read-only` CLI scenario.
- Backend, web and CLI package typechecks. Formatting and lint passed for
  the changed source/test files. Preparation's passing repository static checks
  and backend/renderer builds were not repeated.

### Exact default-suite rerun

`mise run test` failed after 600.3 s (including 61.4 s of host admission).
Backend (11,277 passed), web (10,839 passed), CLI, protocol, toolchain, public
web, bridges and protocol regeneration passed. Two unchanged owners failed:

| Owner | Aggregate failure | Complete isolated owner |
| --- | --- | --- |
| `tests/unit/disk-report.test.ts` | Five-second deadline at 5061.02 ms; null subprocess status and an error between tests. | `mise run test:logged -- --name disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` also failed (9 passed, 1 failed, 1 error; 6.4 s). |
| `apps/desktop/scripts/dev/bridge-builds.test.ts` | Successful-start fixture exceeded 15 s (15008.62 ms), followed by an ENOENT status write after fixture teardown. | `mise run test:logged -- --name bridge-builds-owner -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures` also failed (22 passed, 1 failed, 1 error; 15.6 s). |

These remain unresolved isolated failures in this run; no new flake
classification or cause is claimed. Existing histories are [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md)
and [1202](../electron-and-desktop/1202-bridge-build-startup-aggregate-timeout.md).
No implementation, assertion, timeout or skip in those owners changed.
Root/support totals were 3,305 passed, 1 failed and 1 error. Desktop totals
were 1,363 passed, 16 skipped, 1 failed and 1 error.

Evidence under the host temporary directory: `orkestrator-test-run.wGq5QV/`
(aggregate), `orkestrator-test-run.GkLQk1/` (disk-report owner), and
`orkestrator-test-run.gnz3av/` (desktop owner).


### Exact component-browser rerun

`mise run test:logged -- --name browser -- mise run test:browser` failed
(exit 1, 797.1 s): 972 passed, 106 skipped, 4 failed across 1,082 cases with
nine workers. E2E typechecking passed. Unchanged failures were both viewport
cases in `AgentLaunchDialog.spec.ts` (native branch suggestion stayed `rel`),
the mobile `DataSavingGateway.spec.ts` reconnect case (60 s deadline), and
desktop `VirtuosoFollow.spec.ts` re-engagement (`false` instead of `auto`).
The command's public-site leg was not reached after the component failure.
Evidence: `orkestrator-test-run.Frb08t/browser.log.gz` under the host temporary
directory. None of these owners imports the changed MCP settings component.


The first branch-picker and data-saving owner commands overlapped and shared
Playwright's output directory; those two results are not used as isolated
proof. They were rerun sequentially. The complete branch-picker owner still
failed unchanged (2 passed, 2 failed, exit 1; 24.4 s):

```sh
mise run test:logged -- --name branch-picker-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1
```

Evidence: `orkestrator-test-run.R2Tq1i/branch-picker-owner.log.gz` under the
host temporary directory. Both failures retained the `rel` value; no new
flake classification is claimed for that owner.


The sequential complete data-saving owner passed both viewport cases unchanged
(exit 0, 32.7 s):

```sh
mise run test:logged -- --name data-saving-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1
```

This confirms a recurrence of [1310](../previews-annotations-and-gateway/1310-data-saving-gateway-browser-timeout.md);
the cause remains unconfirmed.


The sequential complete transcript-follow owner also passed unchanged
(two desktop passes, two existing mobile skips; exit 0, 4.1 s):

```sh
mise run test:logged -- --name transcript-follow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1
```

This confirms the existing re-engagement intermittence in [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md).
The full component command remains non-green.


### Exact isolated-stack rerun

`mise run test:agent:browser:isolated` failed (exit 1, 861.4 s overall;
43 passed, 74 skipped, 1 failed). The unchanged capped-file-tree case in
`e2e/agent-testing/browser-gateway.spec.ts:736` exceeded 120 s while expanding
`src` at line 824. The previously failing CLI-initialized-project case passed.
Global teardown also reported an `ArtifactBoundError`: the failed file-tree
trace exceeded the 16 MiB sanitization limit. This is an additional validation
error; raw artifacts were not opened or attached. No isolated pass or flake
classification is claimed for the file-tree failure.

The wrapper successfully stopped and reset its exact disposable profile
`qa-browser-ce3bc633-6a7`, removing its profile state. Test artifacts are under
`output/agent-testing/qa-browser-ce3bc633-6a7/browser/artifacts/`; they remain
outside Git. No owning implementation, assertion, timeout, skip or sanitizer
bound changed. Broad default and browser validation remain non-green despite
the passing changed-area checks.
