/**
 * Refusals from desktop main's node IPC (plan items 2007 and 2010), and the
 * `[code] text` message form they cross Electron IPC in.
 *
 * Electron passes only an error's message from main to the preload, and the
 * context bridge drops an error's custom properties on the way to the
 * renderer, so main leads the message with the code:
 *
 *     [node-scope-closed] The machine's scope in this window was closed.
 *
 * The preload copies the code back to `error.code`; the renderer reads either
 * (`nodeRefusalCode`). `./ipc-error.ts` extends the same bracket form with
 * `key=value` details for typed incompatibilities.
 *
 * Not to be confused with `NODE_REFUSAL_CODES` in `../command-nodes.ts`: those
 * are the attachment refusals a backend answers over `/invoke`
 * (`node-is-subordinate`, `duplicate-node`, ...), in the different
 * `NodeRefusal:<code>: <message>` form. Both sets contain `unknown-node`.
 *
 * Desktop main keeps `NodeRefusal` as its `Data.TaggedError` (`node-ipc.ts`).
 * No Effect import here: the sandboxed preload bundle uses this module.
 */

/**
 * - `unknown-node`: the window's command node does not know this node.
 * - `node-admin-refused`: machine administration for a leaf; it is done from
 *   the command node.
 * - `node-scope-closed`: the window closed or the scope was released while it
 *   was opening.
 * - `node-unavailable`: the node is known but its workspace could not open.
 */
export const DESKTOP_NODE_REFUSAL_CODES = [
  "unknown-node",
  "node-admin-refused",
  "node-scope-closed",
  "node-unavailable",
] as const;

export type DesktopNodeRefusalCode = (typeof DESKTOP_NODE_REFUSAL_CODES)[number];

/** A code in the protocol's code form (`/^[a-z][a-z0-9-]{0,63}$/`) leading a message. */
const CODED_MESSAGE_PREFIX = /^\[([a-z][a-z0-9-]{0,63})\] /;

/** `[code] text`: the message form a coded refusal crosses IPC in. */
export function codedMessage(code: string, text: string): string {
  return `[${code}] ${text}`;
}

/** The code leading a `[code] text` message, or null. Any code form, not only refusals. */
export function messageCode(message: string): string | null {
  return CODED_MESSAGE_PREFIX.exec(message)?.[1] ?? null;
}

/**
 * The code of a refusal that crossed the context bridge: `error.code` when the
 * preload set one in the code form, otherwise the `[code] ` message prefix.
 */
export function nodeRefusalCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && messageCode(codedMessage(code, "")) === code) return code;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? messageCode(message) : null;
}
