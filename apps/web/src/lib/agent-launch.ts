/**
 * The vocabulary shared by every launcher that lets a user pick a native agent,
 * a model and a reasoning effort before starting work.
 *
 * Held here rather than in one dialog so the review launcher and the build
 * launcher cannot drift on what a catalog is or how a default is resolved.
 */
export type LaunchAgent = "claude" | "codex" | "opencode";

export interface AgentModelOption {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts: string[];
}

export type AgentModelCatalog = Record<LaunchAgent, AgentModelOption[]>;

export const LAUNCH_AGENT_OPTIONS: Array<{ value: LaunchAgent; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
];

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
  const models = catalog[agent];
  const preferred = preferredModels?.[agent];
  return models.some((model) => model.id === preferred)
    ? preferred!
    : (models[0]?.id ?? "default");
}

export function defaultEffortFor(
  agent: LaunchAgent,
  modelId: string,
  catalog: AgentModelCatalog,
  preferredEfforts?: Partial<Record<LaunchAgent, string>>,
): string {
  const options =
    catalog[agent].find((model) => model.id === modelId)?.reasoningEfforts ?? [];
  const preferred = preferredEfforts?.[agent];
  return preferred && options.includes(preferred) ? preferred : "default";
}

export function effortLabel(effort: string): string {
  return effort === "xhigh"
    ? "Extra high"
    : effort.charAt(0).toUpperCase() + effort.slice(1);
}
