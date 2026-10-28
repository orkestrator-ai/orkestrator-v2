# Verification evidence review validation

- **ID:** 1252
- **Status:** open
- **Date observed:** 2026-10-28
- **Command:** `mise run test:logged -- --name review-fixes-default -- mise run test`
- **Revision:** `f2a6e7f0c` plus the verification prompt/test changes subsequently
  committed as `9b604e9f9`. No failing owner listed below was changed.
- **Workers:** workspace 6 slots (backend up to 4), root 1, bridges 2 (one per
  package), protocol 1. All groups started without a capacity wait.
- **Evidence:** host temporary directories `orkestrator-test-run.fCbwjs`
  (`summary.json` and compressed group logs) and `orkestrator-test-run.rfHYPU`
  (`review-fixes-default.log.gz`, outer logged command).

The root group reported 3,233 pass and 8 fail across 158 files in 978.71 s.
The bridge group was incomplete after 738.1 s: after reporting four test
failures, it produced no output for 300 s and its watchdog terminated the
remaining Pi task. The protocol lockfile check passed in 1.6 s. The aggregate
exited 1 after 994.8 s (996.0 s including the outer logged runner).

The workspace group failed only in the web virtualizer owner below (web:
10,195 pass, 10 skip, 1 fail across 646 files). Backend passed: 10,052 pass,
87 skip, 0 fail across 658 files, including the repaired verification-evidence
assertion. Desktop, public web, CLI, protocol and toolchain tests also passed.
Completed bridge packages reported: Codex 2,236 pass / 51 skip / 0 fail;
Claude 1,691 pass / 8 skip / 1 fail; ACP 440 pass / 3 skip / 0 fail;
Cursor 797 pass / 3 fail. Pi has no completed result from this run.

| Complete unchanged owner | Aggregate failure | Individual logged rerun |
| --- | --- | --- |
| `tests/unit/flaky-tests-index.test.ts` | Seven `flaky test register > <group> index lists every case file and stores a status for each row` cases exceeded their 5,000 ms deadline: agent-bridges (182,162.79 ms), aggregate-validation-runs (166,623.96 ms), backend-services-and-tooling (141,590.71 ms), coordinator-and-multi-review (109,907.66 ms), design-canvas-and-artifacts (46,171.56 ms), electron-and-desktop (45,831.44 ms), environments-and-containers (65,561.80 ms). | Passed, exit 0 (2.5 s). |
| `tests/unit/docs/upgrade-agents-docs.test.ts` | `agent upgrade runbook contracts > no tracked file anywhere still references the removed Codex guide` exceeded 5,000 ms (5,036.82 ms). | Passed, exit 0 (1.6 s). |
| `apps/web/src/lib/transcript-scroll/virtuoso-cancellation.test.tsx` | `firstItemIndex with the real virtualizer > rows keep local indices and identity across two prepends` exceeded 5,000 ms (5,002.72 ms). | Passed, exit 0 (12.5 s). |
| `bridges/claude-bridge/src/services/session-manager-transcript-v2.test.ts` | `Claude: shared v2 transcript contract > a restarted bridge never honours a token or cursor from the previous process` exceeded 5,000 ms (5,002.66 ms). | Passed, exit 0 (0.5 s). |
| `bridges/cursor-bridge/src/mcp.test.ts` | `Cursor MCP inventory > a read-only policy returns only the Orkestrator entry when project MCP is present` exceeded 5,000 ms (5,002.39 ms). | Passed, exit 0 (1.0 s). |
| `bridges/cursor-bridge/src/agent-session.test.ts` | `ensureAgent > a read-only attach drops repository MCP servers even when project resources are on` exceeded 5,000 ms (5,002.92 ms). | Passed, exit 0 (0.7 s). |
| `bridges/cursor-bridge/src/build-output.test.ts` | `the built bundle > the vendored Bun export exposes the diagnostic seam` exceeded 5,000 ms (23,003.79 ms). | Passed, exit 0 (0.4 s). |

Exact individual rerun commands (each owner ran in its own Bun process):

```sh
mise run test:logged -- --name registry-owner -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures
mise run test:logged -- --name upgrade-docs-owner -- bun test ./tests/unit/docs/upgrade-agents-docs.test.ts --parallel=1 --only-failures
mise run test:logged -- --name virtualizer-owner -- bun test --cwd apps/web ./src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name claude-transcript-owner -- bun test --cwd bridges/claude-bridge ./src/services/session-manager-transcript-v2.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
mise run test:logged -- --name cursor-mcp-owner -- bun test --cwd bridges/cursor-bridge ./src/mcp.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
mise run test:logged -- --name cursor-attach-owner -- bun test --cwd bridges/cursor-bridge ./src/agent-session.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
mise run test:logged -- --name cursor-bundle-owner -- bun test --cwd bridges/cursor-bridge ./src/build-output.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

These passes establish intermittent failures in unchanged owners; they do not
make the aggregate green or qualify the unfinished Pi task. The extreme
registry read durations suggest filesystem or scheduling delays, but their
cause was not established. No assertion, timeout or skip was changed in these
owners. The prompt, supervisor and verification-evidence tests, changed-file
formatting/lint and backend typechecks passed separately.
