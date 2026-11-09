/**
 * The model catalogue and reasoning effort of OpenCode 2.x sessions
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 5).
 *
 * - **Source.** `GET /api/model` lists the chat models of every provider the
 *   server can serve now (2.x lists no model of an unconnected provider), and
 *   `GET /api/model/default` the model a new session starts on. Both answers
 *   carry each provider's settings, API key included, so every row is read
 *   field by field and nothing else leaves this module.
 * - **Effort.** A 2.x model's `variants` are its reasoning axis
 *   (`Model.Ref.variant`), offered after the shared `default` row. A session
 *   switched with no variant runs OpenCode's `default` (observed on 2.2.6).
 * - **The allowlist.** The user's `openCodeModelProviders` is applied before
 *   the cap, as on 1.x, so an excluded provider cannot crowd the picker.
 * - **Validation is ours.** `POST /api/session/:id/model` answers 204 for a
 *   model or variant the server does not know (observed on 2.2.6), so a
 *   selection is checked against this catalogue before it is sent.
 */
import {
  isSelectableOpenCodeProvider,
  openCodeModelDisplayLabel,
  reasoningOptionLabel,
  type AgentModel,
  type NativeAgentDefaultModelResolution,
} from "@orkestrator/protocol/native-agent";
import { PromptRejectedError } from "../agent-provider-contract.js";
import type { OpenCode2Client } from "./client.js";
import type { OpenCode2ModelRef } from "./types.js";

/** A catalogue read serves the composer and dispatch for this long. */
export const OPENCODE2_MODEL_CATALOGUE_TTL_MS = 30_000;
const MAX_MODELS = 512;
/** Models remembered for validation, picker rows or not. */
const MAX_KNOWN_MODELS = 4096;
const MAX_VARIANTS = 64;
const MAX_ID_LENGTH = 256;
/** One model row carries settings, costs and variants; a catalogue is large. */
const MAX_CATALOGUE_BYTES = 4 * 1024 * 1024;
/** The shared reasoning row meaning "leave it to the model". */
export const OPENCODE2_DEFAULT_REASONING = "default";

export interface OpenCode2ModelCatalogue {
  models: AgentModel[];
  /** The server's own default, when the allowlist admits it. */
  selectedModelId?: string;
  /** Providers serving at least one listed model. */
  connectedProviderIds: string[];
  /**
   * Variant ids of every model the server can serve, allowlisted or not, for
   * validating a selection: the allowlist shapes the picker, never dispatch.
   */
  variants: ReadonlyMap<string, ReadonlySet<string>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : undefined;
}

/** `provider/model`, split on the first slash only (OpenRouter ids contain their own). */
export function openCode2ModelId(ref: { providerID?: unknown; id?: unknown } | undefined) {
  const providerID = boundedId(ref?.providerID);
  const id = boundedId(ref?.id);
  return providerID && id ? `${providerID}/${id}` : undefined;
}

/** The reasoning selection a session's model ref reports; OpenCode's `default` is ours too. */
export function openCode2ReasoningId(ref: { variant?: unknown } | undefined): string {
  return boundedId(ref?.variant) ?? OPENCODE2_DEFAULT_REASONING;
}

/**
 * Normalize `/api/model` and `/api/model/default` into picker rows. Disabled,
 * non-chat and unaddressable rows are dropped rather than repaired.
 */
export function normalizeOpenCode2ModelCatalogue(
  models: unknown,
  defaultModel: unknown,
  allowedProviders: readonly string[],
): OpenCode2ModelCatalogue {
  const rows = Array.isArray(models) ? models : [];
  const defaultId = openCode2ModelId(record(defaultModel));
  const seen = new Set<string>();
  const connected = new Set<string>();
  const variants = new Map<string, ReadonlySet<string>>();
  const result: AgentModel[] = [];
  for (const candidate of rows) {
    const model = record(candidate);
    if (!model || model.enabled === false) continue;
    if (model.type !== undefined && model.type !== "chat") continue;
    const id = openCode2ModelId(model);
    const providerId = boundedId(model.providerID);
    if (!id || !providerId || seen.has(id) || seen.size >= MAX_KNOWN_MODELS) continue;
    seen.add(id);
    connected.add(providerId);
    const variantIds = (Array.isArray(model.variants) ? model.variants : [])
      .flatMap((variant) => {
        const variantId = boundedId(record(variant)?.id);
        return variantId && variantId !== OPENCODE2_DEFAULT_REASONING ? [variantId] : [];
      })
      .slice(0, MAX_VARIANTS);
    // Every servable model is dispatchable; the allowlist only shapes the picker.
    variants.set(id, new Set(variantIds));
    if (!isSelectableOpenCodeProvider(providerId, allowedProviders)) continue;
    if (result.length >= MAX_MODELS) continue;
    const limit = record(model.limit);
    const context = limit?.context;
    const input = record(model.capabilities)?.input;
    result.push({
      platform: "opencode",
      id,
      label: openCodeModelDisplayLabel(
        id,
        typeof model.name === "string" ? model.name.slice(0, 200) : undefined,
      ),
      providerLabel: providerId,
      reasoning: [
        { id: OPENCODE2_DEFAULT_REASONING, label: "Default" },
        ...variantIds.map((variantId) => ({
          id: variantId,
          label: reasoningOptionLabel(variantId),
        })),
      ],
      defaultReasoningId: OPENCODE2_DEFAULT_REASONING,
      supportsSpeed: false,
      // Plan and Build are agents (the execution profile), not a permission mode.
      supportsMode: false,
      ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0
        ? { contextWindow: context }
        : {}),
      ...(Array.isArray(input) ? { supportsImageInput: input.includes("image") } : {}),
      ...(id === defaultId ? { sessionDefault: true } : {}),
    });
  }
  return {
    models: result,
    ...(defaultId && result.some((model) => model.id === defaultId)
      ? { selectedModelId: defaultId }
      : {}),
    connectedProviderIds: [...connected].slice(0, 512),
    variants,
  };
}

/**
 * The model a new 2.x session starts on, for a configured default (set or
 * unset), resolved against 2.x's own catalogue. 2.x lists only models it can
 * serve now, so a configured model that is missing is replaced (with a
 * substitution the tab shows) by the server's default, else the first picker
 * row; an unset one resolves to that default. An unreadable catalogue keeps
 * the configured model and dispatch reports its availability, as on 1.x.
 */
export function resolveOpenCode2DefaultModel(
  configuredModelId: string | undefined,
  catalogue: OpenCode2ModelCatalogue | undefined,
): NativeAgentDefaultModelResolution {
  const requested = configuredModelId?.trim();
  const named = requested && requested.indexOf("/") > 0 ? requested : undefined;
  if (!catalogue) return named ? { modelId: named } : {};
  if (named && catalogue.variants.has(named)) return { modelId: named };
  const fallback = catalogue.selectedModelId
    ? catalogue.models.find((model) => model.id === catalogue.selectedModelId)
    : catalogue.models[0];
  if (!fallback) return named ? { modelId: named } : {};
  if (!named) return { modelId: fallback.id };
  return {
    modelId: fallback.id,
    substitution: {
      requestedModelId: named,
      modelId: fallback.id,
      message: `${openCodeModelDisplayLabel(named)} isn't available in OpenCode 2 with your sign-ins; using ${fallback.label}.`,
    },
  };
}

/**
 * The model ref to switch a session to, or a refusal before anything is sent.
 * `effort` `default` (or none) is OpenCode's own default variant. A catalogue
 * that could not be read does not block a switch: the selection then goes
 * through as given, as it did before this module existed.
 */
export function openCode2ModelSelection(
  modelId: string,
  effort: string | undefined,
  catalogue: OpenCode2ModelCatalogue | undefined,
): OpenCode2ModelRef {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    throw new PromptRejectedError(`OpenCode model "${modelId}" is not provider/model`);
  }
  const variant =
    effort?.trim() && effort !== OPENCODE2_DEFAULT_REASONING ? effort.trim() : undefined;
  if (catalogue) {
    const known = catalogue.variants.get(modelId);
    if (!known) {
      throw new PromptRejectedError(
        `OpenCode 2 cannot serve "${modelId}" right now. Choose another model or sign its provider in from Settings → OpenCode.`,
      );
    }
    if (variant && !known.has(variant)) {
      throw new PromptRejectedError(
        `"${modelId}" has no "${variant}" reasoning level in OpenCode 2. Choose another.`,
      );
    }
  }
  return {
    providerID: modelId.slice(0, slash),
    id: modelId.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

/** One read of both routes; throws on a refused or malformed answer. */
export async function readOpenCode2ModelCatalogue(
  client: Pick<OpenCode2Client, "api">,
  allowedProviders: readonly string[],
  signal?: AbortSignal,
): Promise<OpenCode2ModelCatalogue> {
  const [models, defaultModel] = await Promise.all([
    client.api<unknown>("GET", "/api/model", "OpenCode model list", {
      maxBytes: MAX_CATALOGUE_BYTES,
      signal,
    }),
    client
      .api<unknown>("GET", "/api/model/default", "OpenCode default model", { signal })
      .catch(() => undefined),
  ]);
  if (!Array.isArray(models)) throw new Error("OpenCode model list is malformed");
  return normalizeOpenCode2ModelCatalogue(models, defaultModel, allowedProviders);
}

/**
 * A TTL cache of the catalogue, keyed by the allowlist it was filtered with,
 * so a settings edit is seen on the next read rather than after the TTL.
 */
export class OpenCode2ModelCatalogueCache {
  private cached: { key: string; at: number; catalogue: OpenCode2ModelCatalogue } | undefined;
  private flight: { key: string; promise: Promise<OpenCode2ModelCatalogue> } | undefined;

  constructor(
    private readonly client: Pick<OpenCode2Client, "api">,
    private readonly allowedProviders: () => Promise<readonly string[]>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = OPENCODE2_MODEL_CATALOGUE_TTL_MS,
  ) {}

  async read(): Promise<OpenCode2ModelCatalogue> {
    const allowed = await this.allowedProviders();
    const key = JSON.stringify(allowed);
    const cached = this.cached;
    if (cached && cached.key === key && this.now() - cached.at < this.ttlMs)
      return cached.catalogue;
    if (this.flight?.key === key) return this.flight.promise;
    const promise = readOpenCode2ModelCatalogue(this.client, allowed)
      .then((catalogue) => {
        this.cached = { key, at: this.now(), catalogue };
        return catalogue;
      })
      .finally(() => {
        if (this.flight?.promise === promise) this.flight = undefined;
      });
    this.flight = { key, promise };
    return promise;
  }

  /** The cached or a fresh catalogue, or undefined when it cannot be read. */
  readOrUndefined(): Promise<OpenCode2ModelCatalogue | undefined> {
    return this.read().catch(() => undefined);
  }

  clear(): void {
    this.cached = undefined;
    this.flight = undefined;
  }
}
