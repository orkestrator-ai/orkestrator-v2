/**
 * The contract primitives (docs/reports/unified-federation.md §11.2): domains,
 * command and event definitions over Effect Schema, the invoke envelope, the
 * typed incompatibility errors and domain clients. Each module is also its
 * own subpath (`@orkestrator/protocol/contract/<module>`).
 *
 * Browser-safe: shared by the backend, web, desktop and CLI.
 */
export * from "./client.js";
export * from "./client-adapters.js";
export * from "./client-usage.js";
export * from "./command.js";
export * from "./domain.js";
export * from "./envelope.js";
export * from "./errors.js";
export * from "./event.js";
export * from "./ipc-error.js";
export * from "./json-schema.js";
export * from "./model-schema.js";
