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
  const ids: unknown[] = [global.opencodeModel];
  if (Array.isArray(global.favoriteModels)) {
    for (const favorite of global.favoriteModels) {
      if (isRecord(favorite) && favorite.platform === "opencode") {
        ids.push(favorite.modelId);
      }
    }
  }
  if (isRecord(repositories)) {
    for (const repository of Object.values(repositories)) {
      if (isRecord(repository)) ids.push(repository.defaultModel);
    }
  }
  return ids;
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
 * The agent a repository's `defaultModel` was chosen for.
 *
 * Mirrors `repositoryAgent` in `build-pipeline-service-helpers.ts`. It is
 * duplicated rather than imported because that module sits above storage in the
 * dependency order, and normalization runs while the config is still being
 * loaded.
 */
function repositoryDefaultAgent(repository: JsonRecord, globalDefaultAgent: unknown): unknown {
  return repository.defaultAgent ?? globalDefaultAgent ?? "claude";
}

/**
 * Apply the allowlist repointing to every repository-scoped OpenCode default.
 *
 * `repository.defaultModel` is read *before* `global.opencodeModel` on both
 * paths the global repointing exists for — `connectionDefaultsFor` in the build
 * pipeline and the startup-agent launch in `native-agent-service-reconciliation`
 * — so normalizing only the global default leaves the unreachable id in charge
 * for any repository that set one.
 *
 * Only a repository whose effective agent is OpenCode is touched. The field
 * holds a single model id shared by every agent, so a Claude or Codex id must
 * not be reinterpreted as `provider/model` and repointed at an OpenCode model.
 *
 * Returns the original reference when nothing changed, so callers can use
 * identity to decide whether the config needs rewriting at all.
 */
export function normalizeOpenCodeRepositoryDefaults<T>(
  repositories: T,
  globalDefaultAgent: unknown,
  favoriteModels: readonly { platform: string; modelId: string }[],
  allowedProviders: readonly string[],
): T {
  if (!isRecord(repositories)) return repositories;
  let changed = false;
  const next: JsonRecord = {};
  for (const [id, repository] of Object.entries(repositories)) {
    if (
      !isRecord(repository) ||
      repositoryDefaultAgent(repository, globalDefaultAgent) !== "opencode"
    ) {
      next[id] = repository;
      continue;
    }
    const defaultModel = selectableOpenCodeDefaultModel(
      repository.defaultModel,
      favoriteModels,
      allowedProviders,
    );
    if (defaultModel === repository.defaultModel) {
      next[id] = repository;
      continue;
    }
    changed = true;
    next[id] = { ...repository, defaultModel };
  }
  return changed ? (next as T) : repositories;
}
