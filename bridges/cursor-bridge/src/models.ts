/**
 * Model discovery, normalized into the composer contract every platform shares.
 *
 * Cursor describes a model with *parameters* (`effort`, `fast`, `thinking`,
 * `context`) and with pre-combined *variants*. The variants are the cross
 * product — `claude-opus-5` ships thirty-two of them, every one labelled
 * "Claude Opus 5" — so they make a useless picker. The parameters are the
 * meaningful axes, and two of them map exactly onto controls the shared
 * composer already has. The shared protocol now also carries every remaining
 * SDK parameter, so future Cursor axes do not require another bridge change:
 *
 *   `effort` → the reasoning axis, the same low/medium/high/xhigh/max the
 *              Codex picker shows, so an app-level effort default carries over
 *   `fast`   → the speed toggle
 *
 * `thinking`, `context`, and `cyber` are generic model parameters. The
 * pre-combined variants stay off the input bar — they are only used to read
 * vendor defaults such as the starting effort.
 */
import { Cursor, type ModelListItem, type ModelSelection } from "@cursor/sdk";
import type { AgentModel, NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import { CATALOG_TIMEOUT_MS, MAX_MODEL_ID_BYTES } from "./config.js";
import { resolveCredential } from "./credentials.js";

/** Offered when the catalogue cannot be read, so a session can still start. */
export const FALLBACK_MODEL_ID = "composer-2";

let catalogCache: AgentModel[] | null = null;
let catalogProbe: Promise<AgentModel[]> | null = null;
let catalogGeneration = 0;
let cursorModels = Cursor.models;

export function useCursorModelsForTests(models: typeof Cursor.models): () => void {
  const previous = cursorModels;
  cursorModels = models;
  catalogCache = null;
  catalogProbe = null;
  catalogGeneration += 1;
  return () => {
    cursorModels = previous;
    catalogCache = null;
    catalogProbe = null;
    catalogGeneration += 1;
  };
}

export function emptyComposer(): NativeAgentComposerState {
  return {
    models: [],
    fastModeEnabled: null,
    fastModeAvailable: false,
    // The SDK's conversation modes are exactly the two the shared composer
    // already models, so plan/build needs no translation beyond the label.
    modes: [
      { id: "build", label: "Agent" },
      { id: "plan", label: "Plan" },
    ],
    selectedModeId: "build",
  };
}

/**
 * Read the model catalogue, memoized for the life of the bridge process.
 *
 * The credential is passed explicitly. `Cursor.models.list()` falls back to
 * `CURSOR_API_KEY` and then to the SDK's *default* credential path — and this
 * bridge deliberately stores its login somewhere else, so the ambient lookup
 * finds nothing and the whole catalogue comes back empty. That failure is
 * invisible from the outside: the picker just says "No models available".
 *
 * Only a non-empty result is cached. Caching an empty one would pin that same
 * invisible failure for the life of the process, so an outage or a sign-in
 * that lands after the first read can never recover.
 */
export async function listModels(): Promise<AgentModel[]> {
  if (catalogCache) return catalogCache;
  if (!catalogProbe) {
    const generation = catalogGeneration;
    const modelsClient = cursorModels;
    const probe = (async () => {
      const { apiKey } = await resolveCredential();
      if (!apiKey) return [];
      const items = await withTimeout(modelsClient.list({ apiKey }), CATALOG_TIMEOUT_MS);
      const models = items.map(normalizeModel).filter((model) => model.id.length > 0);
      if (generation === catalogGeneration && models.length > 0) catalogCache = models;
      return models;
    })();
    catalogProbe = probe;
    void probe.then(
      () => {
        if (catalogProbe === probe) catalogProbe = null;
      },
      () => {
        if (catalogProbe === probe) catalogProbe = null;
      },
    );
  }
  return catalogProbe.catch(() => []);
}

/** Drop the memo so the next read re-discovers. */
export function refreshModels(): void {
  catalogCache = null;
  catalogProbe = null;
  catalogGeneration += 1;
}

/** Cursor's name for the axis the shared composer calls "reasoning". */
const EFFORT_PARAMETER = "effort";
/** Cursor's name for the axis the shared composer calls "speed". */
const FAST_PARAMETER = "fast";

/**
 * Provider context-window sizes the Cursor catalogue does not carry.
 *
 * `ModelListItem` has no window field and `TokenUsage` reports spend only, so
 * without this table `publicContextUsage` can never emit `maximumTokens` and
 * the info pane shows metrics without a context bar. Entries are limited to
 * windows confirmed by the provider's own docs — an unknown model keeps the
 * metrics-only rendering rather than a bar scaled against a guess:
 *
 * - `grok-4-6`: 500,000 (xAI; Cursor's Grok 4.6 model page).
 * - `claude-opus-5`, `claude-sonnet-5`, `claude-sonnet-4-6`: 1,000,000
 *   (Anthropic context-window docs: 1M is both the default and the maximum).
 */
const KNOWN_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["grok-4-6", 500_000],
  ["claude-opus-5", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
]);

/**
 * The context window for a Cursor model id, if one is confirmed above.
 *
 * Normalizes separators and case (`grok-4.6` → `grok-4-6`) and ignores the
 * `-fast` speed suffix, which selects a pricing variant of the same model
 * rather than a different window. Returns `undefined` for anything not
 * confirmed — the caller must render metrics-only, never invent a window.
 *
 * The id is untrusted: `parseComposerPatch` accepts whatever model the client
 * names without checking it against the catalogue, so a session can carry an
 * id no provider ever published. The table is a `Map` for that reason — an
 * object literal answers inherited keys such as `constructor` with a function,
 * which would satisfy the `number` return type only until something used it.
 */
export function contextWindowForModelId(modelId: string | undefined): number | undefined {
  const normalized = (modelId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[._]+/g, "-")
    .replace(/-fast$/, "");
  if (!normalized) return undefined;
  return KNOWN_CONTEXT_WINDOWS.get(normalized);
}

function normalizeModel(item: ModelListItem): AgentModel {
  const reasoning = reasoningOptions(item);
  const supportsSpeed = item.parameters?.some((parameter) => parameter.id === FAST_PARAMETER);
  const contextWindow = contextWindowForModelId(item.id);
  const defaults = new Map(
    item.variants
      ?.find((variant) => variant.isDefault)
      ?.params.map((param) => [param.id, param.value]),
  );
  const parameters: NonNullable<AgentModel["parameters"]> = (item.parameters ?? [])
    .filter((parameter) => parameter.id !== EFFORT_PARAMETER && parameter.id !== FAST_PARAMETER)
    .map((parameter) => {
      const boolean =
        parameter.values.length === 2 &&
        parameter.values.every((value) => value.value === "true" || value.value === "false");
      return {
        id: parameter.id,
        label: parameter.displayName?.trim() || parameter.id,
        kind: boolean ? ("toggle" as const) : ("select" as const),
        ...(boolean
          ? {}
          : {
              options: parameter.values.map((value) => ({
                id: value.value,
                label: value.displayName?.trim() || value.value,
              })),
            }),
        ...(defaults.has(parameter.id)
          ? {
              defaultValue: boolean
                ? defaults.get(parameter.id) === "true"
                : defaults.get(parameter.id),
            }
          : {}),
        scope: "turn" as const,
      };
    });
  return {
    platform: "cursor",
    id: boundId(item.id),
    label: item.displayName?.trim() || item.id,
    providerLabel: "Cursor",
    ...(item.description?.trim() ? { description: item.description.trim() } : {}),
    ...(reasoning.length > 0
      ? { reasoning, defaultReasoningId: defaultEffort(item, reasoning) }
      : {}),
    ...(supportsSpeed ? { supportsSpeed: true } : {}),
    ...(item.aliases?.length ? { aliases: item.aliases.slice(0, 32) } : {}),
    ...(parameters.length ? { parameters } : {}),
    // The catalogue carries no window field, so confirmed sizes come from the
    // curated table above. Absent stays absent: the usage meter renders
    // metrics-only rather than a bar scaled against a guess.
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    supportsMode: true,
    // Cursor accepts image blocks on every model it exposes here, and the
    // catalogue carries no field that says otherwise. Claiming support the
    // provider never advertised would be a guess, so this stays unset and the
    // renderer keeps its own default.
  };
}

/** The `effort` values this model offers, as the shared reasoning axis. */
function reasoningOptions(item: ModelListItem): Array<{ id: string; label: string }> {
  const effort = item.parameters?.find((parameter) => parameter.id === EFFORT_PARAMETER);
  if (!effort?.values?.length) return [];
  return effort.values.map((value) => ({
    id: value.value,
    label: value.displayName?.trim() || value.value,
  }));
}

/**
 * The effort the vendor's own default variant uses.
 *
 * Read from the variant marked default rather than guessed, so a fresh session
 * starts where Cursor itself would. Falls back to the first offered value when
 * no variant claims to be the default.
 */
function defaultEffort(item: ModelListItem, reasoning: ReadonlyArray<{ id: string }>): string {
  const preferred = item.variants?.find((variant) => variant.isDefault);
  const effort = preferred?.params.find((param) => param.id === EFFORT_PARAMETER)?.value;
  return effort && reasoning.some((option) => option.id === effort) ? effort : reasoning[0]!.id;
}

/**
 * Build the SDK model selection for a composer state.
 *
 * A parameter is only sent when the selected model actually declares it. The
 * SDK rejects the whole send on an unknown parameter, so forwarding a stale
 * effort onto a model that has no effort axis would fail the turn rather than
 * quietly ignore the setting.
 */
export function modelSelection(composer: NativeAgentComposerState): ModelSelection {
  const id = composer.selectedModelId?.trim() || FALLBACK_MODEL_ID;
  const model = composer.models.find((entry) => entry.id === id);
  const params: Array<{ id: string; value: string }> = [];

  const effort = composer.selectedReasoningId?.trim();
  if (effort && model?.reasoning?.some((option) => option.id === effort)) {
    params.push({ id: EFFORT_PARAMETER, value: effort });
  }
  if (typeof composer.fastModeEnabled === "boolean" && model?.supportsSpeed) {
    params.push({ id: FAST_PARAMETER, value: String(composer.fastModeEnabled) });
  }
  for (const parameter of model?.parameters ?? []) {
    if (parameter.id === EFFORT_PARAMETER || parameter.id === FAST_PARAMETER) continue;
    const value = composer.parameterValues?.[parameter.id];
    if (typeof value === "string" || typeof value === "boolean") {
      params.push({ id: parameter.id, value: String(value) });
    }
  }
  return params.length > 0 ? { id, params } : { id };
}

/**
 * Fill in a composer with the live catalogue, preserving any explicit choice.
 *
 * A selection the catalogue does not contain is kept rather than corrected:
 * the user chose it, the catalogue read may have been partial, and the SDK is
 * the authority on whether the id is valid.
 */
export async function hydrateComposer(
  composer: NativeAgentComposerState,
): Promise<NativeAgentComposerState> {
  const models = await listModels();
  return hydrateComposerWithModels(composer, models);
}

function hydrateComposerWithModels(
  composer: NativeAgentComposerState,
  models: AgentModel[],
): NativeAgentComposerState {
  const selectedModelId = composer.selectedModelId ?? models[0]?.id ?? FALLBACK_MODEL_ID;
  const selected = models.find((model) => model.id === selectedModelId);
  const parameterValues = { ...composer.parameterValues };
  // Drop a leftover encoded cross-product so it cannot revive the picker.
  delete parameterValues.variant;
  return {
    ...composer,
    models,
    selectedModelId,
    selectedReasoningId: composer.selectedReasoningId ?? selected?.defaultReasoningId ?? undefined,
    // Availability follows the selected model: only some of Cursor's models
    // expose a `fast` parameter, and offering the toggle on one that does not
    // would show a control the provider cannot honour.
    fastModeAvailable: selected?.supportsSpeed === true,
    parameterValues: {
      ...parameterValues,
      ...(composer.selectedReasoningId ? { effort: composer.selectedReasoningId } : {}),
      ...(typeof composer.fastModeEnabled === "boolean" ? { fast: composer.fastModeEnabled } : {}),
    },
  };
}

export const __testing = {
  hydrateComposerWithModels,
  normalizeModel,
};

function boundId(value: string): string {
  const trimmed = value?.trim() ?? "";
  return Buffer.byteLength(trimmed) > MAX_MODEL_ID_BYTES ? "" : trimmed;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cursor catalogue read timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
