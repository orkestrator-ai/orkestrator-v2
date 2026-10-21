import { readStoredWorkspace } from "./portal/workspace-target-storage";

/**
 * Keeps persisted presentation state separate per machine inside Electron.
 * Browser clients retain their established storage keys.
 *
 * The namespace is the machine's identity, never a route: a proved backend
 * identity when there is one, otherwise the saved connection. An SSH
 * tunnel's ephemeral local port therefore never becomes part of a key.
 * Namespaces created by earlier releases were derived from the connection's
 * HTTPS address; a verified machine adopts that state once, and a machine
 * whose identity is still unproved keeps using it unchanged.
 */

function hashIdentity(identity: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

type DesktopIdentity = NonNullable<Window["orkestratorDesktopIdentity"]>;

function namespaceFor(
  desktopIdentity: Pick<DesktopIdentity, "connectionId" | "backendId" | "legacyOrigin"> | undefined,
): { identity: string; legacyIdentity: string | null } {
  if (!desktopIdentity) {
    return { identity: window.orkestratorGateway?.baseUrl ?? "local", legacyIdentity: null };
  }
  if (desktopIdentity.connectionId === "local") return { identity: "local", legacyIdentity: null };
  if (desktopIdentity.backendId) {
    return {
      identity: `backend:${desktopIdentity.backendId}`,
      legacyIdentity: desktopIdentity.legacyOrigin,
    };
  }
  // Unproved identity: an HTTPS-addressed machine keeps its established
  // namespace; an SSH-only one is namespaced by its saved entry.
  return {
    identity: desktopIdentity.legacyOrigin ?? `connection:${desktopIdentity.connectionId}`,
    legacyIdentity: null,
  };
}

/**
 * A hosted-browser tab whose workspace is on another node shares the
 * command node page's localStorage. Its presentation state is namespaced by
 * that node, or identical local IDs on two machines would share remembered
 * selections and layouts.
 */
function browserWorkspaceNode(): string | null {
  const nodeId = window.orkestratorWorkspaceTarget?.nodeId ?? readStoredWorkspace()?.nodeId;
  return nodeId && nodeId.length <= 128 ? nodeId : null;
}

/** Presentation state of the machine the window's workspace is on. */
export function desktopConnectionStorageKey(baseKey: string): string {
  if (typeof window === "undefined") return baseKey;
  if (window.orkestrator?.isolatedViewState !== true) {
    const machine = browserWorkspaceNode();
    return machine ? `${baseKey}:machine:${hashIdentity(`machine:${machine}`)}` : baseKey;
  }
  return namespacedKey(baseKey, window.orkestratorDesktopIdentity);
}

/**
 * Window-level presentation (sidebar, zoom): it stays with the machine the
 * window was opened on while its workspace moves between nodes, so the
 * window does not change shape when the user opens another node's
 * environment.
 */
export function windowStorageKey(baseKey: string): string {
  if (typeof window === "undefined") return baseKey;
  if (window.orkestrator?.isolatedViewState !== true) return baseKey;
  const identity = window.orkestratorDesktopIdentity;
  return namespacedKey(baseKey, identity?.portal ?? identity);
}

function namespacedKey(
  baseKey: string,
  desktopIdentity: Parameters<typeof namespaceFor>[0],
): string {
  const { identity, legacyIdentity } = namespaceFor(desktopIdentity);
  const connectionKey = `${baseKey}:desktop:${hashIdentity(identity)}`;
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
    if (legacyIdentity && localStorage.getItem(connectionKey) === null) {
      // One-time adoption of the address-derived namespace by the verified
      // machine that owns that address.
      const legacyKey = `${baseKey}:desktop:${hashIdentity(legacyIdentity)}`;
      const legacyValue = localStorage.getItem(legacyKey);
      if (legacyValue !== null) localStorage.setItem(connectionKey, legacyValue);
    }
  } catch {
    // Storage can be disabled or unavailable. Zustand will apply its own
    // fallback behavior, so key derivation must remain usable.
  }
  return connectionKey;
}
