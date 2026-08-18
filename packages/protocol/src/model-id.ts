/**
 * Normalize a backend-reported model identifier for user-facing attribution.
 *
 * Claude Code uses angle-bracketed values such as `<synthetic>` for generated
 * assistant records. Those values describe the record, not a model, so they
 * must never be rendered as the assistant's name.
 */
export function normalizeBackendModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const modelId = value.trim();
  if (!modelId || /^<[^>]*>$/.test(modelId)) return undefined;
  return modelId;
}

/** Root assistant records are the only ones that may attribute the main turn. */
export function isRootAssistantRecord(parentToolUseId: unknown, isSidechain?: unknown): boolean {
  const hasNoParent =
    parentToolUseId == null ||
    (typeof parentToolUseId === "string" && parentToolUseId.trim().length === 0);
  const isMainChain = isSidechain === undefined || isSidechain === false;
  return hasNoParent && isMainChain;
}
