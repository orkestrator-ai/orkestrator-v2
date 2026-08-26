/**
 * Orkestrator's Cursor bridge.
 *
 * A standalone HTTP bridge that drives Cursor's own TypeScript SDK
 * (`@cursor/sdk`) directly. It
 * serves the same routes and the same transcript shape every other Orkestrator
 * bridge serves, so the backend, the store and the renderer cannot tell which
 * engine is behind a Cursor session.
 */
export * from "./config.js";
export * from "./state.js";
export * from "./credentials.js";
export * from "./models.js";
export * from "./tool-rendering.js";
export * from "./transcript.js";
export * from "./translate.js";
export * from "./agent-session.js";
export * from "./prompt.js";
export * from "./prompt-attachments.js";
export * from "./persistence.js";
export * from "./public.js";
export * from "./http.js";
export { server, shutdown, start } from "./server.js";

import { runLogin } from "./login-cli.js";
import { start } from "./server.js";

export { runLogin } from "./login-cli.js";

// `--login` runs the interactive sign-in and exits, instead of serving. The
// backend uses it so a login needs no environment and no running session: the
// credential it mints is account-wide, and keeping the SDK dependency in this
// package is what stops the backend from having to carry it.
if (process.argv.includes("--login")) {
  process.exit(await runLogin((line) => process.stdout.write(`${line}\n`)));
} else {
  await start();
}
