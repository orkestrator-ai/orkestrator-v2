import { isSelectableOpenCodeModelId } from "@orkestrator/protocol/native-agent";
import type { AppConfig } from "./models.js";

type JsonRecord = Record<string, unknown>;

/**
 * Local structural guard.
 *
 * `storage-shared-core.ts` exports an identical one, but importing it here would
 * close an import cycle: that module re-exports this one so the shared surface
 * stays where callers already look for it.
 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every place a previously-chosen OpenCode model id is durably stored.
 *
 * These were all selected from a picker that offered every provider OpenCode
 * advertises, so they are what the allowlist migration has to preserve. Ids
 * belonging to another agent contribute nothing: they carry no `provider/model`
 * separator, so they resolve to no provider.
 */
export function storedOpenCodeModelIds(
  global: JsonRecord,
  repositories: AppConfig["repositories"] | undefined,
): unknown[] {
  // Read the legacy key as well as the migrated block: the allowlist migration
  // runs against a config that may not have been through the agent-settings
  // migration yet, and a provider the user selected from must be preserved
  // whichever shape it is currently stored in.
  const ids: unknown[] = [global.opencodeModel, openCodeModelOf(global)];
  if (Array.isArray(global.favoriteModels)) {
    for (const favorite of global.favoriteModels) {
      if (isRecord(favorite) && favorite.platform === "opencode") {
        ids.push(favorite.modelId);
      }
    }
  }
  if (isRecord(repositories)) {
    for (const repository of Object.values(repositories)) {
      if (isRecord(repository)) ids.push(repository.defaultModel, openCodeModelOf(repository));
    }
  }
  return ids;
}

/** The OpenCode model id inside a migrated tier, if it has one. */
function openCodeModelOf(tier: JsonRecord): unknown {
  const settings = tier.agentSettings;
  if (!isRecord(settings)) return undefined;
  const platforms = settings.platforms;
  if (!isRecord(platforms)) return undefined;
  const opencode = platforms.opencode;
  return isRecord(opencode) ? opencode.model : undefined;
}

/** The OpenCode default a fresh install ships with. */
export const DEFAULT_OPENCODE_MODEL_ID = "opencode/claude-sonnet-5";

/** Whether an OpenCode id contains both a provider and a non-blank model. */
function isConcreteOpenCodeModelId(modelId: string): boolean {
  const separator = modelId.indexOf("/");
  return separator > 0 && modelId.slice(separator + 1).trim().length > 0;
}

/**
 * Keep a stored default OpenCode model inside the configured provider allowlist.
 *
 * A default naming an excluded provider is unreachable rather than merely
 * unusual: no picker lists it, so the user cannot replace it there, while
 * environment launches and build pipelines keep dispatching it. It can only
 * arise from a catalogue the user has since narrowed, so it is repointed at the
 * first OpenCode model they already chose that the allowlist still admits —
 * their favourites, then the shipped default.
 *
 * An unrestricted allowlist admits everything and therefore never repoints, a
 * value that is not `provider/model` is left alone rather than reinterpreted
 * (which is also what keeps the `"default"` sentinel intact), and a stored id
 * survives when nothing selectable is on hand: inventing a model the user never
 * picked would be worse than an unreachable one.
 */
export function selectableOpenCodeDefaultModel(
  storedModelId: unknown,
  favoriteModels: readonly { platform: string; modelId: string }[],
  allowedProviders: readonly string[],
): unknown {
  if (typeof storedModelId !== "string") return storedModelId;
  const stored = storedModelId.trim();
  if (!stored.includes("/") || isSelectableOpenCodeModelId(stored, allowedProviders)) {
    return storedModelId;
  }
  return (
    [
      ...favoriteModels
        .filter((favorite) => favorite.platform === "opencode")
        .map((favorite) => favorite.modelId),
      DEFAULT_OPENCODE_MODEL_ID,
    ].find(
      (modelId) =>
        isConcreteOpenCodeModelId(modelId) &&
        isSelectableOpenCodeModelId(modelId, allowedProviders),
    ) ?? storedModelId
  );
}

/**
 * Apply the allowlist repointing to every repository-scoped OpenCode default.
 *
 * A repository's OpenCode model is read *before* the global one on both paths
 * the global repointing exists for — `connectionDefaultsFor` in the build
 * pipeline and the startup-agent launch in `native-agent-service-reconciliation`
 * — so normalizing only the global default leaves the unreachable id in charge
 * for any repository that set one.
 *
 * Since the agent-settings migration this reads `platforms.opencode.model`,
 * which removes the guesswork the previous version needed: the old
 * `defaultModel` was one field shared by every agent, so it had to infer
 * whether the repository's effective agent was OpenCode before daring to
 * reinterpret the value as `provider/model`. A model in the `opencode` column
 * is an OpenCode model by construction.
 *
 * Returns the original reference when nothing changed, so callers can use
 * identity to decide whether the config needs rewriting at all.
 */
export function normalizeOpenCodeRepositoryDefaults<T>(
  repositories: T,
  favoriteModels: readonly { platform: string; modelId: string }[],
  allowedProviders: readonly string[],
): T {
  if (!isRecord(repositories)) return repositories;
  let changed = false;
  const next: JsonRecord = {};
  for (const [id, repository] of Object.entries(repositories)) {
    const stored = isRecord(repository) ? openCodeModelOf(repository) : undefined;
    if (stored === undefined) {
      next[id] = repository;
      continue;
    }
    const model = selectableOpenCodeDefaultModel(stored, favoriteModels, allowedProviders);
    if (model === stored) {
      next[id] = repository;
      continue;
    }
    changed = true;
    const settings = (repository as JsonRecord).agentSettings as JsonRecord;
    const platforms = settings.platforms as JsonRecord;
    next[id] = {
      ...(repository as JsonRecord),
      agentSettings: {
        ...settings,
        platforms: {
          ...platforms,
          opencode: { ...(platforms.opencode as JsonRecord), model },
        },
      },
    };
  }
  return changed ? (next as T) : repositories;
}
