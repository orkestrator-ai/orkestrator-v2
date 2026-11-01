/**
 * The model, effort and speed a launch runs when it starts from saved settings.
 *
 * Every launcher (the renderer's review, Multi Review, build, feature and
 * create-environment dialogs, and the backend's coordinator, CLI and Multi
 * Review button defaults) turns a saved preference into a concrete selection
 * against a model catalogue. They used to do it in two places with different
 * answers; this is the one resolver both sides call.
 *
 * The rules, in order:
 *
 * Model
 * 1. The saved model when a connected catalogue row matches it (by id, alias,
 *    resolved model, or a retired Claude id's successor).
 * 2. No catalogue rows for the platform: the saved model is kept as it is, or
 *    `default` when nothing is saved. There is nothing to correct it against,
 *    and replacing an explicit choice with a placeholder would silently ignore
 *    it.
 * 3. Rows exist but none is connected: `default` (the provider decides).
 * 4. A platform that marks where a new session starts (Pi) whose catalogue
 *    marks no connected row: `default`, left to the session. An unmarked
 *    catalogue says nothing about its first row, which a ChatGPT login can
 *    refuse.
 * 5. Otherwise the connected row marked `sessionDefault`, else the first
 *    connected row: where a tab with no model would start.
 *
 * Effort and speed follow the model:
 * - With a selected row (rules 1 and 5, a launcher's `default` row too), an effort is kept only
 *   when that row offers it, and a saved speed only when the row supports it.
 * - When the model is left to the provider (rules 2 and 4) they are kept: the
 *   provider resolves or clamps them, as it does for a tab.
 * - Rule 3 drops both: nothing connected can honour them.
 * - A model a user picked that the catalogue does not list (a retired model a
 *   restart dialog carries over) keeps its speed, which the provider decides,
 *   but not its effort: effort ids are per model and cannot be checked.
 * - Speed is always dropped on a platform whose composer has no speed control.
 * - A `default` effort is no effort.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import { reportsSessionDefault, resolveCatalogModelId } from "./model-id.js";
import { nativeAgentCapabilities, type AgentModel } from "./native-agent.js";

/** The placeholder id meaning "let the provider choose". */
export const PROVIDER_DEFAULT_MODEL_ID = "default";

/** One catalogue row, in the shape both the renderer and the backend can supply. */
export interface LaunchCatalogEntry {
  id: string;
  resolvedModel?: string;
  aliases?: readonly string[];
  /** Effort ids the model offers; a `default` entry is ignored. */
  efforts: readonly string[];
  supportsSpeed?: boolean;
  /** False when the provider was last reported as not connected. */
  connected?: boolean;
  /** Where a new session with no model starts (Pi's saved default). */
  sessionDefault?: boolean;
}

export interface LaunchPreference {
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export interface LaunchSelection {
  model: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

/** How a model was chosen; decides whether effort and speed can be checked. */
type ModelChoice =
  | { kind: "row"; entry: LaunchCatalogEntry }
  | { kind: "provider" }
  | { kind: "unavailable" }
  /** A picked model a non-empty catalogue does not list (only via the per-model helpers). */
  | { kind: "unlisted" };

function pinned(value: string | undefined): string | undefined {
  return value && value !== PROVIDER_DEFAULT_MODEL_ID ? value : undefined;
}

function connectedRows(entries: readonly LaunchCatalogEntry[]): LaunchCatalogEntry[] {
  return entries.filter((entry) => entry.connected !== false);
}

function leftToSession(agent: AgentPlatform, connected: readonly LaunchCatalogEntry[]): boolean {
  return (
    connected.length > 0 &&
    reportsSessionDefault(agent) &&
    !connected.some((entry) => entry.sessionDefault === true)
  );
}

function chooseModel(
  agent: AgentPlatform,
  entries: readonly LaunchCatalogEntry[] | undefined,
  preferred: string | undefined,
): { model: string; choice: ModelChoice } {
  const saved = pinned(preferred);
  if (!entries || entries.length === 0) {
    return { model: saved ?? PROVIDER_DEFAULT_MODEL_ID, choice: { kind: "provider" } };
  }
  const connected = connectedRows(entries);
  if (connected.length === 0) {
    return { model: PROVIDER_DEFAULT_MODEL_ID, choice: { kind: "unavailable" } };
  }
  const matchedId = resolveCatalogModelId(agent, connected, saved);
  const matched = connected.find((entry) => entry.id === matchedId);
  if (matched) return { model: matched.id, choice: { kind: "row", entry: matched } };
  if (leftToSession(agent, connected)) {
    return { model: PROVIDER_DEFAULT_MODEL_ID, choice: { kind: "provider" } };
  }
  const fallback = connected.find((entry) => entry.sessionDefault === true) ?? connected[0]!;
  return { model: fallback.id, choice: { kind: "row", entry: fallback } };
}

/**
 * How an already chosen model id relates to the catalogue, for a launcher whose
 * user picked the model and now needs that model's effort and speed defaults.
 */
function choiceForModel(
  agent: AgentPlatform,
  entries: readonly LaunchCatalogEntry[] | undefined,
  modelId: string | undefined,
): ModelChoice {
  if (!entries || entries.length === 0) return { kind: "provider" };
  const id = pinned(modelId);
  if (!id) {
    const connected = connectedRows(entries);
    if (connected.length === 0) return { kind: "unavailable" };
    if (leftToSession(agent, connected)) return { kind: "provider" };
    const placeholder = entries.find((entry) => entry.id === PROVIDER_DEFAULT_MODEL_ID);
    // A launcher's own `default` row is a choice with no effort axis.
    return placeholder ? { kind: "row", entry: placeholder } : { kind: "provider" };
  }
  const matchedId = resolveCatalogModelId(agent, entries, id);
  const matched = entries.find((entry) => entry.id === matchedId);
  return matched ? { kind: "row", entry: matched } : { kind: "unlisted" };
}

function effortFor(choice: ModelChoice, preferred: string | undefined): string | undefined {
  const effort = pinned(preferred);
  if (!effort || choice.kind === "unavailable" || choice.kind === "unlisted") return undefined;
  if (choice.kind === "provider") return effort;
  return choice.entry.efforts.includes(effort) ? effort : undefined;
}

function fastModeFor(
  agent: AgentPlatform,
  choice: ModelChoice,
  preferred: boolean | undefined,
): boolean | undefined {
  if (typeof preferred !== "boolean" || !platformHasSpeed(agent)) return undefined;
  if (choice.kind === "unavailable") return undefined;
  if (choice.kind === "provider" || choice.kind === "unlisted") return preferred;
  return choice.entry.supportsSpeed === true ? preferred : undefined;
}

/** Whether this platform's composer owns a Fast/Normal control at all. */
export function platformHasSpeed(agent: AgentPlatform): boolean {
  return nativeAgentCapabilities(agent).composer.speed;
}

/** The concrete selection a saved preference resolves to. See the module rules. */
export function resolveLaunchSelection(
  agent: AgentPlatform,
  preference: LaunchPreference,
  entries: readonly LaunchCatalogEntry[] | undefined,
): LaunchSelection {
  const { model, choice } = chooseModel(agent, entries, preference.model);
  const reasoningEffort = effortFor(choice, preference.reasoningEffort);
  const fastMode = fastModeFor(agent, choice, preference.fastMode);
  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}

/** Rule 1-5's model alone. */
export function resolveLaunchModel(
  agent: AgentPlatform,
  entries: readonly LaunchCatalogEntry[] | undefined,
  preferred: string | undefined,
): string {
  return chooseModel(agent, entries, preferred).model;
}

/** The saved effort a chosen model keeps, or none. */
export function resolveLaunchEffort(
  agent: AgentPlatform,
  entries: readonly LaunchCatalogEntry[] | undefined,
  modelId: string | undefined,
  preferred: string | undefined,
): string | undefined {
  return effortFor(choiceForModel(agent, entries, modelId), preferred);
}

/** The saved speed a chosen model keeps, or none. */
export function resolveLaunchFastMode(
  agent: AgentPlatform,
  entries: readonly LaunchCatalogEntry[] | undefined,
  modelId: string | undefined,
  preferred: boolean | undefined,
): boolean | undefined {
  return fastModeFor(agent, choiceForModel(agent, entries, modelId), preferred);
}

/** One platform's rows of a backend `AgentModel` catalogue; undefined when it has none. */
export function launchCatalogFromAgentModels(
  agent: AgentPlatform,
  models: readonly AgentModel[],
): LaunchCatalogEntry[] | undefined {
  const rows = models.filter((model) => model.platform === agent);
  if (rows.length === 0) return undefined;
  return rows.map((model) => ({
    id: model.id,
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    ...(model.aliases ? { aliases: model.aliases } : {}),
    efforts: (model.reasoning ?? []).map(({ id }) => id),
    ...(model.supportsSpeed ? { supportsSpeed: true } : {}),
    ...(model.connected === false ? { connected: false } : {}),
    ...(model.sessionDefault ? { sessionDefault: true } : {}),
  }));
}
