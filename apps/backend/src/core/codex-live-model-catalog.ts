import type { CommandContext } from "./commands-context.js";
import { bearerBridgeHeaders } from "./commands-server-health.js";
import { peekContainerAgentBridge, peekLocalAgentBridge } from "./commands-servers.js";
import { asCachedCodexModels } from "./commands-validation.js";
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
  | { status: "ok"; models: CodexModelCatalogEntry[] }
  | { status: "unavailable" | "failed"; models: [] };

/**
 * The live model list of an environment's *running* Codex bridge, never
 * starting one.
 *
 * Codex's catalogue is host-wide and was written only by the Settings refresh
 * and the first-use seed, so once a machine had a list it never learned of a
 * new model however many Codex sessions ran on it. Reading the running bridge
 * gives Codex the same self-correcting cache Cursor, Grok and Pi already have.
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
  const bridge =
    environment.environmentType === "local"
      ? await peekLocalAgentBridge(environment.id, context, "codex")
      : environment.containerId
        ? await peekContainerAgentBridge(environment.containerId, "codex")
        : null;
  if (!bridge) return { status: "unavailable", models: [] };
  const port = "port" in bridge ? bridge.port : bridge.hostPort;
  return fetchCodexBridgeModelsAt(port, bridge.authToken, timeoutMs);
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
