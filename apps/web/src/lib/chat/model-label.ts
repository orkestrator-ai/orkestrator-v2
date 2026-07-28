export interface ModelLabelEntry {
  id: string;
  name: string;
}

/** Prefer the catalog's friendly name while preserving unknown confirmed ids. */
export function resolveCatalogModelLabel(
  modelId: string,
  models: readonly ModelLabelEntry[],
): string {
  const friendlyName = models.find((model) => model.id === modelId)?.name?.trim();
  return friendlyName || modelId;
}
