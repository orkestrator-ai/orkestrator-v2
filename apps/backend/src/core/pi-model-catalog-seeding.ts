import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";
import { resolveBunBinary } from "./commands-agent-support.js";
import { applyPiHostCredentialEnvironment } from "./host-agent-credentials.js";
import { bearerBridgeHeaders } from "./commands-server-health.js";
import {
  allocateLocalPort,
  fetchAcpNormalizedModelsAt,
  prepareBridgePath,
  waitForLocalServerStartup,
} from "./commands-servers.js";

/**
 * Seed Pi's host-wide model catalogue before an environment exists.
 *
 * The ordinary Pi bridge is environment-scoped because sessions need a
 * workspace and durable session directories. Model discovery needs neither, so
 * this starts the same bridge from its trusted package directory, reads only
 * `/global/models`, and always tears the process down before returning. The
 * single-flight and backoff state is the backend's own
 * (`context.runtime.localServers.piCatalog`).
 */
export function discoverHostPiModelCatalog(
  context: CommandContext,
  force = false,
): Promise<AgentModel[]> {
  return context.runtime.localServers.piCatalog.discover(force, () => runDiscovery(context));
}

async function runDiscovery(context: CommandContext): Promise<AgentModel[]> {
  if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has("pi")) return [];
  // Shutdown closes admission before it snapshots the children it owns, so a
  // probe admitted after that point would spawn a bridge the drain has already
  // walked past.
  const localServers = context.runtime.localServers;
  if (localServers.isShuttingDown()) return [];

  const cwd = await prepareBridgePath(context, "pi-bridge");
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
    ORKESTRATOR_PARENT_PID: String(process.pid),
  };
  // The same credential policy as an environment's Pi bridge, so the catalogue
  // lists what a bridge can actually serve: production reads `~/.pi/agent`,
  // and an agent-test profile reads its own Pi directory plus, when Pi is
  // authorized, only the host's `auth.json`.
  await applyPiHostCredentialEnvironment(context, env);
  // Catalogue discovery owns no conversation and must not restore or create
  // bridge/session state just because a new-environment dialog was opened.
  delete env.PI_BRIDGE_STATE_DIR;
  delete env.PI_SESSION_DIR;

  // A fresh generation per probe keeps one that is still terminating from
  // releasing its successor's entry.
  const key = localServers.piCatalog.nextProbeKey();
  const child = localServers.spawn(resolveBunBinary(context), [entrypoint], {
    cwd,
    env,
    // Matches every other bridge launch: a dedicated group lets shutdown reach
    // ordinary descendants immediately, and explicit descendant signalling
    // covers children that create new groups.
    detached: process.platform !== "win32",
  });
  // Registered before the first await so `localServers.shutdown()` can
  // terminate it. `localServers.terminate()` releases the entry on the way out.
  localServers.adoptProcess(key, child);
  // The bridge normally has no output. Drain defensively rather than allowing a
  // child pipe to back-pressure startup, and never log provider diagnostics —
  // an SDK error can contain account-specific data.
  child.stdout.resume();
  child.stderr.resume();

  try {
    // Closes the window between the gate above and the registration: shutdown
    // may have snapshotted its children in between, leaving this one unowned.
    if (localServers.isShuttingDown()) return [];
    await waitForLocalServerStartup(child, port, "pi", bearerBridgeHeaders(authToken));
    return await fetchAcpNormalizedModelsAt(port, authToken, "pi");
  } finally {
    // A teardown failure must not replace the outcome. Discarding a catalogue
    // this probe successfully read — or masking the error that ended it — would
    // report a provider problem for what is only a stubborn child process.
    await localServers.terminate(key, child).catch((error: unknown) => {
      console.warn(
        "[ElectronBackend] The Pi catalogue probe did not exit cleanly:",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  }
}
