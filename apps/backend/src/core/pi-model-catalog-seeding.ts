import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentModel } from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import { resolveBunBinary } from "./commands-agent-support.js";
import { terminateLocalServerChild } from "./commands-local-server-lifecycle.js";
import { spawnLocalServerCommandImpl } from "./commands-runtime-state.js";
import { bearerBridgeHeaders } from "./commands-server-health.js";
import {
  allocateLocalPort,
  fetchAcpNormalizedModelsAt,
  getBridgePath,
  waitForLocalServerStartup,
} from "./commands-servers.js";

/** One host-wide first-use catalogue probe at a time. */
let piCatalogDiscovery: Promise<AgentModel[]> | null = null;

/**
 * Seed Pi's host-wide model catalogue before an environment exists.
 *
 * The ordinary Pi bridge is environment-scoped because sessions need a
 * workspace and durable session directories. Model discovery needs neither, so
 * this starts the same bridge from its trusted package directory, reads only
 * `/global/models`, and always tears the process down before returning.
 */
export function discoverHostPiModelCatalog(context: CommandContext): Promise<AgentModel[]> {
  piCatalogDiscovery ??= runDiscovery(context).finally(() => {
    piCatalogDiscovery = null;
  });
  return piCatalogDiscovery;
}

async function runDiscovery(context: CommandContext): Promise<AgentModel[]> {
  if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has("pi")) return [];

  const cwd = getBridgePath(context, "pi-bridge");
  const entrypoint = path.join(cwd, "dist", "index.js");
  if (!existsSync(cwd)) throw new Error(`pi bridge directory not found: ${cwd}`);
  if (!existsSync(entrypoint)) throw new Error(`pi bridge entrypoint not found: ${entrypoint}`);

  const port = await allocateLocalPort();
  const authToken = randomBytes(32).toString("base64url");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    CWD: cwd,
    PI_BRIDGE_TOKEN: authToken,
    PI_BRIDGE_PROJECT_RESOURCES: "0",
    ORKESTRATOR_PARENT_PID: String(process.pid),
  };
  // A production backend inherits the user's HOME, which is where Pi itself
  // reads `~/.pi/agent`. Agent-test backends have an isolated HOME; an explicit
  // Pi credential source authorizes this short-lived probe to use the host's Pi
  // directory without copying credentials into logs, output, or persisted app
  // state.
  if (context.runtimeFlavor === "agent-test") {
    const hostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
    if (!hostHome) return [];
    env.PI_AGENT_DIR = path.join(hostHome, ".pi", "agent");
  } else {
    delete env.PI_AGENT_DIR;
  }
  // Catalogue discovery owns no conversation and must not restore or create
  // bridge/session state just because a new-environment dialog was opened.
  delete env.PI_BRIDGE_STATE_DIR;
  delete env.PI_SESSION_DIR;

  const child = spawnLocalServerCommandImpl(resolveBunBinary(context), [entrypoint], {
    cwd,
    env,
    detached: false,
  });
  // The bridge normally has no output. Drain defensively rather than allowing a
  // child pipe to back-pressure startup, and never log provider diagnostics —
  // an SDK error can contain account-specific data.
  child.stdout.resume();
  child.stderr.resume();

  try {
    await waitForLocalServerStartup(child, port, "pi", bearerBridgeHeaders(authToken));
    return await fetchAcpNormalizedModelsAt(port, authToken, "pi");
  } finally {
    await terminateLocalServerChild("pi:catalog-seed", child);
  }
}
