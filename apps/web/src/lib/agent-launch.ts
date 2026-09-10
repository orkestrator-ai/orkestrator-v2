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

export type LaunchAgent = AgentPlatform;

export interface AgentModelOption {
  id: string;
  name: string;
  /** Provider caption shown beneath the model name in the shared picker. */
  providerLabel?: string;
  description?: string;
  reasoningEfforts: string[];
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
 * The catalog id for a configured model preference, if the catalog still offers
 * it.
 *
 * Matched on the catalog id first and on the resolved model second, because
 * configuration and the catalog do not share an id space: the global Claude
 * default is stored as `claude-sonnet-5` while the catalog lists that model
 * under `sonnet`. Without the second pass every Claude preference misses and the
 * launcher silently falls back to the first entry.
 */
function catalogIdFor(
  models: AgentModelOption[],
  preferred: string | undefined,
): string | undefined {
  if (!preferred) return undefined;
  if (models.some((model) => model.id === preferred)) return preferred;
  return models.find((model) => model.resolvedModel === preferred)?.id;
}

/**
 * The preferred model when the catalog still offers it, otherwise the first one.
 *
 * A configured default can name a model the running agent no longer exposes;
 * passing it through would send the run to a model that does not exist.
 */
export function firstModelFor(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels?: Partial<Record<LaunchAgent, string>>,
): string {
  const models = modelsForAgent(catalog, agent);
  return catalogIdFor(models, preferredModels?.[agent]) ?? models[0]?.id ?? "default";
}

export function defaultEffortFor(
  agent: LaunchAgent,
  modelId: string,
  catalog: AgentModelCatalog,
  preferredEfforts?: Partial<Record<LaunchAgent, string>>,
): string {
  const options =
    modelsForAgent(catalog, agent).find((model) => model.id === modelId)?.reasoningEfforts ?? [];
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
