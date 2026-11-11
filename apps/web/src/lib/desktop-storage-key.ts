import type { BackendId } from "@orkestrator/protocol/federation";
import { COMMAND_SCOPE_PROVISIONAL_NODE_ID } from "./node-scope/app-window-scope";
import type { NodeScopeRole } from "./node-scope/node-scope";

/**
 * Keeps persisted presentation state separate per node in one renderer
 * (report §7.5). Browser clients retain their established storage keys.
 *
 * Every per-node key names its node (`StorageNode`: a `NodeScope` is one).
 * The command node's key is the key this renderer used before keys took a
 * node, so nothing moves for it. A leaf's key is the `:machine:<hash>` form
 * the per-node workspace frames of earlier browser and iOS releases wrote in
 * shared origin storage, so the leaf reads its existing state. Earlier desktop
 * releases kept that state in per-node partitions, which is abandoned
 * (decision 13.7 A).
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
 * The node a persisted key belongs to. Only the role decides the command
 * node's key: the command scope's id is provisional until plan item 2010
 * proves it, and its key must not change when the id does.
 */
export interface StorageNode {
  readonly nodeId: BackendId;
  readonly role: NodeScopeRole;
}

/**
 * The command node, for module-level stores that are not scoped yet. Plan
 * items 3006, 3007, 3012 and 3013 replace it with the store's own scope.
 */
export const COMMAND_STORAGE_NODE: StorageNode = Object.freeze({
  nodeId: COMMAND_SCOPE_PROVISIONAL_NODE_ID,
  role: "command",
});

function machineKey(baseKey: string, nodeId: string): string {
  return `${baseKey}:machine:${hashIdentity(`machine:${nodeId}`)}`;
}

/** Presentation state of `node` in this renderer. */
export function desktopConnectionStorageKey(baseKey: string, node: StorageNode): string {
  if (typeof window === "undefined") return baseKey;
  if (node.role !== "command") return machineKey(baseKey, node.nodeId);
  if (window.orkestrator?.isolatedViewState !== true) return baseKey;
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
  return namespacedKey(baseKey, window.orkestratorDesktopIdentity);
}

function namespacedKey(
  baseKey: string,
  desktopIdentity: Parameters<typeof namespaceFor>[0],
): string {
  const { identity, legacyIdentity } = namespaceFor(desktopIdentity);
  const connectionKey = `${baseKey}:desktop:${hashIdentity(identity)}`;
  try {
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
