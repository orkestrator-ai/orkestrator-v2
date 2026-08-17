import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  isSelectableOpenCodeModelId,
  isSelectableOpenCodeProvider,
  openCodeModelDisplayLabel,
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

const MAX_OPENCODE_CATALOG_MODELS = 512;
const MAX_OPENCODE_CATALOG_PROVIDERS = 128;
const MAX_OPENCODE_PROVIDER_MODELS = 512;

interface OpenCodeCatalogModelGroup {
  providerId: string;
  models: Record<string, unknown>[];
}

interface OpenCodeCatalogModelSource {
  providerId: string;
  model: Record<string, unknown>;
}

function appendOpenCodeCatalogSources(
  target: OpenCodeCatalogModelSource[],
  group: OpenCodeCatalogModelGroup,
  start: number,
  count: number,
): void {
  for (let index = start; index < start + count; index += 1) {
    const model = group.models[index];
    if (model) target.push({ providerId: group.providerId, model });
  }
}

function takeOpenCodeCatalogSources(
  target: OpenCodeCatalogModelSource[],
  groups: readonly OpenCodeCatalogModelGroup[],
  budget: number,
  fairShare: boolean,
): void {
  if (groups.length === 0 || target.length >= budget) return;
  if (!fairShare) {
    for (const group of groups) {
      const room = budget - target.length;
      if (room <= 0) return;
      appendOpenCodeCatalogSources(target, group, 0, Math.min(group.models.length, room));
    }
    return;
  }
  const remaining = budget - target.length;
  const share = Math.max(1, Math.floor(remaining / groups.length));
  const leftovers: Array<{ group: OpenCodeCatalogModelGroup; start: number }> = [];
  for (const group of groups) {
    const room = budget - target.length;
    if (room <= 0) return;
    const take = Math.min(share, group.models.length, room);
    appendOpenCodeCatalogSources(target, group, 0, take);
    if (group.models.length > take) leftovers.push({ group, start: take });
  }
  for (const { group, start } of leftovers) {
    const room = budget - target.length;
    if (room <= 0) return;
    appendOpenCodeCatalogSources(
      target,
      group,
      start,
      Math.min(group.models.length - start, room),
    );
  }
}

function openCodeCatalogSourceId(source: OpenCodeCatalogModelSource): string {
  return `${source.providerId}/${nonEmptyString(source.model.id) ?? ""}`;
}

function reserveOpenCodeDefaultSource(
  selected: OpenCodeCatalogModelSource[],
  groups: readonly OpenCodeCatalogModelGroup[],
  defaultModelId: string | undefined,
  budget: number,
): void {
  if (!defaultModelId || selected.some((source) => openCodeCatalogSourceId(source) === defaultModelId)) {
    return;
  }
  let defaultSource: OpenCodeCatalogModelSource | undefined;
  for (const group of groups) {
    const model = group.models.find((candidate) =>
      `${group.providerId}/${nonEmptyString(candidate.id) ?? ""}` === defaultModelId
    );
    if (!model) continue;
    defaultSource = { providerId: group.providerId, model };
    break;
  }
  if (!defaultSource) return;
  if (selected.length < budget) {
    selected.push(defaultSource);
    return;
  }
  // Replace from the default's own provider when possible so preserving the
  // provider-selected model does not undo fair representation of its siblings.
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    if (selected[index]?.providerId !== defaultSource.providerId) continue;
    selected[index] = defaultSource;
    return;
  }
  // A priority-only raw-cache allocation can fill the budget before the
  // default's non-priority provider is visited. In that case sacrifice the last
  // row, while retaining the hard bound and making the advertised default usable.
  selected[selected.length - 1] = defaultSource;
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
 * `priorityProviders` is for the unfiltered read. OpenCode advertises thousands
 * of models, so the configured allowlist has to be normalized *first* or the
 * durable cache can be truncated to a catalogue that contains none of the
 * providers the user actually selected. Sibling allowlisted providers then
 * share the model budget, so one of them (typically `opencode`) cannot hide
 * another (`opencode-go`) merely by listing first and filling the cap.
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
    .slice(0, MAX_OPENCODE_CATALOG_PROVIDERS);
  const groupForProvider = (
    provider: Record<string, unknown>,
  ): OpenCodeCatalogModelGroup | null => {
    const providerId = nonEmptyString(provider.id);
    if (!providerId) return null;
    const models = openCodeProviderModels(provider.models)
      .slice(0, MAX_OPENCODE_PROVIDER_MODELS)
      .filter((model) => nonEmptyString(model.id) !== null);
    return models.length > 0 ? { providerId, models } : null;
  };
  const priorityGroups: OpenCodeCatalogModelGroup[] = [];
  const otherGroups: OpenCodeCatalogModelGroup[] = [];
  for (const provider of selectableProviders) {
    const group = groupForProvider(provider);
    if (!group) continue;
    if (priorityProviders.size > 0 && isPriority(provider)) priorityGroups.push(group);
    else otherGroups.push(group);
  }
  const selectedSources: OpenCodeCatalogModelSource[] = [];
  if (priorityGroups.length > 0) {
    takeOpenCodeCatalogSources(
      selectedSources,
      priorityGroups,
      MAX_OPENCODE_CATALOG_MODELS,
      true,
    );
    takeOpenCodeCatalogSources(
      selectedSources,
      otherGroups,
      MAX_OPENCODE_CATALOG_MODELS,
      false,
    );
  } else {
    takeOpenCodeCatalogSources(
      selectedSources,
      otherGroups,
      MAX_OPENCODE_CATALOG_MODELS,
      true,
    );
  }
  const defaults = openCodeCatalogDefault(value);
  const selectableDefaultModelId = defaults.modelId
    && isSelectableOpenCodeModelId(defaults.modelId, allowedProviders)
    ? defaults.modelId
    : undefined;
  reserveOpenCodeDefaultSource(
    selectedSources,
    [...priorityGroups, ...otherGroups],
    selectableDefaultModelId,
    MAX_OPENCODE_CATALOG_MODELS,
  );
  // Keep expensive label, capability, and reasoning normalization proportional
  // to the bounded output rather than every model in every accepted provider.
  const models = selectedSources.map(({ providerId, model }): AgentModel => {
    const localId = nonEmptyString(model.id)!;
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
    const modelId = `${providerId}/${localId}`;
    return {
      platform: "opencode",
      id: modelId,
      label: openCodeModelDisplayLabel(modelId, nonEmptyString(model.name)),
      providerLabel: providerId,
      reasoning: [
        { id: "default", label: "Default" },
        ...reasoning,
      ],
      defaultReasoningId: "default",
      supportsSpeed: false,
      // OpenCode has primary agents, not a Build/Plan permission mode.
      supportsMode: false,
      ...(contextWindow ? { contextWindow } : {}),
      ...(typeof input?.image === "boolean"
        ? { supportsImageInput: input.image }
        : typeof model.attachment === "boolean"
          ? { supportsImageInput: model.attachment }
          : {}),
    };
  });
  // OpenCode's own default may name a provider the user excluded. Surfacing it
  // would pre-select a model the picker cannot show, so it is dropped with the
  // rest of that provider's catalogue.
  const selectedModelId = selectableDefaultModelId
    && models.some((model) => model.id === selectableDefaultModelId)
    ? selectableDefaultModelId
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
 * "not connected". This lookup deliberately bypasses the picker and durable
 * cache caps: a connected provider can itself advertise more than 512 models,
 * and truncating it before the exact lookup would reject a model merely because
 * of its listing position.
 *
 * `unknown` covers the builds that do not report connectivity at all, whose
 * prior behaviour was to dispatch.
 */
export function openCodeModelDispatchability(
  value: unknown,
  modelId: string,
): "available" | "unavailable" | "unknown" {
  const connected = asRecord(value)?.connected;
  if (!Array.isArray(connected)) return "unknown";

  const providerId = openCodeModelProviderId(modelId);
  const localModelId = providerId ? modelId.slice(providerId.length + 1) : "";
  const providerConnected = connected.some((candidate) => {
    const connectedProviderId = typeof candidate === "string"
      ? nonEmptyString(candidate)
      : nonEmptyString(asRecord(candidate)?.id);
    return connectedProviderId === providerId;
  });
  if (!providerConnected || !providerId || !localModelId) return "unavailable";

  return openCodeCatalogProviders(value).some((provider) =>
    nonEmptyString(provider.id) === providerId
    && openCodeProviderModels(provider.models).some((model) =>
      nonEmptyString(model.id) === localModelId
    )
  )
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
