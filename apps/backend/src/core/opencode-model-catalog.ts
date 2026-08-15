import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  isSelectableOpenCodeModelId,
  isSelectableOpenCodeProvider,
} from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

function openCodeCatalogProviders(value: unknown): Record<string, unknown>[] {
  const catalog = asRecord(value);
  const raw = catalog?.all ?? catalog?.providers;
  if (Array.isArray(raw)) {
    return raw.flatMap((candidate) => {
      const provider = asRecord(candidate);
      return provider ? [provider] : [];
    });
  }
  const providers = asRecord(raw);
  if (!providers) return [];
  return Object.entries(providers).flatMap(([id, candidate]) => {
    const provider = asRecord(candidate);
    return provider ? [{ id, ...provider }] : [];
  });
}

function openCodeProviderModels(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((candidate) => {
      const model = asRecord(candidate);
      return model ? [model] : [];
    });
  }
  const models = asRecord(value);
  if (!models) return [];
  return Object.entries(models).flatMap(([id, candidate]) => {
    const model = asRecord(candidate);
    return model ? [{ id, ...model }] : [];
  });
}

function openCodeCatalogDefault(value: unknown): {
  modelId?: string;
  reasoningId?: string;
} {
  const catalog = asRecord(value);
  const defaults = asRecord(catalog?.default);
  if (!defaults) return {};
  const nested = asRecord(defaults.model);
  const providerId = nonEmptyString(nested?.providerID)
    ?? nonEmptyString(defaults.providerID)
    ?? nonEmptyString(defaults.provider);
  const modelId = nonEmptyString(nested?.modelID)
    ?? nonEmptyString(defaults.modelID)
    ?? (typeof defaults.model === "string" ? defaults.model : null);
  const qualified = modelId?.includes("/")
    ? modelId
    : providerId && modelId
      ? `${providerId}/${modelId}`
      : undefined;
  return {
    ...(qualified ? { modelId: qualified } : {}),
    ...(nonEmptyString(nested?.variant) ?? nonEmptyString(defaults.variant)
      ? {
          reasoningId: nonEmptyString(nested?.variant)
            ?? nonEmptyString(defaults.variant)
            ?? undefined,
        }
      : {}),
  };
}

/**
 * Normalize an OpenCode provider catalogue into selectable models.
 *
 * `requireConnected` gates the connectivity filter rather than applying it
 * unconditionally. Picker-facing and dispatch-facing reads want it: a provider
 * OpenCode cannot currently serve must not be offered or sent to. The durable
 * cache read (`rawModelCatalog`) must not have it, because that catalogue
 * deliberately outlives the current connectivity state so a provider
 * authenticated later is still offered before another bridge starts.
 *
 * `connectedProviderIds` is reported either way, so a caller that skipped the
 * filter can still see what OpenCode considered connected.
 */
export function normalizeOpenCodeComposerCatalog(
  value: unknown,
  allowedProviders: readonly string[] = DEFAULT_OPENCODE_MODEL_PROVIDERS,
  options: { requireConnected?: boolean } = {},
): {
  models: AgentModel[];
  selectedModelId?: string;
  selectedReasoningId?: string;
  /** Present when OpenCode authoritatively reported its connected providers. */
  connectedProviderIds?: string[];
} {
  const models: AgentModel[] = [];
  const connected = asRecord(value)?.connected;
  const connectedProviderIds = Array.isArray(connected)
    ? connected.flatMap((candidate) => {
        const providerId = typeof candidate === "string"
          ? nonEmptyString(candidate)
          : nonEmptyString(asRecord(candidate)?.id);
        return providerId ? [providerId] : [];
      }).slice(0, 512)
    : undefined;
  const connectedProviders = options.requireConnected && connectedProviderIds
    ? new Set(connectedProviderIds)
    : null;
  // Reject the provider before either cap is applied. OpenCode advertises
  // thousands of models across every provider it knows about, so an excluded
  // provider allowed to consume the 128-provider or 512-model budget pushes the
  // selectable catalogues out of the picker entirely.
  const selectableProviders = openCodeCatalogProviders(value)
    .filter((provider) => {
      const providerId = nonEmptyString(provider.id);
      return providerId !== null
        && (!connectedProviders || connectedProviders.has(providerId))
        && isSelectableOpenCodeProvider(providerId, allowedProviders);
    })
    .slice(0, 128);
  for (const provider of selectableProviders) {
    const providerId = nonEmptyString(provider.id);
    if (!providerId) continue;
    for (const model of openCodeProviderModels(provider.models).slice(0, 512)) {
      const localId = nonEmptyString(model.id);
      if (!localId) continue;
      const variants = asRecord(model.variants);
      const reasoning = variants
        ? Object.entries(variants).flatMap(([id, candidate]) => {
            const variant = asRecord(candidate);
            return variant?.disabled === true
              ? []
              : [{ id, label: id.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase()) }];
          }).slice(0, 64)
        : [];
      const limit = asRecord(model.limit);
      const capabilities = asRecord(model.capabilities);
      const input = asRecord(capabilities?.input);
      const contextWindow = [
        limit?.context,
        model.contextWindow,
        model.context_window,
      ].find((candidate) => typeof candidate === "number"
        && Number.isSafeInteger(candidate)
        && candidate > 0) as number | undefined;
      models.push({
        platform: "opencode",
        id: `${providerId}/${localId}`,
        label: nonEmptyString(model.name) ?? localId,
        providerLabel: nonEmptyString(provider.name) ?? providerId,
        reasoning: [
          { id: "default", label: "Default" },
          ...reasoning,
        ],
        defaultReasoningId: "default",
        supportsSpeed: false,
        supportsMode: true,
        ...(contextWindow ? { contextWindow } : {}),
        ...(typeof input?.image === "boolean"
          ? { supportsImageInput: input.image }
          : typeof model.attachment === "boolean"
            ? { supportsImageInput: model.attachment }
            : {}),
      });
      if (models.length >= 512) break;
    }
    if (models.length >= 512) break;
  }
  const defaults = openCodeCatalogDefault(value);
  // OpenCode's own default may name a provider the user excluded. Surfacing it
  // would pre-select a model the picker cannot show, so it is dropped with the
  // rest of that provider's catalogue.
  const selectedModelId = defaults.modelId
    && isSelectableOpenCodeModelId(defaults.modelId, allowedProviders)
    && models.some((model) => model.id === defaults.modelId)
    ? defaults.modelId
    : undefined;
  return {
    models,
    ...(connectedProviderIds ? { connectedProviderIds } : {}),
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(selectedModelId && defaults.reasoningId
      ? { selectedReasoningId: defaults.reasoningId }
      : {}),
  };
}

