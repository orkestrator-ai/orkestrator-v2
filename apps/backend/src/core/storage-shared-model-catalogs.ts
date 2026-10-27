import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type {
  AgentModelCatalogCache,
  ClaudeModelCatalogEntry,
  ClaudeModelCatalogSnapshot,
  CodexModelCatalogEntry,
  CodexReasoningEffort,
} from "./models.js";
import { isNonBlankString, isOneOf, isRecord } from "./storage-shared-core.js";

export function isClaudeModelCatalogSnapshot(
  value: unknown,
  environmentId: string,
): value is ClaudeModelCatalogSnapshot {
  if (
    !isRecord(value) ||
    value.environmentId !== environmentId ||
    !Array.isArray(value.models) ||
    !isOneOf(value.source, ["sdk", "last-known-good", "fallback"]) ||
    typeof value.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(value.fetchedAt)) ||
    typeof value.stale !== "boolean"
  ) {
    return false;
  }

  const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
  return (
    value.models.every((model) => {
      if (!isRecord(model) || !isNonBlankString(model.id) || !isNonBlankString(model.name)) {
        return false;
      }
      const optionalStrings = ["resolvedModel", "description"] as const;
      if (
        optionalStrings.some(
          (field) => field in model && model[field] != null && typeof model[field] !== "string",
        )
      ) {
        return false;
      }
      const optionalBooleans = [
        "supportsFastMode",
        "supportsEffort",
        "supportsAdaptiveThinking",
        "supportsAutoMode",
      ] as const;
      if (
        optionalBooleans.some(
          (field) => field in model && model[field] != null && typeof model[field] !== "boolean",
        )
      ) {
        return false;
      }
      return (
        !("supportedEffortLevels" in model) ||
        model.supportedEffortLevels == null ||
        (Array.isArray(model.supportedEffortLevels) &&
          model.supportedEffortLevels.every((level) => isOneOf(level, effortLevels)))
      );
    }) &&
    (value.sdkVersion == null || typeof value.sdkVersion === "string") &&
    (value.cliVersion == null || typeof value.cliVersion === "string") &&
    (value.error == null || typeof value.error === "string")
  );
}

export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const satisfies readonly CodexReasoningEffort[];

export function normalizeClaudeModelCatalogEntries(value: unknown): ClaudeModelCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const normalized: ClaudeModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = isNonBlankString(candidate.id) ? candidate.id.trim() : "";
    const name = isNonBlankString(candidate.name) ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;

    const optionalStrings = ["resolvedModel", "description"] as const;
    if (
      optionalStrings.some(
        (field) =>
          field in candidate && candidate[field] != null && typeof candidate[field] !== "string",
      )
    ) {
      continue;
    }
    const optionalBooleans = [
      "supportsFastMode",
      "supportsEffort",
      "supportsAdaptiveThinking",
      "supportsAutoMode",
    ] as const;
    if (
      optionalBooleans.some(
        (field) =>
          field in candidate && candidate[field] != null && typeof candidate[field] !== "boolean",
      )
    ) {
      continue;
    }
    const supportedEffortLevels = candidate.supportedEffortLevels;
    if (
      supportedEffortLevels != null &&
      (!Array.isArray(supportedEffortLevels) ||
        !supportedEffortLevels.every((level) =>
          isOneOf(level, ["low", "medium", "high", "xhigh", "max"] as const),
        ))
    ) {
      continue;
    }

    seen.add(id);
    normalized.push({
      id,
      ...(isNonBlankString(candidate.resolvedModel)
        ? { resolvedModel: candidate.resolvedModel.trim() }
        : {}),
      name,
      ...(isNonBlankString(candidate.description)
        ? { description: candidate.description.trim() }
        : {}),
      ...(typeof candidate.supportsFastMode === "boolean"
        ? { supportsFastMode: candidate.supportsFastMode }
        : {}),
      ...(typeof candidate.supportsEffort === "boolean"
        ? { supportsEffort: candidate.supportsEffort }
        : {}),
      ...(Array.isArray(supportedEffortLevels)
        ? { supportedEffortLevels: [...supportedEffortLevels] }
        : {}),
      ...(typeof candidate.supportsAdaptiveThinking === "boolean"
        ? { supportsAdaptiveThinking: candidate.supportsAdaptiveThinking }
        : {}),
      ...(typeof candidate.supportsAutoMode === "boolean"
        ? { supportsAutoMode: candidate.supportsAutoMode }
        : {}),
    });
  }
  return normalized;
}

export function normalizeCodexModelCatalogEntries(value: unknown): CodexModelCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const normalized: CodexModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = isNonBlankString(candidate.id) ? candidate.id.trim() : "";
    const name = isNonBlankString(candidate.name) ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    if (
      "description" in candidate &&
      candidate.description != null &&
      typeof candidate.description !== "string"
    ) {
      continue;
    }

    const reasoningEfforts = Array.isArray(candidate.reasoningEfforts)
      ? candidate.reasoningEfforts.filter((effort): effort is CodexReasoningEffort =>
          isOneOf(effort, CODEX_REASONING_EFFORTS),
        )
      : undefined;
    if (
      candidate.reasoningEfforts != null &&
      (!Array.isArray(candidate.reasoningEfforts) ||
        reasoningEfforts!.length !== candidate.reasoningEfforts.length)
    ) {
      continue;
    }
    const defaultReasoningEffort =
      candidate.defaultReasoningEffort == null
        ? undefined
        : isOneOf(candidate.defaultReasoningEffort, CODEX_REASONING_EFFORTS)
          ? candidate.defaultReasoningEffort
          : null;
    if (defaultReasoningEffort === null) continue;

    let reasoningOptions: CodexModelCatalogEntry["reasoningOptions"];
    if (candidate.reasoningOptions != null) {
      if (!Array.isArray(candidate.reasoningOptions)) continue;
      reasoningOptions = [];
      let invalid = false;
      for (const option of candidate.reasoningOptions) {
        if (
          !isRecord(option) ||
          !isOneOf(option.effort, CODEX_REASONING_EFFORTS) ||
          !isNonBlankString(option.label) ||
          (option.description != null && typeof option.description !== "string")
        ) {
          invalid = true;
          break;
        }
        reasoningOptions.push({
          effort: option.effort,
          label: option.label.trim(),
          ...(isNonBlankString(option.description)
            ? { description: option.description.trim() }
            : {}),
        });
      }
      if (invalid) continue;
    }

    seen.add(id);
    normalized.push({
      id,
      name,
      ...(isNonBlankString(candidate.description)
        ? { description: candidate.description.trim() }
        : {}),
      ...(reasoningEfforts ? { reasoningEfforts: [...reasoningEfforts] } : {}),
      ...(reasoningOptions ? { reasoningOptions } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    });
  }
  return normalized;
}

export function normalizeAcpModelCatalogEntries(
  value: unknown,
  platform: "cursor" | "grok" | "pi",
): AgentModel[] {
  if (!Array.isArray(value)) return [];
  const normalized: AgentModel[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || candidate.platform !== platform) continue;
    const id = isNonBlankString(candidate.id) ? candidate.id.trim() : "";
    const label = isNonBlankString(candidate.label) ? candidate.label.trim() : "";
    if (!id || !label || seen.has(id)) continue;
    if (
      (candidate.providerLabel != null && typeof candidate.providerLabel !== "string") ||
      (candidate.description != null && typeof candidate.description !== "string") ||
      (candidate.defaultReasoningId != null && typeof candidate.defaultReasoningId !== "string") ||
      (candidate.supportsSpeed != null && typeof candidate.supportsSpeed !== "boolean") ||
      (candidate.supportsMode != null && typeof candidate.supportsMode !== "boolean") ||
      (candidate.contextWindow != null &&
        (typeof candidate.contextWindow !== "number" ||
          !Number.isSafeInteger(candidate.contextWindow) ||
          candidate.contextWindow <= 0)) ||
      (candidate.supportsImageInput != null && typeof candidate.supportsImageInput !== "boolean") ||
      (candidate.sessionDefault != null && typeof candidate.sessionDefault !== "boolean")
    ) {
      continue;
    }
    let reasoning: AgentModel["reasoning"];
    if (candidate.reasoning != null) {
      if (!Array.isArray(candidate.reasoning)) continue;
      reasoning = [];
      const reasoningIds = new Set<string>();
      let invalid = false;
      for (const option of candidate.reasoning) {
        if (!isRecord(option)) {
          invalid = true;
          break;
        }
        const optionId = isNonBlankString(option.id) ? option.id.trim() : "";
        const optionLabel = isNonBlankString(option.label) ? option.label.trim() : "";
        if (
          !optionId ||
          !optionLabel ||
          reasoningIds.has(optionId) ||
          (option.description != null && typeof option.description !== "string") ||
          (option.annotation != null && typeof option.annotation !== "string")
        ) {
          invalid = true;
          break;
        }
        reasoningIds.add(optionId);
        reasoning.push({
          id: optionId,
          label: optionLabel,
          ...(isNonBlankString(option.description)
            ? { description: option.description.trim() }
            : {}),
          ...(isNonBlankString(option.annotation) ? { annotation: option.annotation.trim() } : {}),
        });
      }
      if (invalid) continue;
    }

    seen.add(id);
    normalized.push({
      platform,
      id,
      label,
      ...(isNonBlankString(candidate.providerLabel)
        ? { providerLabel: candidate.providerLabel.trim() }
        : {}),
      ...(isNonBlankString(candidate.description)
        ? { description: candidate.description.trim() }
        : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(isNonBlankString(candidate.defaultReasoningId)
        ? { defaultReasoningId: candidate.defaultReasoningId.trim() }
        : {}),
      ...(typeof candidate.supportsSpeed === "boolean"
        ? { supportsSpeed: candidate.supportsSpeed }
        : {}),
      ...(typeof candidate.supportsMode === "boolean"
        ? { supportsMode: candidate.supportsMode }
        : {}),
      ...(typeof candidate.contextWindow === "number"
        ? { contextWindow: candidate.contextWindow }
        : {}),
      ...(typeof candidate.supportsImageInput === "boolean"
        ? { supportsImageInput: candidate.supportsImageInput }
        : {}),
      ...(candidate.sessionDefault === true ? { sessionDefault: true } : {}),
    });
  }
  return normalized;
}

export function parsePersistedAgentModelCatalogCache(value: unknown): AgentModelCatalogCache {
  const empty: AgentModelCatalogCache = { schemaVersion: 1 };
  if (!isRecord(value) || value.schemaVersion !== 1) return empty;

  const parseCatalog = <T>(candidate: unknown, normalize: (models: unknown) => T[]) => {
    if (!isRecord(candidate)) return undefined;
    const models = normalize(candidate.models);
    if (models.length === 0) return undefined;
    const updatedAt =
      typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
        ? candidate.updatedAt
        : new Date(0).toISOString();
    return { updatedAt, models };
  };

  const claude = parseCatalog(value.claude, normalizeClaudeModelCatalogEntries);
  const codex = parseCatalog(value.codex, normalizeCodexModelCatalogEntries);
  const cursor = parseCatalog(value.cursor, (models) =>
    normalizeAcpModelCatalogEntries(models, "cursor"),
  );
  const grok = parseCatalog(value.grok, (models) =>
    normalizeAcpModelCatalogEntries(models, "grok"),
  );
  const pi = parseCatalog(value.pi, (models) => normalizeAcpModelCatalogEntries(models, "pi"));
  return {
    schemaVersion: 1,
    ...(claude ? { claude } : {}),
    ...(codex ? { codex } : {}),
    ...(cursor ? { cursor } : {}),
    ...(grok ? { grok } : {}),
    ...(pi ? { pi } : {}),
  };
}
