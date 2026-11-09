# User command concurrency test timeout

- **ID:** 9906
- **Status:** open
- **Date observed:** 2026-11-09

Test: `interactive commands > no more than four commands run at once in one tab`
in `apps/backend/src/core/user-commands.test.ts`.

Observed on `project-scheduling-ac146edab2ff-r1`, base
`3cf3dd7994cb36954f0670430216a71c7b6505d9`, while validating repairs after
`47342d9f57edde59ddb9a248d37d8be8c268bb52`. No existing group index entry
matches this test; this is a new observation, not a counted recurrence.

Original command: `mise run test:logged -- --name address-full-tests -- mise run test`.
The workspace group received five worker slots alongside root (one), bridges
(two) and protocol (one). A five-worker component browser suite was also running.
The test exceeded Bun's 5,000 ms deadline after 8,571.47 ms. The aggregate also
reported independent CLI readiness, Docker runtime and egress-cleanup failures,
and a DOM-absence guard violation in the new scheduling tests (subsequently
fixed). No complete aggregate count was available at the observation boundary.
Original evidence is the `workspace-web-backend-desktop-web-public-cli-protocol-toolchain`
log under `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.mX02WE/`.

Owning-file rerun:
`mise run test:logged -- --name user-commands-isolated -- bun --cwd=apps/backend test src/core/user-commands.test.ts --parallel=2 --only-failures`
passed unchanged in 4.6 s (exit 0). Passing output was removed by the logged
runner, so no isolated test total is claimed.

The failure is intermittent. Concurrent work was observed, but its cause is
unconfirmed; this isolated pass neither proves an environmental cause nor
replaces the failed aggregate. No assertion, implementation or timeout changed.
