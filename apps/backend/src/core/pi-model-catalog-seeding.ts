import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentModel } from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import { resolveBunBinary } from "./commands-agent-support.js";
import { terminateLocalServerChild } from "./commands-local-server-lifecycle.js";
import {
  isLocalServerShutdownRequested,
  localServerProcesses,
  spawnLocalServerCommandImpl,
} from "./commands-runtime-state.js";
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
 * When the last probe produced no catalogue, as epoch milliseconds.
 *
 * A probe that yields nothing is the expensive case, not the cheap one: it
 * still spawns a bridge and pays the full health budget before answering. Pi
 * fronts the user's own providers, so "no models" is a perfectly ordinary
 * steady state for an installation that has never run `/login` — without this,
 * every launch and every open of the new-environment dialog would repeat that
 * cost and store nothing to show for it.
 */
let piCatalogEmptyProbeAt: number | null = null;

/** How long an empty or failed probe suppresses the next one. */
export const PI_CATALOG_EMPTY_PROBE_BACKOFF_MS = 5 * 60_000;

/** Distinguishes concurrent probe generations in the ownership registry. */
let piCatalogProbeSequence = 0;

/**
 * Drops the single-flight promise, the empty-result backoff and the generation
 * counter. Test-only: the counter exists to keep a probe that is still
 * terminating from releasing its successor's ownership entry, so nothing in
 * production may rewind it while a child is registered.
 */
export function resetPiModelCatalogSeedingState(): void {
  piCatalogDiscovery = null;
  piCatalogEmptyProbeAt = null;
  piCatalogProbeSequence = 0;
}

/**
 * Seed Pi's host-wide model catalogue before an environment exists.
 *
 * The ordinary Pi bridge is environment-scoped because sessions need a
 * workspace and durable session directories. Model discovery needs neither, so
 * this starts the same bridge from its trusted package directory, reads only
 * `/global/models`, and always tears the process down before returning.
 */
export function discoverHostPiModelCatalog(context: CommandContext): Promise<AgentModel[]> {
  if (
    piCatalogEmptyProbeAt !== null &&
    Date.now() - piCatalogEmptyProbeAt < PI_CATALOG_EMPTY_PROBE_BACKOFF_MS
  ) {
    return Promise.resolve([]);
  }
  piCatalogDiscovery ??= runDiscovery(context)
    .then(
      (models) => {
        if (models.length === 0) piCatalogEmptyProbeAt = Date.now();
        return models;
      },
      (error: unknown) => {
        // A probe that could not run is as expensive to repeat as one that ran
        // and found nothing, so it arms the same backoff. The error still
        // reaches this caller; only the retries within the window are dropped.
        piCatalogEmptyProbeAt = Date.now();
        throw error;
      },
    )
    .finally(() => {
      piCatalogDiscovery = null;
    });
  return piCatalogDiscovery;
}

async function runDiscovery(context: CommandContext): Promise<AgentModel[]> {
  if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has("pi")) return [];
  // Shutdown closes admission before it snapshots the children it owns, so a
  // probe admitted after that point would spawn a bridge the drain has already
  // walked past.
  if (isLocalServerShutdownRequested()) return [];

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

  piCatalogProbeSequence += 1;
  // Never an environment id, so this cannot collide with a real Pi bridge in
  // `peekLocalAgentBridge`, and a generation counter keeps a probe that is
  // still terminating from releasing its successor's entry.
  const key = `pi:catalog-seed:${piCatalogProbeSequence}`;
  const child = spawnLocalServerCommandImpl(resolveBunBinary(context), [entrypoint], {
    cwd,
    env,
    // Matches every other bridge launch: a dedicated group lets shutdown reach
    // ordinary descendants immediately, and explicit descendant signalling
    // covers children that create new groups.
    detached: process.platform !== "win32",
  });
  // Registered before the first await so `shutdownLocalServers` can terminate
  // it. `terminateLocalServerChild` releases the entry on the way out.
  localServerProcesses.set(key, child);
  // The bridge normally has no output. Drain defensively rather than allowing a
  // child pipe to back-pressure startup, and never log provider diagnostics —
  // an SDK error can contain account-specific data.
  child.stdout.resume();
  child.stderr.resume();

  try {
    // Closes the window between the gate above and the registration: shutdown
    // may have snapshotted its children in between, leaving this one unowned.
    if (isLocalServerShutdownRequested()) return [];
    await waitForLocalServerStartup(child, port, "pi", bearerBridgeHeaders(authToken));
    return await fetchAcpNormalizedModelsAt(port, authToken, "pi");
  } finally {
    // A teardown failure must not replace the outcome. Discarding a catalogue
    // this probe successfully read — or masking the error that ended it — would
    // report a provider problem for what is only a stubborn child process.
    await terminateLocalServerChild(key, child).catch((error: unknown) => {
      console.warn(
        "[ElectronBackend] The Pi catalogue probe did not exit cleanly:",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  }
}
