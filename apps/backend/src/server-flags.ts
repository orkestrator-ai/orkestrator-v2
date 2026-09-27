/**
 * Every command-line flag `parseOptions` accepts, as the published launcher
 * sees them. The launcher uses this inventory to decide, before importing the
 * backend, whether an invocation is the legacy foreground service form or a
 * client command, and to refuse typos instead of silently starting a service.
 *
 * `options.test.ts` scans `options.ts` and fails if a flag is parsed there but
 * missing here. Pure data: the client bundle imports this file.
 */

/** Flags that consume the following argument (`--flag value`). */
export const SERVER_VALUE_FLAGS: readonly string[] = Object.freeze([
  "--allowed-origins",
  "--app-root",
  "--compression",
  "--control-host",
  "--control-port",
  "--credential-source",
  "--data-dir",
  "--docker-image",
  "--fallback-host",
  "--host",
  "--port",
  "--renderer-dev-server-url",
  "--renderer-root",
  "--resource-root",
  "--runtime-flavor",
  "--runtime-profile-id",
  "--tailscale-bin",
  "--tailscale-serve-port",
  "--toolchain-bin-dir",
  "--worktree-dir",
]);

/** Presence-only flags. */
export const SERVER_BOOLEAN_FLAGS: readonly string[] = Object.freeze([
  "--allow-non-tailscale-bind",
  "--desktop-web-client",
  "--strict-docker-owner",
  "--strict-gateway-port",
  "--tailscale-serve",
  // Pre-rename spelling kept for existing service units.
  "--unsafe-allow-non-tailscale-bind",
]);

export function isServerFlag(token: string): boolean {
  return SERVER_VALUE_FLAGS.includes(token) || SERVER_BOOLEAN_FLAGS.includes(token);
}

/**
 * Validate a service argument list. Returns an error message for the first
 * unknown flag, stray positional, or flag missing its value; null when every
 * token is a recognized service argument.
 */
export function validateServerArguments(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (SERVER_BOOLEAN_FLAGS.includes(token)) continue;
    if (SERVER_VALUE_FLAGS.includes(token)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return `Missing value for ${token}`;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return `Unknown service option: ${token.split("=")[0]}`;
    return "Unexpected argument for the service; client commands take a subcommand first";
  }
  return null;
}
