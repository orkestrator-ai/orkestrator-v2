/**
 * The bridge token a harness process was started with, read before the bridge
 * loads.
 *
 * `index.ts` deletes `CODEX_BRIDGE_TOKEN` from `process.env` at module load so
 * nothing the bridge spawns inherits it. A harness that needs the token to
 * call its own bridge imports this module *before* `../index.js`; ES modules
 * evaluate sibling imports in order, so this runs first.
 *
 * Not part of the shipped bundle.
 */
export const capturedCodexBridgeToken = process.env.CODEX_BRIDGE_TOKEN;
