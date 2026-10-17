/**
 * Model selection for runtimes whose turns run the session's configured model.
 *
 * Codex takes its model from the bridge session's config, never from the
 * prompt, so whatever a session was created with is what every turn runs. A
 * configured default the login's live catalogue does not offer — the shipped
 * `gpt-5.4` on a ChatGPT login — failed every turn with HTTP 400 while the
 * picker showed the catalogue's first row instead.
 */
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  AgentModel,
  NativeAgentDefaultModelResolution,
} from "@orkestrator/protocol/native-agent";
import type { BridgeConnection } from "./agent-provider-contract.js";
import { boundedJson, bridgeFetch } from "./http-bridge-transport.js";

/** One row of the Codex bridge's `/global/models` answer. */
export interface CodexCatalogueModel {
  id: string;
  name?: string;
}

/**
 * The Codex bridge's catalogue, or undefined when it could not be read.
 *
 * Only `source: "app-server"` is the login's live `model/list`. The bridge's
 * persisted cache and hardcoded fallback can omit models the login serves, so
 * they never justify replacing a configured model.
 */
export interface CodexCatalogue {
  models: CodexCatalogueModel[];
  source?: string;
}

/**
 * The model a new Codex session should run for an inherited default.
 *
 * A configured model is replaced only on the positive signal that the live
 * catalogue does not list it, and the replacement is that catalogue's first
 * row: the one the picker already falls back to, so the shown and the run
 * model agree. An unset default stays unset and Codex applies its own. The
 * answer is for this session only; callers never write it to settings.
 */
export function resolveCodexDefaultModel(
  configuredModelId: string | undefined,
  catalogue: CodexCatalogue | undefined,
): NativeAgentDefaultModelResolution {
  const requestedModelId = configuredModelId?.trim();
  // `"default"` is the launchers' placeholder for unset, not a Codex model.
  if (!requestedModelId || requestedModelId === "default") return {};
  if (catalogue?.source !== "app-server") return { modelId: requestedModelId };
  if (catalogue.models.some((model) => model.id === requestedModelId)) {
    return { modelId: requestedModelId };
  }
  const replacement = catalogue.models[0];
  if (!replacement) return { modelId: requestedModelId };
  return {
    modelId: replacement.id,
    substitution: {
      requestedModelId,
      modelId: replacement.id,
      message: `${requestedModelId} isn't available with your Codex login; using ${replacement.name || replacement.id}.`,
    },
  };
}

/**
 * `resolveDefaultModel` for a Codex bridge: read its catalogue only when there
 * is a configured model to check.
 */
export async function resolveCodexBridgeDefaultModel(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  configuredModelId: string | undefined,
): Promise<NativeAgentDefaultModelResolution> {
  const unset = resolveCodexDefaultModel(configuredModelId, undefined);
  if (!unset.modelId) return unset;
  const response = await bridgeFetch(connection, "/global/models", {}, fetchImpl);
  const catalogue = response.ok
    ? parseCodexCatalogue(await boundedJson(response, "Codex model catalogue"))
    : undefined;
  return resolveCodexDefaultModel(configuredModelId, catalogue);
}

/** Bounded parse of the bridge's `/global/models` body. */
export function parseCodexCatalogue(value: unknown): CodexCatalogue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { models, source } = value as { models?: unknown; source?: unknown };
  if (!Array.isArray(models)) return undefined;
  return {
    models: models.slice(0, 512).flatMap((candidate): CodexCatalogueModel[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const { id, name } = candidate as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || id.length === 0) return [];
      return [{ id, ...(typeof name === "string" ? { name } : {}) }];
    }),
    ...(typeof source === "string" ? { source } : {}),
  };
}

/**
 * A picker row for a session-held model the catalogue does not list.
 *
 * It is what the session's next turn runs, so the picker shows it rather than
 * a catalogue row that would not run. The provider line says why it is not in
 * the list; picking any listed model replaces it.
 */
export function notOfferedSessionModel(platform: AgentPlatform, modelId: string): AgentModel {
  const label = AGENT_PLATFORM_LABELS[platform];
  return {
    platform,
    id: modelId,
    label: modelId,
    providerLabel: `${label} · not offered to this login`,
    description: `This session runs ${modelId}, which your ${label} login does not list. Choose another model.`,
  };
}
