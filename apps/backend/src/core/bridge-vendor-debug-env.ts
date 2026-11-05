/**
 * Vendor debug switches a local bridge would otherwise inherit from the shell
 * that launched Orkestrator.
 *
 * Each one turns on a vendor's own printing (the `debug` package, Rust's
 * `tracing`, the Claude Agent SDK). That output is not a logger call, so the
 * bridge hop captures it as text whatever the configured level is, and a
 * vendor's debug text can quote prompts and tool content. A stray export in a
 * login shell is easy to forget, so the local launch drops these unless the
 * user keeps them on purpose with {@link KEEP_VENDOR_DEBUG_ENV}.
 *
 * Removing them from the bridge's environment also removes them from the
 * vendor CLI and every command it spawns, which is where most of them are
 * honoured. A project's own `DEBUG=x bun test` sets its own value and is
 * unaffected. Container bridges never inherit the host environment.
 */
export const INHERITED_VENDOR_DEBUG_ENV = ["DEBUG", "RUST_LOG", "DEBUG_CLAUDE_AGENT_SDK"] as const;

/** Set to `1` in the backend's environment to pass the variables above through. */
export const KEEP_VENDOR_DEBUG_ENV = "ORKESTRATOR_KEEP_VENDOR_DEBUG";

/** Drops the inherited vendor debug variables from a local bridge's environment. */
export function dropInheritedVendorDebug(
  env: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv = process.env,
): void {
  if (source[KEEP_VENDOR_DEBUG_ENV]?.trim() === "1") return;
  for (const name of INHERITED_VENDOR_DEBUG_ENV) delete env[name];
}
