/**
 * Orkestrator's Pi bridge.
 *
 * A standalone HTTP bridge that drives Pi's own TypeScript SDK
 * (`@earendil-works/pi-coding-agent`) in process. It serves the same routes and
 * the same transcript shape every other Orkestrator bridge serves, so the
 * backend, the store and the renderer cannot tell which engine is behind a
 * session.
 *
 * Pi is a harness rather than a vendor: it fronts fifteen-odd model providers
 * using the user's own credentials. That shows up in exactly two places — the
 * model id is a `provider/model` pair, and "signed in" is one answer per
 * provider — and stops there. See `models.ts` and `credentials.ts`.
 */
export * from "./config.js";
export * from "./state.js";
export * from "./timeout.js";
export * from "./runtime.js";
export * from "./credentials.js";
export * from "./models.js";
export * from "./tool-rendering.js";
export * from "./transcript.js";
export * from "./translate.js";
export * from "./interactions.js";
export * from "./agent-session.js";
export * from "./prompt.js";
export * from "./prompt-attachments.js";
export * from "./persistence.js";
export * from "./public.js";
export * from "./http.js";
export { server, shutdown, start } from "./server.js";

import { start } from "./server.js";

// Importing this module from a test must not bind a port. The backend runs it
// as a program; every other consumer imports it as a library.
if (process.env.PI_BRIDGE_LIBRARY_ONLY !== "1") {
  await start();
}
