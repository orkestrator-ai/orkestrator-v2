import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  isSelectableOpenCodeModelId,
  isSelectableOpenCodeProvider,
  openCodeModelProviderId,
  openCodeModelProvidersKey,
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
 *
 * `priorityProviders` is for the unfiltered read. Its provider and model caps
 * are spent in the order OpenCode lists providers, and OpenCode advertises
 * thousands of models, so the configured allowlist has to be normalized *first*
 * or the durable cache can be truncated to a catalogue that contains none of the
 * providers the user actually selected — the same failure the filter avoids for
 * the picker-facing reads.
 */
export function normalizeOpenCodeComposerCatalog(
  value: unknown,
  allowedProviders: readonly string[] = DEFAULT_OPENCODE_MODEL_PROVIDERS,
  options: {
    requireConnected?: boolean;
    priorityProviders?: readonly string[];
  } = {},
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
  const priorityProviders = new Set(
    (options.priorityProviders ?? []).map((providerId) => providerId.trim().toLowerCase()),
  );
  // Reject the provider before either cap is applied. OpenCode advertises
  // thousands of models across every provider it knows about, so an excluded
  // provider allowed to consume the 128-provider or 512-model budget pushes the
  // selectable catalogues out of the picker entirely.
  const accepted = openCodeCatalogProviders(value)
    .filter((provider) => {
      const providerId = nonEmptyString(provider.id);
      return providerId !== null
        && (!connectedProviders || connectedProviders.has(providerId))
        && isSelectableOpenCodeProvider(providerId, allowedProviders);
    });
  // A stable partition, so a catalogue with no priority list — every
  // picker-facing read — keeps OpenCode's own provider order exactly.
  const isPriority = (provider: Record<string, unknown>): boolean =>
    priorityProviders.has((nonEmptyString(provider.id) ?? "").toLowerCase());
  const selectableProviders = (priorityProviders.size === 0
    ? accepted
    : [...accepted.filter(isPriority), ...accepted.filter((provider) => !isPriority(provider))])
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

/**
 * Whether OpenCode can currently serve one `providerID/modelID`.
 *
 * Availability is a statement about OpenCode, never about the picker's provider
 * allowlist: a model chosen before that list narrowed — or a stored default
 * naming a provider since deselected — is still one OpenCode can serve, so
 * judging it against the filtered catalogue rejected perfectly good prompts as
 * "not connected". The model's own provider leads the priority order so the
 * unfiltered read's caps cannot hide it either.
 *
 * `unknown` covers the builds that do not report connectivity at all, whose
 * prior behaviour was to dispatch.
 */
export function openCodeModelDispatchability(
  value: unknown,
  modelId: string,
): "available" | "unavailable" | "unknown" {
  const catalog = normalizeOpenCodeComposerCatalog(value, [], {
    requireConnected: true,
    priorityProviders: [openCodeModelProviderId(modelId)],
  });
  if (catalog.connectedProviderIds === undefined) return "unknown";
  return catalog.models.some((candidate) => candidate.id === modelId)
    ? "available"
    : "unavailable";
}

/**
 * Cache key identifying the inputs one normalized catalogue was built from.
 *
 * The connectivity filter has to be part of the key. An allowlist configured
 * empty means "unrestricted", which collides with the empty allowlist the
 * durable-cache read passes — without this the picker could be served the
 * deliberately unfiltered entry written for that cache. The priority list
 * decides which providers survive the caps, so it separates entries for the
 * same reason.
 */
export function openCodeCatalogCacheKey(
  allowedProviders: readonly string[],
  requireConnected: boolean,
  priorityProviders: readonly string[] = [],
): string {
  return `${requireConnected ? "connected" : "all"}:${
    openCodeModelProvidersKey(allowedProviders)
  }:${openCodeModelProvidersKey(priorityProviders)}`;
}

/**
 * Normalize `provider/list`, falling back to `config/providers` only when the
 * first read said nothing at all.
 *
 * An empty connected set is authoritative. Falling back merely because it
 * yielded no models would re-expose every provider OpenCode knows about,
 * including providers that cannot currently serve a prompt.
 */
export function selectOpenCodeComposerCatalog(
  live: unknown,
  fallback: () => unknown,
  allowedProviders: readonly string[],
  options: {
    requireConnected?: boolean;
    priorityProviders?: readonly string[];
  } = {},
): ReturnType<typeof normalizeOpenCodeComposerCatalog> {
  const catalog = normalizeOpenCodeComposerCatalog(live, allowedProviders, options);
  return catalog.connectedProviderIds !== undefined || catalog.models.length > 0
    ? catalog
    : normalizeOpenCodeComposerCatalog(fallback(), allowedProviders, options);
}
