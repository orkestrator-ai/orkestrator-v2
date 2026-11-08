/**
 * Which OpenCode line runs a native session
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 3).
 *
 * `legacy` is the pinned OpenCode 1.x server every existing session runs on.
 * `v2` is the OpenCode 2.x preview: the global setting picks it for *new*
 * interactive host sessions only, and the session record carries
 * `openCodeProtocol: "v2"` for its whole life. A record without the marker is
 * legacy, so changing the setting never moves a session either way.
 *
 * Browser-safe.
 */
export const OPENCODE_PROTOCOLS = ["legacy", "v2"] as const;
export type OpenCodeProtocol = (typeof OPENCODE_PROTOCOLS)[number];
/** Until phase 6 (qualification) every new session stays on 1.x unless asked. */
export const OPENCODE_DEFAULT_PROTOCOL: OpenCodeProtocol = "legacy";

export function isOpenCodeProtocol(value: unknown): value is OpenCodeProtocol {
  return typeof value === "string" && (OPENCODE_PROTOCOLS as readonly string[]).includes(value);
}

/** The stored setting as the line new sessions use; anything unrecognised is legacy. */
export function resolveOpenCodeProtocol(value: unknown): OpenCodeProtocol {
  return isOpenCodeProtocol(value) ? value : OPENCODE_DEFAULT_PROTOCOL;
}
