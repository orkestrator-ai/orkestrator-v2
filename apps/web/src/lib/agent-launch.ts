/**
 * The vocabulary shared by every launcher that lets a user pick a native agent,
 * a model and a reasoning effort before starting work.
 *
 * Held here rather than in one dialog so the review launcher and the build
 * launcher cannot drift on what a catalog is or how a default is resolved.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  nativeAgentCapabilities,
  resolveReasoningId,
  type AgentModel,
} from "@orkestrator/protocol/native-agent";
export { resolveCatalogModelId, sessionDefaultModel } from "@orkestrator/protocol/model-id";
import { resolveCatalogModelId, sessionDefaultModel } from "@orkestrator/protocol/model-id";

export type LaunchAgent = AgentPlatform;

export interface AgentModelOption {
  id: string;
  name: string;
  /** Provider caption shown beneath the model name in the shared picker. */
  providerLabel?: string;
  description?: string;
  reasoningEfforts: string[];
  /** False when the provider was last reported as not connected. */
  connected?: boolean;
  /**
   * The concrete model this catalog id resolves to on the bridge.
   *
   * Configuration stores a model in this resolved space (`claude-sonnet-5`)
   * while the catalog is keyed by alias (`sonnet`), so a preference can only be
   * matched against the catalog through this field. Absent for harnesses whose
   * catalog ids are already the concrete model.
   */
  resolvedModel?: string;
  /** True when this model exposes a Fast/Normal speed toggle. */
  supportsSpeed?: boolean;
  /** Where a new session with no model starts (Pi's saved default). */
  sessionDefault?: boolean;
}

export type AgentModelCatalog = Record<"claude" | "codex" | "opencode", AgentModelOption[]> &
  Partial<Record<"cursor" | "grok" | "pi", AgentModelOption[]>>;

export function modelsForAgent(catalog: AgentModelCatalog, agent: LaunchAgent): AgentModelOption[] {
  return catalog[agent] ?? [{ id: "default", name: "Default", reasoningEfforts: [] }];
}

export const LAUNCH_AGENT_OPTIONS: Array<{ value: LaunchAgent; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor Agent" },
  { value: "grok", label: "Grok Build" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
];

/**
 * The preferred connected model when offered, otherwise the connected one a
 * tab with no model would start on (`sessionDefault`, Pi's saved default),
 * otherwise the first connected one.
 *
 * A configured default can name a model the running agent no longer exposes;
 * passing it through would send the run to an unavailable model. Cached rows
 * explicitly marked disconnected are never implicit launcher selections.
 */
export function firstModelFor(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels?: Partial<Record<LaunchAgent, string>>,
): string {
  const models = modelsForAgent(catalog, agent).filter((model) => model.connected !== false);
  return (
    resolveCatalogModelId(agent, models, preferredModels?.[agent]) ??
    sessionDefaultModel(models)?.id ??
    "default"
  );
}

export function defaultEffortFor(
  agent: LaunchAgent,
  modelId: string,
  catalog: AgentModelCatalog,
  preferredEfforts?: Partial<Record<LaunchAgent, string>>,
): string {
  const models = modelsForAgent(catalog, agent);
  const resolvedModelId = resolveCatalogModelId(agent, models, modelId);
  const options = models.find((model) => model.id === resolvedModelId)?.reasoningEfforts ?? [];
  const preferred = preferredEfforts?.[agent];
  // Launch dialogs always offer Default as a selectable setting, so the shared
  // fallback prefers it over high unless a still-supported preference hits.
  return (
    resolveReasoningId(options.length > 0 ? ["default", ...options] : ["default"], preferred) ??
    "default"
  );
}

export function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Map a launch-catalog option into the shared picker model shape.
 *
 * Settings and launchers share this so `supportsSpeed` cannot be dropped on
 * the way into `AgentModelPicker`.
 *
 * The row caption is `providerLabel`, falling back to `description` and only
 * then to the platform name. That fallback is deliberate and applies to every
 * picker: Claude and Codex catalogue entries carry a description but no
 * provider, so without it their rows would all read "Claude"/"Codex" and the
 * one thing distinguishing them — what the model is for — would be dropped.
 * The review and build launchers already resolved the caption this way; the
 * other pickers did not, and that inconsistency is what this mapper removes.
 */
export function toPickerModel(platform: LaunchAgent, option: AgentModelOption): AgentModel {
  return {
    platform,
    id: option.id,
    label: option.name,
    ...(option.providerLabel || option.description
      ? { providerLabel: option.providerLabel ?? option.description }
      : {}),
    ...(option.description ? { description: option.description } : {}),
    ...(option.reasoningEfforts.length > 0
      ? {
          reasoning: option.reasoningEfforts.map((effort) => ({
            id: effort,
            label: effortLabel(effort),
          })),
        }
      : {}),
    ...(option.supportsSpeed ? { supportsSpeed: true } : {}),
    ...(option.connected === false ? { connected: false } : {}),
  };
}

/** Whether this platform's composer owns a Fast/Normal surface. */
export function platformOwnsSpeed(platform: LaunchAgent): boolean {
  return nativeAgentCapabilities(platform).composer.speed;
}

/** Whether the effective model can honour a stored Fast/Normal default. */
export function modelSupportsSpeed(
  platform: LaunchAgent,
  catalog: AgentModelCatalog,
  modelId: string | undefined,
): boolean {
  if (!platformOwnsSpeed(platform)) return false;
  // With no pin or no catalogue match, the provider is the authority. A
  // missing/stale catalogue must not silently turn an explicit Fast choice
  // into Normal before the launch reaches that provider.
  if (!modelId) return true;
  const model = modelsForAgent(catalog, platform).find(
    (option) => option.id === modelId || option.resolvedModel === modelId,
  );
  return model ? model.supportsSpeed === true : true;
}

/**
 * Initial Fast/Normal value for a launch picker.
 *
 * Absence means either the selected model has no speed axis or no settings tier
 * chooses an override. Pickers render that unset state as Normal, but launches
 * keep it unset so the provider's own default is not replaced merely by opening
 * a dialog.
 */
export function defaultFastModeFor(
  platform: LaunchAgent,
  modelId: string | undefined,
  catalog: AgentModelCatalog,
  preferredFastModes?: Partial<Record<LaunchAgent, boolean>>,
): boolean | undefined {
  if (!modelSupportsSpeed(platform, catalog, modelId)) return undefined;
  return preferredFastModes?.[platform];
}
