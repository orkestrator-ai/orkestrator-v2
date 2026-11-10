import { randomInt } from "node:crypto";
import { ROOTLESS_SECURITY_OPTION } from "../src/core/agent-tools-peer-filter.js";

const FORBIDDEN_PORTS = new Set([34121, 34122]);

/** Reject reserved candidates before any bind; never delegate selection to port 0. */
export async function startEvidenceListener(
  listen: (port: number) => Promise<void>,
  candidate: () => number = () => randomInt(49152, 65536),
): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = candidate();
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || FORBIDDEN_PORTS.has(port))
      continue;
    try {
      await listen(port);
      return;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Could not bind an allowed evidence port after 32 candidates");
}

/** Keep failed IDs for the next cleanup pass and attempt every owned resource. */
export async function removeTrackedResources(
  tracked: string[],
  remove: (id: string) => Promise<unknown>,
): Promise<void> {
  for (const id of Array.from(tracked)) {
    try {
      await remove(id);
      tracked.splice(tracked.indexOf(id), 1);
    } catch {
      // Still owned: finalization retries it, then reports remaining IDs.
    }
  }
}

export async function cleanupEvidenceResources(
  created: { containers: string[]; networks: string[] },
  docker: (args: string[]) => Promise<unknown>,
): Promise<{ containers: string[]; networks: string[] }> {
  await removeTrackedResources(created.containers, (id) => docker(["rm", "-f", id]));
  await removeTrackedResources(created.networks, (name) => docker(["network", "rm", name]));
  return { containers: Array.from(created.containers), networks: Array.from(created.networks) };
}

/**
 * Whether `docker info --format '{{json .SecurityOptions}}'` names a rootless
 * daemon, matched exactly as the production peer filter matches it.
 */
export function daemonIsRootless(securityOptionsJson: string): boolean {
  const options: unknown = JSON.parse(securityOptionsJson.trim() || "null");
  return (
    Array.isArray(options) &&
    options.some((option) => typeof option === "string" && ROOTLESS_SECURITY_OPTION.test(option))
  );
}
