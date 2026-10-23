# MCP environment delivery (0040) validation under aggregate load

- **ID:** 0720
- **Status:** open
- **Date observed:** 2026-10-23.
- **Baseline:** `062971245`, with the todo 0040 environment-overlay changes in the working tree.
- **Original command:** `mise run test` (default aggregate allocation). A
  background agent was editing `apps/web/**` during the run, and other
  checkouts on the host were running Docker qualification, image builds and
  their own suites. Contention is a hypothesis, not an established cause.
- **Aggregate result:** failed. The Codex protocol lockfile group passed; the
  bridges (200.6 s), root and agent-support (416.2 s) and workspace (1,764.6 s)
  groups failed. The raw log was not kept.

## Failures and complete owner reruns

None of the failing owner files, or the code they test, is touched by this
change. Each owner was rerun alone with `bun test` on its own path, from the
owning package directory.

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `bridges/acp-bridge/src/acp-test-harness.test.ts` | `ACP test harness child tracking > awaits and deregisters live and already-exited children before deleting fixtures` (13.9 ms). | 1 pass, 0 fail. |
| `apps/desktop/electron/application-logging.test.ts` | `application logging shutdown > holds the quit open until the flush completes, then quits once` (73.4 ms). | 25 pass, 0 fail. |
| `apps/desktop/tests/backend-lifecycle.test.ts` | `desktop backend lifecycle > quits anyway when the backend outlives its exit deadline` (120.0 ms). | 5 pass, 0 fail. |
| `tests/unit/disk-report.test.ts` | `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` hit the five-second deadline (5,027 ms). | The first rerun failed one case. The next three complete reruns each gave 5 pass, 0 fail. |
| `apps/backend/src/core/environment-move.test.ts` | `move_environment > a failed submodule re-link restores the original checkout` hit the deadline (5,154.8 ms). | 37 pass, 0 fail. |
| `apps/backend/src/core/agent-skills.test.ts` | `scanAgentSkills > bounds entries per root and total skills across plugin roots` (6,476.6 ms). | 86 pass, 0 fail. |

Existing related cases:

- [ACP harness 0179](../agent-bridges/0179-acp-harness-child-exit-publication.md)
- [agent skills 0212](../backend-services-and-tooling/0212-agent-skills-hook-timeout.md)
- [disk report 0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md)
- [environment move 0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md)

The two desktop shutdown cases have no earlier case.

These owner passes show the aggregate failures are intermittent in this run.
They do not make the original aggregate exit green.
