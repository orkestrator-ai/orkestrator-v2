# Rootless start fixture automatic-port collision

- **ID:** 1011
- **Status:** resolved
- **Observed:** 2026-10-26, Linux rootless Docker 29.9.1, RootlessKit builtin port driver.
- **Test:** `two detached collision failures during restart preserve a later start's ports`
- **File:** `apps/backend/tests/container-start-docker.test.ts`

The owning file initially passed alone (three tests, 3.1 seconds). Running
it with `staged-input-relay-docker.test.ts` at `--parallel=2` failed before
fault injection: the fixture's bare initial `docker start` collided with a
real host listener on port 32883. Docker returned
`RootlessKit PortManager.AddPort(): … bind: address already in use` after
374.40 ms. The combined run had four passes and one failure (6.1 seconds).
Evidence: `/tmp/orkestrator-test-run.Y3dzrn`.

The fixture now starts through `startDockerContainer`, the production
bounded retry and network-repair path it is testing. No assertion or retry
budget changed. The complete owner passed (four tests, 4.5 seconds), then
both files passed together (five tests, 6.0 seconds) with the same daemon.

Both commands ran through `mise run test:logged` with
`RUN_LIVE_DOCKER_TESTS=1`, `RUN_ROOTLESS_MOUNT_TESTS=1`,
`ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-review-rootless:d03790` and the
disposable daemon's `DOCKER_HOST`:

```bash
bun test --cwd apps/backend ./tests/container-start-docker.test.ts --parallel=1
bun test --cwd apps/backend ./tests/container-start-docker.test.ts ./tests/staged-input-relay-docker.test.ts --parallel=2
```
