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
  const connectionKey = `${baseKey}:desktop:${(hash >>> 0).toString(36)}`;
  const migrationKey = `${baseKey}:desktop:migrated-v1`;
  // The first desktop window deliberately retains Electron's legacy default
  // session for one release. Copy old Zustand state before persist middleware
  // reads the first connection-specific key. Mark the base key as consumed so
  // switching that window later cannot copy project-specific state into every
  // other connection namespace.
  try {
    if (localStorage.getItem(migrationKey) === null) {
      if (localStorage.getItem(connectionKey) === null) {
        const legacyValue = localStorage.getItem(baseKey);
        if (legacyValue !== null) localStorage.setItem(connectionKey, legacyValue);
      }
      localStorage.setItem(migrationKey, "1");
    }
  } catch {
    // Storage can be disabled or unavailable. Zustand will apply its own
    // fallback behavior, so key derivation must remain usable.
  }
  return connectionKey;
}
