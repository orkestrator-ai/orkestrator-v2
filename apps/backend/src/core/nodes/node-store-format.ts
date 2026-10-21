import {
  emptyNodeAttachments,
  emptyNodeRegistry,
  MAX_ATTACHED_CONTROLLERS,
  MAX_REGISTERED_NODES,
  normalizeRouteOrder,
  parseGatewayCredential,
  parseNodeRoutes,
  parsePortalOrigins,
  type ControllerAttachment,
  type DetachedController,
  type NodeAttachments,
  type NodeAttachmentState,
  type NodeDetachTombstone,
  type NodeRecord,
  type NodeRegistry,
} from "@orkestrator/protocol/command-nodes";
import { isBackendId } from "@orkestrator/protocol/federation";

/**
 * Lenient readers for the stored node registry and attachment records. An
 * unreadable entry is dropped (and reported once) rather than failing the
 * whole store, so one bad record cannot take every node offline.
 */

const MAX_TIMESTAMP_LENGTH = 64;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_TIMESTAMP_LENGTH)
    : undefined;
}

function shortText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function credential(value: unknown): { token: string } | null {
  const entry = record(value);
  if (!entry) return null;
  try {
    return { token: parseGatewayCredential(entry.token) };
  } catch {
    return null;
  }
}

function attachmentState(value: unknown): NodeAttachmentState {
  const entry = record(value);
  const status = entry?.status;
  const state: NodeAttachmentState = {
    status: status === "attached" || status === "refused" ? status : "pending",
  };
  const reason = shortText(entry?.reason, 64);
  if (reason) state.reason = reason;
  const attachedAt = timestamp(entry?.attachedAt);
  if (attachedAt) state.attachedAt = attachedAt;
  return state;
}

function nodeRecord(value: unknown): NodeRecord | null {
  const entry = record(value);
  if (!entry || !isBackendId(entry.nodeId)) return null;
  try {
    const routes = parseNodeRoutes(entry.routes);
    const node: NodeRecord = {
      nodeId: entry.nodeId,
      enabled: entry.enabled !== false,
      routes,
      routeOrder: normalizeRouteOrder(routes, entry.routeOrder),
      credential: credential(entry.credential),
      fallbackName: shortText(entry.fallbackName, 255) ?? entry.nodeId,
      attachment: attachmentState(entry.attachment),
      addedAt: timestamp(entry.addedAt) ?? new Date(0).toISOString(),
      source: entry.source === "desktop-migration" ? "desktop-migration" : "portal",
    };
    const lastConnectedAt = timestamp(entry.lastConnectedAt);
    if (lastConnectedAt) node.lastConnectedAt = lastConnectedAt;
    const importedFrom = shortText(entry.importedFrom, 200);
    if (importedFrom) node.importedFrom = importedFrom;
    const cache = record(entry.profileCache);
    if (
      cache &&
      typeof cache.displayName === "string" &&
      typeof cache.colorToken === "string" &&
      Number.isSafeInteger(cache.revision)
    ) {
      node.profileCache = {
        displayName: cache.displayName.slice(0, 64),
        colorToken: cache.colorToken.slice(0, 32),
        revision: cache.revision as number,
      };
    }
    return node;
  } catch {
    return null;
  }
}

function tombstone(value: unknown): NodeDetachTombstone | null {
  const entry = record(value);
  if (!entry || !isBackendId(entry.nodeId)) return null;
  try {
    const routes = parseNodeRoutes(entry.routes);
    return {
      nodeId: entry.nodeId,
      routes,
      routeOrder: normalizeRouteOrder(routes, entry.routeOrder),
      credential: credential(entry.credential),
      forgottenAt: timestamp(entry.forgottenAt) ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function readStoredNodeRegistry(value: unknown): {
  registry: NodeRegistry;
  dropped: number;
} {
  const root = record(value);
  if (!root || root.version !== 1) return { registry: emptyNodeRegistry(), dropped: 0 };
  const rawNodes = Array.isArray(root.nodes) ? root.nodes.slice(0, MAX_REGISTERED_NODES) : [];
  const rawTombstones = Array.isArray(root.tombstones)
    ? root.tombstones.slice(0, MAX_REGISTERED_NODES)
    : [];
  const seen = new Set<string>();
  const nodes: NodeRecord[] = [];
  let dropped = 0;
  for (const raw of rawNodes) {
    const node = nodeRecord(raw);
    if (!node || seen.has(node.nodeId)) {
      dropped += 1;
      continue;
    }
    seen.add(node.nodeId);
    nodes.push(node);
  }
  const tombstones: NodeDetachTombstone[] = [];
  for (const raw of rawTombstones) {
    const entry = tombstone(raw);
    if (!entry || seen.has(entry.nodeId)) {
      dropped += 1;
      continue;
    }
    seen.add(entry.nodeId);
    tombstones.push(entry);
  }
  return {
    registry: {
      version: 1,
      revision: Number.isSafeInteger(root.revision) ? (root.revision as number) : 0,
      registrationEnabled: root.registrationEnabled === true,
      nodes,
      tombstones,
      importedSources: Array.isArray(root.importedSources)
        ? root.importedSources
            .filter((entry): entry is string => typeof entry === "string" && entry.length <= 200)
            .slice(0, MAX_REGISTERED_NODES * 4)
        : [],
    },
    dropped,
  };
}

function controllerAttachment(value: unknown): ControllerAttachment | null {
  const entry = record(value);
  if (!entry || !isBackendId(entry.controllerId)) return null;
  const displayName = shortText(entry.displayName, 64);
  const attachedAt = timestamp(entry.attachedAt);
  if (!displayName || !attachedAt) return null;
  let portalOrigins: string[];
  try {
    portalOrigins = parsePortalOrigins(entry.portalOrigins);
  } catch {
    portalOrigins = [];
  }
  return {
    controllerId: entry.controllerId,
    displayName,
    portalOrigins,
    attachedAt,
    lastContactAt: timestamp(entry.lastContactAt) ?? attachedAt,
  };
}

export function readStoredNodeAttachments(value: unknown): NodeAttachments {
  const root = record(value);
  if (!root || root.version !== 1 || !Array.isArray(root.controllers)) {
    return emptyNodeAttachments();
  }
  const detachedControllers: DetachedController[] = [];
  for (const raw of Array.isArray(root.detachedControllers)
    ? root.detachedControllers.slice(0, MAX_ATTACHED_CONTROLLERS * 4)
    : []) {
    const entry = record(raw);
    const displayName = shortText(entry?.displayName, 64);
    const detachedAt = timestamp(entry?.detachedAt);
    if (!entry || !isBackendId(entry.controllerId) || !displayName || !detachedAt) continue;
    if (detachedControllers.some((existing) => existing.controllerId === entry.controllerId))
      continue;
    detachedControllers.push({ controllerId: entry.controllerId, displayName, detachedAt });
  }
  const seen = new Set<string>();
  const controllers: ControllerAttachment[] = [];
  for (const raw of root.controllers.slice(0, MAX_ATTACHED_CONTROLLERS)) {
    const entry = controllerAttachment(raw);
    if (!entry || seen.has(entry.controllerId)) continue;
    seen.add(entry.controllerId);
    controllers.push(entry);
  }
  return { version: 1, controllers, detachedControllers };
}
