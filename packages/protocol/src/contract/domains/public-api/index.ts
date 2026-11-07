/**
 * The `public-api` domain: definition and command. No domain client: every
 * caller (the CLI, Control MCP, scheduled jobs, a command node routing to a
 * leaf) calls `public_action` by name, and the public actions negotiate with
 * their own `capabilities`. Browser-safe.
 */
export * from "./domain.js";
export * from "./commands.js";
