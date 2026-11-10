# User command concurrency test timeout

- **ID:** 9910
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

## Worktree-watcher review recurrence — 2026-11-10

Observed in `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`, base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`, macOS arm64/Bun 1.4.4. The workspace reserved six slots (web two, backend four), root one, bridges two and protocol one. The aggregate exited 1 after 2468.77 s; backend has no final counts because the workspace no-progress watchdog fired. Root reported 4274 pass/25 skip/4 fail; web 14336 pass/10 skip/2 fail; Pi 706 pass/1 skip/2 fail.

- `apps/backend/src/core/user-commands.test.ts` — `interactive commands > no more than four commands run at once in one tab`: Test deadline 5,000 ms exceeded. Observed 8916.39ms. Complete unchanged owner: 22 pass, 0 fail, 0 skip in 9.19 s at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.

```sh
mise run test:logged -- --name watcher-triage-user-commands -- bun test --cwd apps/backend ./src/core/user-commands.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/user-commands.xml
```

`mise run flaky:recurrence -- 9910 --base 08d3da4a23cfe2ecc34fba663ca27e765f7924a9 --registry-ref origin/main` reported the case open; this records a recurrence.

Evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/` (compressed group logs); JUnit under `/private/tmp/ork-watcher-failure-triage.0oarZv/`. [The complete report](../../../development/worktree-watcher-validation.md) contains the exact group outcomes, commands and non-green isolated owners. Passing alone establishes intermittence, not a cause or a fix. No related assertion, timeout, skip or implementation changed.
