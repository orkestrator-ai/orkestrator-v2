/**
 * Keeps persisted presentation state separate when one Electron window moves
 * between backends. Browser clients retain their established storage keys.
 */
export function desktopConnectionStorageKey(baseKey: string): string {
  if (typeof window === "undefined" || window.orkestrator?.isolatedViewState !== true) {
    return baseKey;
  }
  const identity = window.orkestratorGateway?.baseUrl ?? "local";
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${baseKey}:desktop:${(hash >>> 0).toString(36)}`;
}
