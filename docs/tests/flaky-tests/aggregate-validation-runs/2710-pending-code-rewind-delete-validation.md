# Pending code rewind delete (todo 2120) branch validation

- **ID:** 2710
- **Status:** open
- **Date observed:** 2026-11-02
- **Scope:** branch `pipeline-code-rewind-dff407190fa7-r1`, which changes only
  `apps/backend/src/core/build-pipeline-context.ts`,
  `apps/backend/src/core/build-pipeline-service-lifecycle.ts`, their rewind
  test and documentation. No desktop, web or root test owner and no terminal
  code changed.
- **Original command:** `mise run test` (default suite, default worker
  counts) at commit `7414ea213`, run by review preparation while about ten
  other builds shared the host. Exit 1 after 1447.9 s; bridges and the codex
  protocol lockfile group passed.
- **Evidence:** `orkestrator-test-run.Ae16GM/` below the host temporary
  directory (`workspace-…log.gz`, `root-and-agent-support-tests.log.gz`).

## Failures that also fail on `main`

Rerun alone on the branch (`0806109c5`) and in a detached checkout of
`origin/main` at `38d55ee14`, both with
`mise run test:logged -- --name … -- sh -c "cd apps/web && bun test ./src/stores/terminalPortalStore.test.ts --parallel=1"`
and
`mise run test:logged -- --name … -- bun test ./tests/unit/components/ClaudeTmuxInteractiveTerminal.test.tsx --parallel=1`.
Both checkouts fail the same tests, so these are deterministic failures on
`main`, not flakes and not caused by this branch:

| Test | Owning file |
| --- | --- |
| `terminal plain URL addon link routing > routes shifted Control-clicks to an internal browser request` | `apps/web/src/stores/terminalPortalStore.test.ts` |
| `terminal plain URL addon link routing > routes shifted Command-clicks to an internal browser request` | `apps/web/src/stores/terminalPortalStore.test.ts` |
| `terminal OSC 8 constructor option link routing > routes shifted Control-clicks to an internal browser request` | `apps/web/src/stores/terminalPortalStore.test.ts` |
| `terminal OSC 8 constructor option link routing > routes shifted Command-clicks to an internal browser request` | `apps/web/src/stores/terminalPortalStore.test.ts` |
| `ClaudeTmuxInteractiveTerminal > registers OSC 8 routing for modifier {"ctrlKey":true} with source identity` | `tests/unit/components/ClaudeTmuxInteractiveTerminal.test.tsx` |
| `ClaudeTmuxInteractiveTerminal > registers OSC 8 routing for modifier {"metaKey":true} with source identity` | `tests/unit/components/ClaudeTmuxInteractiveTerminal.test.tsx` |
| `ClaudeTmuxInteractiveTerminal > reports a missing environment without creating a terminal session` | `tests/unit/components/ClaudeTmuxInteractiveTerminal.test.tsx` |

## Failures that passed when the owning file was rerun alone

| Test | Owning file | Failure | Existing case | Isolated rerun |
| --- | --- | --- | --- | --- |
| `design service startup > removes the recorded profile of a backend that was killed` | `apps/backend/src/core/design/browser-profiles.test.ts` | Ledger entry still present after profile deletion | 1314 | passed on the branch |
| `Codex sub-agent cards through the bridge and backend projection > each child keeps one card, its transcript and status across a fresh backend and a cold restart` | `apps/backend/tests/codex-subagent-cards.test.ts` | Child cards not yet projected | 0310 | passed on the branch |
| `OpenCode agent-tool configuration > reconciles in the background and memoizes a healthy generation` | `apps/backend/src/core/commands-agent-tools.test.ts` | Configuration count 1 after the fixed 150 ms wait | 0280, 0320 | passed on the branch |
| `a stream that stops its keepalives, or an attempt nothing answers, is given up on` | `apps/desktop/tests/backend-event-stream.test.ts` | `ERR_INVALID_STATE: Controller is already closed` at line 196 | 2409, 2411 | failed once alone on the branch, then passed three times; on `main` failed one of three alone runs |

None of these files imports build-pipeline code. The backend reruns used
`mise run test:logged -- --name branch-<file> -- sh -c "cd apps/backend && bun test --preload ../../tests/setup-node.ts ./<file> --parallel=1"`
(exit 0 each).

The keepalive test races a 40 ms silence limit against 20 ms keepalive ticks.
At a host load average near 46, the same unchanged file failed alone on
`main` (`38d55ee14`, run 1 of 3: states were `["open", "closed"]` at line 199,
the same early close seen from the other side) and on the branch (run 1 of 4,
the line 196 enqueue into the closed controller). This reproduces the timing
failure on the target branch; it is not caused by this change.
