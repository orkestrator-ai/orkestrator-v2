import { isAbsolute, join } from "node:path";

/**
 * Where the bridge keeps its conversation bookkeeping: the records that tie a
 * bridge session to its thread, dispatch journals, session titles, change
 * evidence, command changes and typed prompts.
 *
 * Normally `$CODEX_HOME/orkestrator-bridge`. On an added Codex account the
 * backend sets `CODEX_BRIDGE_STATE_DIR` to the host login's directory, because
 * the conversations are shared across accounts while each account's
 * `CODEX_HOME` is not: a bridge replaced after an account switch must still
 * find the tab's session. What belongs to the login stays under its own
 * `CODEX_HOME`: the model cache and the app-server pid file.
 */
export function codexBridgeStateDir(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CODEX_BRIDGE_STATE_DIR?.trim();
  return override && isAbsolute(override) ? override : codexLoginBridgeDir(codexHome);
}

/** The login's own bridge directory, and the state directory before the override existed. */
export function codexLoginBridgeDir(codexHome: string): string {
  return join(codexHome, "orkestrator-bridge");
}
