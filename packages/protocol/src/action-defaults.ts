/**
 * Application-level agent/model defaults for the toolbar actions that can be
 * launched with a single click.
 *
 * Right-clicking those buttons opens a launch dialog that configures the run
 * explicitly, and a plain click has no such surface. Both read the same entry:
 * the dialog opens on it and the click launches it, so the button and the
 * dialog behind it can never name different runs. An entry is a whole decision
 * — platform, model and reasoning level together — because a model id is only
 * meaningful inside its own platform's catalogue.
 */
import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";

export const ACTION_DEFAULT_KEYS = Object.freeze([
  "newProject",
  "review",
  "review2",
  "fixReviewIssues",
  "pr",
  "resolve",
  "push",
] as const);

export type ActionDefaultKey = (typeof ACTION_DEFAULT_KEYS)[number];

export interface AgentActionDefault {
  /** Missing means "use the app's default agent". */
  platform?: AgentPlatform;
  /** Missing means the platform's own default model. */
  model?: string;
  /** Missing means the model's default reasoning level. */
  reasoningEffort?: string;
}

export type ActionDefaults = Partial<Record<ActionDefaultKey, AgentActionDefault>>;

export function isActionDefaultKey(value: unknown): value is ActionDefaultKey {
  return ACTION_DEFAULT_KEYS.includes(value as ActionDefaultKey);
}

/**
 * The id the model-catalogue builder synthesises for OpenCode when no live or
 * cached models exist for a project. No OpenCode server knows it, so pinning it
 * would send a bogus one-shot model and suppress the user's saved OpenCode
 * preference. Claude's `default` is a real catalogue id and must survive.
 */
const OPENCODE_PLACEHOLDER_MODEL = "default";

function normalizeEntry(value: unknown): AgentActionDefault | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const platform = isAgentPlatform(record.platform) ? record.platform : undefined;
  // A model without a platform cannot be resolved against a catalogue, and a
  // reasoning level without a model would be applied to whichever model the
  // fallback chain happened to choose. Both are dropped rather than guessed.
  if (!platform) return undefined;
  const trimmedModel = typeof record.model === "string" ? record.model.trim() : "";
  // Dropping only the model leaves a well-formed entry that means "OpenCode's
  // own default model", which is what the placeholder was standing in for.
  const model =
    platform === "opencode" && trimmedModel === OPENCODE_PLACEHOLDER_MODEL ? "" : trimmedModel;
  const reasoningEffort =
    typeof record.reasoningEffort === "string" ? record.reasoningEffort.trim() : "";
  return {
    platform,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * Keep only well-formed entries. The renderer writes this object wholesale, so
 * an unknown key or a half-filled entry must not reach persisted config.
 */
export function normalizeActionDefaults(value: unknown): ActionDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const normalized: ActionDefaults = {};
  for (const key of ACTION_DEFAULT_KEYS) {
    const entry = normalizeEntry(record[key]);
    if (entry) normalized[key] = entry;
  }
  return normalized;
}

/**
 * The agent, model and reasoning level this action should use.
 *
 * There is deliberately no way to hand this resolver an agent that outranks the
 * entry. It used to take one — the agent an environment was created with — so
 * that an application-level default could not retarget a deliberate per-tier
 * choice. Environments persist that agent unconditionally, so in practice the
 * override was always set and the entry's platform never applied: the launch
 * dialog opened on Settings' choice while the click beside it launched the
 * environment's. `fallbackAgent` is the whole of the generic cascade now, and
 * it is consulted only when this action names nothing usable.
 *
 * A default naming a platform the user has since disabled is ignored whole:
 * carrying its model across to a different platform would send the run to a
 * model that platform does not have.
 */
export function resolveActionDefault(
  actionDefaults: ActionDefaults | undefined,
  key: ActionDefaultKey,
  options: {
    fallbackAgent: AgentPlatform;
    enabledAgents: readonly AgentPlatform[];
  },
): { agent: AgentPlatform; model?: string; reasoningEffort?: string } {
  const entry = actionDefaults?.[key];
  const platform = entry?.platform;
  if (!platform || !options.enabledAgents.includes(platform)) {
    return { agent: options.fallbackAgent };
  }
  return {
    agent: platform,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
  };
}
