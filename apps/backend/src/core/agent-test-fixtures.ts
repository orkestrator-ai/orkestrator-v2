import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Markers a real-browser spec writes into an agent-test profile's data
 * directory to stage a failure on demand. Nothing outside an agent-test
 * backend (`ORKESTRATOR_AGENT_TEST_ISOLATED=1`) reads them.
 */
export const TERMINAL_SURVIVAL_FIXTURE_DIR = path.join(
  "agent-test-fixtures",
  "terminal-survives-terminate",
);

const ENVIRONMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * While `<data dir>/agent-test-fixtures/terminal-survives-terminate/<environment
 * id>` exists, that environment's terminals are left running when a delete
 * terminates them and are reported as survivors, so the delete fails the way
 * a process outliving SIGKILL makes it fail. Removing the marker lets the
 * next attempt terminate them for real. `undefined` outside agent-test
 * profiles, so production never consults the directory.
 */
export function agentTestTerminalSurvival(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ((environmentId: string) => boolean) | undefined {
  if (env.ORKESTRATOR_AGENT_TEST_ISOLATED !== "1") return undefined;
  const directory = path.join(dataDir, TERMINAL_SURVIVAL_FIXTURE_DIR);
  return (environmentId) =>
    ENVIRONMENT_ID.test(environmentId) && existsSync(path.join(directory, environmentId));
}
