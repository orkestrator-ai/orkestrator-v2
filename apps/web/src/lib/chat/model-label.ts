export interface ModelLabelEntry {
  id: string;
  /** Provider-resolved identifier reported by completed assistant messages. */
  resolvedModel?: string;
  /** Additional exact identifiers that are safe to display as this entry. */
  aliases?: readonly string[];
  name: string;
}

/** Prefer the catalog's friendly name while preserving unknown confirmed ids. */
export function resolveCatalogModelLabel(
  modelId: string,
  models: readonly ModelLabelEntry[],
): string {
  const exactMatch = models.find((model) => model.id === modelId);
  if (exactMatch) return exactMatch.name?.trim() || modelId;

  const aliasMatches = models.filter(
    (model) =>
      model.resolvedModel === modelId
      || model.aliases?.includes(modelId) === true,
  );

  // A resolved provider id can back multiple selectors (for example Claude's
  // "default" and "opus[1m]"). Do not choose an arbitrary friendly label when
  // the catalog itself cannot identify a unique entry.
  if (aliasMatches.length !== 1) return modelId;

  return aliasMatches[0]?.name?.trim() || modelId;
}
