import { asCachedCodexModels, bearerBridgeHeaders, type CommandContext } from "./commands/index.js";
import { peekContainerAgentBridge, peekLocalAgentBridge } from "./commands/servers.js";
import type { CodexModelCatalogEntry, Environment } from "./models.js";

/**
 * How long a running Codex bridge may take to list its models.
 *
 * The read rides on a picker or projection refresh, so it is held to the same
 * interactive cap as the ACP bridges' reads; a slower answer leaves the durable
 * cache as it was.
 */
export const CODEX_LIVE_MODEL_FETCH_TIMEOUT_MS = 8_000;

export type CodexLiveModelsResult =
  | { status: "ok"; models: CodexModelCatalogEntry[]; accountLoginKey?: string }
  | { status: "unavailable" | "failed"; models: [] };

/**
 * The live model list of an environment's *running* Codex bridge, never
 * starting one.
 *
 * Only a known local bridge generation can supply a catalogue for the
 * host login. Container credentials belong to the environment.
 *
 * Only an `app-server` answer counts: the bridge falls back to its own cached
 * or bundled list when app-server cannot answer, and saving either would
 * replace a real catalogue with a guess.
 */
export async function fetchCodexBridgeModels(
  environment: Environment,
  context: CommandContext,
  timeoutMs = CODEX_LIVE_MODEL_FETCH_TIMEOUT_MS,
): Promise<CodexLiveModelsResult> {
  try {
    if (environment.environmentType === "local") {
      const localServers = context.runtime.localServers;
      const key = `codex:${environment.id}`;
      const child = localServers.process(key);
      const accountLoginKey = child && localServers.launchedAccountLoginKey(key);
      const bridge = await peekLocalAgentBridge(environment.id, context, "codex");
      if (!bridge) return { status: "unavailable", models: [] };
      const result = await fetchCodexBridgeModelsAt(bridge.port, bridge.authToken, timeoutMs);
      return result.status === "ok" &&
        accountLoginKey &&
        localServers.process(key) === child &&
        !localServers.hasStaleLogin(key)
        ? { ...result, accountLoginKey }
        : result;
    }
    if (!environment.containerId) return { status: "unavailable", models: [] };
    const bridge = await peekContainerAgentBridge(environment.containerId, "codex");
    if (!bridge) return { status: "unavailable", models: [] };
    return await fetchCodexBridgeModelsAt(bridge.hostPort, bridge.authToken, timeoutMs);
  } catch {
    return { status: "failed", models: [] };
  }
}

/** {@link fetchCodexBridgeModels} against a known bridge endpoint. */
export async function fetchCodexBridgeModelsAt(
  port: number,
  authToken: string,
  timeoutMs = CODEX_LIVE_MODEL_FETCH_TIMEOUT_MS,
): Promise<CodexLiveModelsResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/models`, {
      headers: bearerBridgeHeaders(authToken),
      signal: AbortSignal.timeout(Math.max(1_000, timeoutMs)),
    });
    if (!response.ok) return { status: "failed", models: [] };
    const body = (await response.json()) as { models?: unknown; source?: unknown };
    if (body.source !== "app-server" || !Array.isArray(body.models) || body.models.length === 0) {
      return { status: "failed", models: [] };
    }
    return { status: "ok", models: asCachedCodexModels(body.models) };
  } catch {
    return { status: "failed", models: [] };
  }
}
