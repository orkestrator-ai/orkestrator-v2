/**
 * Which bridge surface an agent platform speaks. Import-free, so the
 * transport, catalogue and interaction modules can all branch on it.
 */

/**
 * The platforms the ACP bridge runs (one bridge build, a process each).
 * Transport-wide ACP behaviour branches on this; x.ai extensions and Grok's
 * tool restrictions stay on `agent === "grok"`.
 */
export function isAcpBridgeAgent(agent: string): agent is "grok" | "antigravity" {
  return agent === "grok" || agent === "antigravity";
}

/**
 * Bridges serving the shared SDK/ACP session surface: bearer-token auth,
 * `/session/:id/status` state reads, `/attach`, `/config` and `/session/resume`
 * (Cursor, Pi and the ACP bridge's platforms). Claude and Codex have their own.
 */
export function servesSharedBridgeSurface(
  agent: string,
): agent is "cursor" | "grok" | "pi" | "antigravity" {
  return agent === "cursor" || agent === "pi" || isAcpBridgeAgent(agent);
}

/** The short name an ACP interaction card uses ("Grok", "Antigravity"). */
export function acpBridgeLabel(agent: string): string {
  return agent === "antigravity" ? "Antigravity" : "Grok";
}
