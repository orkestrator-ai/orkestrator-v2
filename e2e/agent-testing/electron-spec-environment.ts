/**
 * The environment every Electron spec launches the app with.
 *
 * Each spec runs on a fresh temporary profile, so a Local backend it starts
 * would run the Linux boot-time container reachability probe for a Docker
 * owner that never runs again. A backend that dies mid-probe leaks that
 * owner's `ork-<owner>-reach-probe-net`, which holds one of the daemon's
 * address pools and that no backend's own reaper revisits (todo 7470, 7041).
 * On a host whose firewall drops Docker's traffic to the host, the probe's
 * "Docker containers can't reach Orkestrator" modal also opens over whatever
 * step is running (flake 4250).
 *
 * So the probe is `off` unless the spec itself asks for another value through
 * `overrides`, as the CLI harnesses do (`packages/cli/scenarios/provider-homes.ts`).
 * A value inherited from the runner's own environment does not count: a shell
 * on this host may carry anything, and the default must not depend on it.
 * The desktop passes the variable through to agent-test backends
 * (`AGENT_TEST_SAFE_ENV_NAMES` in `apps/desktop/electron/backend-process.ts`).
 *
 * `tests/unit/electron-spec-environment.test.ts` fails on an `electron.launch`
 * under `e2e/agent-testing/` whose `env` is not built here (or by
 * `packagedLaunchEnvironment`, which calls this).
 */
export const HOST_REACHABILITY_CHECK_ENV = "ORKESTRATOR_HOST_REACHABILITY_CHECK";

export function electronSpecEnvironment(
  base: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && name !== HOST_REACHABILITY_CHECK_ENV) result[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[name];
    else result[name] = value;
  }
  result[HOST_REACHABILITY_CHECK_ENV] = overrides[HOST_REACHABILITY_CHECK_ENV] ?? "off";
  return result;
}
