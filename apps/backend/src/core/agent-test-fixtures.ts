import { existsSync } from "node:fs";
import path from "node:path";
import { isDefaultDataDir } from "../data-dir.js";

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

/**
 * The loopback origin an agent-test profile's backend reads Claude and Codex
 * plan usage from instead of the providers' hosts (to-do 7542 task 1), so a
 * two-backend spec can script usage readings for fixture accounts without
 * sending their tokens to Anthropic or OpenAI.
 *
 * Set by the spec as `ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN`
 * (`http://127.0.0.1:<port>`). Honoured only in an isolated agent-test
 * backend (runtime flavor `agent-test`, `ORKESTRATOR_AGENT_TEST_ISOLATED=1`,
 * a data directory that is not the default one) and only for a bare loopback
 * origin; anything else answers `undefined` and the real endpoints are used.
 */
export const AGENT_TEST_USAGE_ORIGIN_ENV = "ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface AgentTestOriginOptions {
  runtimeFlavor?: string;
  dataDir: () => string;
  env?: NodeJS.ProcessEnv;
}

/**
 * A loopback origin named by `name`, honoured only in an isolated agent-test
 * backend (see `agentTestUsageOrigin`); `undefined` everywhere else.
 */
function agentTestLoopbackOrigin(
  name: string,
  options: AgentTestOriginOptions,
): string | undefined {
  const env = options.env ?? process.env;
  if (options.runtimeFlavor !== "agent-test") return undefined;
  if (env.ORKESTRATOR_AGENT_TEST_ISOLATED !== "1") return undefined;
  const raw = env[name];
  if (!raw) return undefined;
  if (isDefaultDataDir(options.dataDir(), process.platform, env)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return undefined;
  // An origin only: no credentials, path, query or fragment to smuggle in.
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url.origin;
}

export function agentTestUsageOrigin(options: AgentTestOriginOptions): string | undefined {
  return agentTestLoopbackOrigin(AGENT_TEST_USAGE_ORIGIN_ENV, options);
}

/**
 * The loopback Anthropic Messages origin every Claude bridge an isolated
 * agent-test backend starts is pointed at (`ANTHROPIC_BASE_URL`), so a
 * coordinator's Claude, whose private configuration directory never holds the
 * user's `settings.json`, runs on a scripted model too (to-do 7542). Set by
 * the spec as `ORKESTRATOR_AGENT_TEST_ANTHROPIC_ORIGIN`, under the same gate as
 * `agentTestUsageOrigin`.
 */
export const AGENT_TEST_ANTHROPIC_ORIGIN_ENV = "ORKESTRATOR_AGENT_TEST_ANTHROPIC_ORIGIN";

export function agentTestAnthropicOrigin(options: AgentTestOriginOptions): string | undefined {
  return agentTestLoopbackOrigin(AGENT_TEST_ANTHROPIC_ORIGIN_ENV, options);
}

/**
 * Points a Claude bridge's environment at the agent-test Anthropic origin,
 * when there is one, and keeps the CLI's nonessential traffic off. Returns
 * whether it did.
 */
export function applyAgentTestAnthropicOrigin(
  env: NodeJS.ProcessEnv,
  options: AgentTestOriginOptions,
): boolean {
  const origin = agentTestAnthropicOrigin(options);
  if (!origin) return false;
  env.ANTHROPIC_BASE_URL = origin;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return true;
}
