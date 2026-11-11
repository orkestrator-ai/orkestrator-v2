# Scenario provider homes: host mise warning breaks an empty-stderr assertion

- **ID:** 9980
- **Status:** open
- **Date observed:** 2026-11-11
- **Test:** `preserves XDG-based Git, gh and mise configuration for backend children`
- **File:** `packages/cli/tests/scenario-provider-homes.test.ts:361`

## Observation

- **Branch and base:** `backend-domain-restructure-13639d788e59-r1` at
  `98f77e1d0`, base `14df965440e658e09a7b3ce03530bc1781ac2b01`. The branch
  moves backend web-annotation modules and edits docs and a codemod script;
  it touches nothing under `packages/cli`.
- **Command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  (Linux x86_64, Bun 1.4.4), with 14 to 16 of 16 scheduler slots reserved
  and a 15-minute load average of about 45 on 16 cores.
- **Failure:** the test timed out at 5,000 ms (5,014 ms) and an unhandled
  error followed: `spawnSync(mise, ["where", "bun"])` returned stderr
  `mise WARN  Failed to resolve tool version list for amp: [/etc/mise/conf.d/omarchy-tools.toml] amp@latest: timed out after 3.00s`,
  so `expect(mise.stderr).toBe("")` failed. The runner also reported
  `killed 1 dangling process`.
- **Suite counts:** CLI 516 pass, 8 skip, 1 fail, 1 error (525 tests across
  39 files, 13.2 s).
- **Isolated rerun:** `NODE_ENV=test bun test --preload ../../tests/setup-node.ts ./tests/scenario-provider-homes.test.ts --parallel=1`
  from `packages/cli`, through `test:logged`: passed (1.2 s).

## Hypothesis

Unconfirmed: the test runs the real `mise`, which reads the host's
system-wide config (`/etc/mise/conf.d/`). That config names an `@latest`
tool; resolving it needs a remote version list, which mise gives up on after
3 s and reports as a warning on stderr. Under load or a slow network the
lookup misses its deadline, which also pushes the test past its 5 s budget.
The assertion that stderr is empty then depends on the host's mise config and
network rather than on the code under test.

## Next evidence

Confirm by running the test with the network blocked or with a slow
`amp@latest` lookup. If confirmed, isolate the child from system-wide mise
config (for example a `MISE_SYSTEM_CONFIG_DIR` or `MISE_CONFIG_DIR` pointing at
the test's temporary home) rather than loosening the stderr assertion.
