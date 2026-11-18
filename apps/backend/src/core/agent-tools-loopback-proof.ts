import { createHmac, randomBytes } from "node:crypto";

export const AGENT_TOOLS_LOOPBACK_PROBE_PATH = "/mcp/loopback-probe";
export const AGENT_TOOLS_LOOPBACK_PROOF_HEADER = "x-orkestrator-loopback-proof";

/** The secret belongs to one server instance and never enters a container. */
export function createAgentToolsLoopbackSigner(): (challenge: string) => string {
  const key = randomBytes(32);
  return (challenge) => createHmac("sha256", key).update(challenge).digest("hex");
}

export function agentToolsLoopbackProof(
  url: URL,
  sign: (challenge: string) => string,
): string | null {
  const challenge = url.searchParams.get("challenge");
  return challenge && /^[0-9a-f]{32}$/.test(challenge) ? sign(challenge) : null;
}
