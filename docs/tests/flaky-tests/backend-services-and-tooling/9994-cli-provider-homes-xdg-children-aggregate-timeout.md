# CLI provider-homes XDG case waits on the host's system mise config

- **ID:** 9994
- **Status:** open
- **Date observed:** 2026-11-11
- **Observing base:** `14df965440e658e09a7b3ce03530bc1781ac2b01` (`main`).
- **Observed head:** `e4777ac3a` on branch
  `terminal-event-reproduction-58a6a9a0fc85-r1`, and again at `13e4dd6ae` in
  that branch's review validation. The branch changes only documentation, two
  agent-testing Electron specs, the headless Electron spec list and its unit
  test; it touches nothing under `packages/cli/` or anything that file
  imports.
- **Test:** `preserves XDG-based Git, gh and mise configuration for backend children`
- **Owning file:** `packages/cli/tests/scenario-provider-homes.test.ts`
- **Original command:**
  `env -u NODE_ENV mise run test:logged -- --name review-default-tests-rerun2 -- mise run test`
  on beelink2 (Linux x86_64, 16 cores, Bun 1.4.4, mise 2026.11.3). The
  browser suite ran alongside it, and the host load average was 35 to 67 from
  other worktrees' suites.
- **Failure:** `this test timed out after 5000ms` at 5027.76 ms, followed by
  `killed 1 dangling process` and an unhandled error between tests at
  `scenario-provider-homes.test.ts:361`, `expect(mise.stderr).toBe("")`,
  which received:

  ```text
  mise WARN  Failed to resolve tool version list for amp: [/etc/mise/conf.d/omarchy-tools.toml] amp@latest: timed out after 3.00s
  ```

- **Aggregate:** the workspace group failed; CLI 516 pass, 1 fail; backend
  18,552 pass and 21 fail (all in the files of
  [9978](../coordinator-and-multi-review/9978-coordinator-wakes-and-git-mirror-timeouts-under-load.md));
  web 14,569 pass and 10 fail (all in the file of
  [9932](../native-agents-and-transcripts/9932-virtuoso-cancellation-fake-clock-timer-count.md)).
  The root, bridge, guard and lockfile groups passed.
- **Owning-file rerun:** the runner's own rerun reported `FAILED ALONE (5.7s)`
  with the same `mise WARN` in its stderr assertion. A later
  `env -u NODE_ENV mise run test:logged -- --name cli-provider-homes-alone -- bash -c 'cd packages/cli && bun test tests/scenario-provider-homes.test.ts'`
  passed (1.1 s), and the same command passed again (1.5 s) at a load average
  of about 37.
- **Recurrence:** the review validation of `13e4dd6ae`
  (`mise run test:logged -- --name review-default-tests -- mise run test`)
  failed the same way, at 5014.55 ms with the identical `amp@latest` WARN, and
  its runner rerun reported `FAILED ALONE (5.6s)`.
- **Evidence:** `orkestrator-test-run.avJa6A/review-default-tests-rerun2.log.gz`
  (aggregate) and
  `orkestrator-test-run.1CoA8i/rerun-packages-cli-tests-scenario-provider-homes-test-ts.log.gz`
  (runner rerun) under the host temporary directory. Every recorded failure
  of this case, aggregate and alone, carries the same WARN.

## Cause

The test runs a real, synchronous `spawnSync(mise, ["where", "bun"])` with
the environment `prepareIsolatedBackendEnvironment` builds. That environment
points `MISE_CONFIG_DIR` and `MISE_DATA_DIR` at the fixture, but mise also
loads its system configuration from `/etc/mise/conf.d/`. On beelink2 that
directory holds Omarchy's `omarchy-tools.toml`, which declares about thirty
tools at `version = "latest"`. The fixture's `HOME` is new on every run and
the test passes no cache directory, so mise's version cache is always cold and
`mise where bun` asks each tool's remote version index for its latest version.
Each lookup gives up after mise's 3 s `fetch_remote_versions_timeout`.

When a lookup is quick the call returns in under a second with empty stderr
and the test passes. When one is slow, mise prints the `Failed to resolve tool
version list` WARN, which fails `expect(mise.stderr).toBe("")`, and the
synchronous spawn blocks the event loop for at least 3 s of the test's
five-second budget, so the case also times out. Host load can make the lookup
slower, but it is not the cause: the slow request is a network call to the
version index that the test never meant to make.

## Reproduction

Reproduced on beelink2 on 2026-11-11 by running the same `mise where bun`
outside the test, with a fixture laid out as the test lays it out (a fresh
`HOME`, a `config.toml` pinning the running Bun, and an install symlink):

- With the network up and a cold cache: 0.77 s, then 0.03 s once the cache
  was warm. One earlier cold run printed the same `amp@latest ... timed out
  after 3.00s` WARN.
- With `HTTPS_PROXY`/`HTTP_PROXY` set to an unroutable address, so every
  version-index request hangs: 72 s and one WARN per `latest` tool in
  `/etc/mise/conf.d/omarchy-tools.toml`. The correct install path was still
  printed and the exit status was 0.
- The same unroutable proxy with `MISE_SYSTEM_CONFIG_DIR` (or
  `MISE_SYSTEM_DIR`) pointed at an empty directory: 0.02 s, empty stderr.
- The same unroutable proxy with `MISE_OFFLINE=1` instead: 0.02 s, but
  stderr still had a `no versions found` WARN per tool, so the assertion
  would still fail.

The test's `hostEnv` names only `HOME`, `PATH` and the XDG directories, so a
proxy cannot be injected through the test itself without editing it. To check
a fix, rerun the owning file at low load with the version index blocked (for
example with a firewall rule on the host) and confirm it fails with the same
stderr before the fix and passes after.

## Hypothesis and next step

Leading hypothesis: the failure depends on the host having a system mise
config with remote `latest` versions and on how quickly those version indexes
answer, not on the branch or on CPU load. Hosts without such a config (CI,
macOS without Omarchy) never make the request, which fits the case being seen
only on beelink2.

A fix belongs in the test, not the timeout: give the `mise where bun` spawn
`MISE_SYSTEM_CONFIG_DIR` pointing at an empty fixture directory, so it reads
only the XDG global config the test is about. That keeps the assertion on
empty stderr meaningful and removes the network call. It was not changed here,
because this branch does not otherwise touch `packages/cli/`; no test,
timeout, assertion or skip changed.
