/**
 * Command nodes and leaf nodes.
 *
 * Every backend is a node. A command node keeps, in its backend, a registry
 * of the nodes it controls and dials out to them; a leaf records which
 * command nodes are attached to it. There are exactly two levels: a node
 * that is attached to a command node is in leaf mode and suspends its own
 * command activity. See `docs/architecture/command-nodes.md` and the
 * contracts in `docs/development/command-nodes-plan.md`.
 *
 * Leaf credentials never appear in any type a client receives.
 */

import { MAX_MACHINE_DISPLAY_NAME_LENGTH } from "./backend-profile.js";
import type { CachedBackendProfile } from "./device-catalogue.js";
import {
  MAX_ROUTES_PER_BACKEND,
  parseStoredOrigin,
  validateIdentityFile,
  validatePort,
  validateSshDestination,
} from "./device-catalogue.js";
import type { InheritedSettingsSource } from "./controller-settings.js";
import { isBackendId, isRouteId, type BackendId, type RouteId } from "./federation.js";

/** Identifies the calling command node on every request it sends to a leaf. */
export const CONTROLLER_HEADER = "x-orkestrator-controller";

export const NODE_STATUS_CHANGED_EVENT = "node-status-changed";
export const NODES_CHANGED_EVENT = "nodes-changed";
export const NODE_SSH_PROMPT_EVENT = "node-ssh-prompt";

export const MAX_REGISTERED_NODES = 64;
export const MAX_ATTACHED_CONTROLLERS = 16;
export const MAX_PORTAL_ORIGINS = 16;
const MAX_TOKEN_LENGTH = 4096;

/** `leaf` while attached to any command node; `command` while commanding; else `standalone`. */
export type NodeMode = "standalone" | "command" | "leaf";

export interface ControllerView {
  controllerId: BackendId;
  displayName: string;
  attachedAt: string;
  lastContactAt: string;
}

export interface NodeStatus {
  nodeId: BackendId;
  mode: NodeMode;
  /** The command-node setting: whether this node may register subordinates. */
  registrationEnabled: boolean;
  controllers: ControllerView[];
  /** Command nodes the user detached here; they cannot re-attach until allowed. */
  detachedControllers: DetachedController[];
  mostRecentControllerId?: BackendId;
  /** Registered subordinates whose control is suspended because this node is a leaf. */
  suspendedSubordinateCount: number;
  /** The command node whose settings this leaf uses in place of its own (see `controller-settings.ts`). */
  inheritedSettingsFrom?: InheritedSettingsSource;
}

export interface NodeHttpsRoute {
  id: RouteId;
  kind: "https";
  enabled: boolean;
  origin: string;
}

export interface NodeSshRoute {
  id: RouteId;
  kind: "ssh";
  enabled: boolean;
  destination: string;
  sshPort?: number;
  identityFile?: string;
  remoteGatewayPort: number;
}

export type NodeRoute = NodeHttpsRoute | NodeSshRoute;

export type NodeAttachmentStatus = "pending" | "attached" | "refused";

export interface NodeAttachmentState {
  status: NodeAttachmentStatus;
  /** Machine-readable refusal or failure code. */
  reason?: string;
  attachedAt?: string;
}

/** Stored registry entry. Only the command node's backend ever holds `credential`. */
export interface NodeRecord {
  nodeId: BackendId;
  enabled: boolean;
  routes: NodeRoute[];
  routeOrder: RouteId[];
  credential: { token: string } | null;
  profileCache?: CachedBackendProfile;
  /** Hostname-derived name shown before the first verified hello. */
  fallbackName: string;
  attachment: NodeAttachmentState;
  addedAt: string;
  lastConnectedAt?: string;
  source: "portal" | "desktop-migration" | "handover";
  /** Catalogue entry this record was imported from, for idempotent migration. */
  importedFrom?: string;
}

/** Kept after `forget_node` until the leaf confirms the detach. */
export interface NodeDetachTombstone {
  nodeId: BackendId;
  routes: NodeRoute[];
  routeOrder: RouteId[];
  credential: { token: string } | null;
  forgottenAt: string;
}

export interface NodeRegistry {
  version: 1;
  revision: number;
  /** The command-node setting. A `--command-node` launch forces it on. */
  registrationEnabled: boolean;
  nodes: NodeRecord[];
  tombstones: NodeDetachTombstone[];
  /** Desktop catalogue entries already imported, so a forgotten node is never re-imported. */
  importedSources: string[];
}

/**
 * A machine handed to a command node with its gateway credential: the
 * desktop's saved machines on import, or another command node's registry on
 * a handover. Only ever sent to a backend, never to a client.
 */
export interface NodeImportEntry {
  /** Where the entry came from (a catalogue entry or a registry), for idempotence. */
  importedFrom: string;
  fallbackName: string;
  verifiedNodeId?: BackendId;
  routes: NodeRoute[];
  routeOrder: RouteId[];
  token: string | null;
  enabled: boolean;
  profileCache?: CachedBackendProfile;
}

export const MAX_IMPORT_ENTRIES = MAX_REGISTERED_NODES;

/** A machine the current command node would hand to the new one. */
export interface HandoverCandidate {
  nodeId: BackendId;
  displayName: string;
  colorToken?: string;
  /** Whether a token is held for it; without one it arrives needing a token. */
  hasCredential: boolean;
}

/**
 * What making another node the command node would change (`preview_command_handover`):
 * the machines it does not control yet, and whether this node can follow as its leaf.
 */
export interface CommandHandoverPreview {
  targetNodeId: BackendId;
  targetName: string;
  /** Whether this node controls the target yet; if not, a client registers it first. */
  targetRegistered: boolean;
  /** Machines the target already controls (unknown, so empty, when it is not registered). */
  targetNodeIds: BackendId[];
  /** This node's machines the target does not control yet. */
  candidates: HandoverCandidate[];
  self: {
    nodeId: BackendId;
    displayName: string;
    colorToken?: string;
    /** This node has an HTTPS address and token the target can use to control it. */
    reachable: boolean;
  };
}

/** The desktop's preview: nothing to do when the target already is the command node in charge. */
export type CommandHandoverPreviewResult =
  | { kind: "already-command-node" }
  | { kind: "preview"; preview: CommandHandoverPreview };

export interface CommandHandoverResult {
  targetNodeId: BackendId;
  /** Machines the target registered. */
  transferred: number;
  /** Machines the target already controlled, or could not take. */
  skipped: number;
  /** Machines that arrived without a token. */
  needsCredential: number;
  /** Whether this node is now one of the target's machines. */
  selfIncluded: boolean;
  /** Command nodes that controlled the target and were detached. */
  detachedControllers: number;
}

export type NodeConnectionState =
  | "connecting"
  | "connected"
  | "degraded"
  | "unavailable"
  | "quarantined"
  | "needs-credential"
  | "needs-update"
  | "suspended"
  | "disabled";

export interface NodeConnectionView {
  state: NodeConnectionState;
  activeRouteId?: RouteId;
  activeRouteKind?: NodeRoute["kind"];
  epoch: number;
  /** The node's own mode as last reported by its hello. */
  remoteMode?: NodeMode;
  lastError?: { code: string; message: string };
}

/** What a client sees of a registry entry: never the credential. */
export interface NodeView {
  nodeId: BackendId;
  enabled: boolean;
  displayName: string;
  colorToken?: string;
  fallbackName: string;
  routes: NodeRoute[];
  routeOrder: RouteId[];
  hasCredential: boolean;
  attachment: NodeAttachmentState;
  connection: NodeConnectionView;
  addedAt: string;
  lastConnectedAt?: string;
  source: NodeRecord["source"];
  /** Present after `forget_node` while the detach is still pending. */
  detachPending?: boolean;
}

export interface NodeListResult {
  revision: number;
  mode: NodeMode;
  suspended: boolean;
  nodes: NodeView[];
  /** Forgotten nodes whose leaf has not yet confirmed the detach. */
  pendingDetaches: { nodeId: BackendId; displayName: string; forgottenAt: string }[];
}

/** Stored on a leaf for each command node attached to it. */
export interface ControllerAttachment {
  controllerId: BackendId;
  displayName: string;
  portalOrigins: string[];
  attachedAt: string;
  lastContactAt: string;
}

/** A command node the user detached on this node; it may not re-attach until allowed again. */
export interface DetachedController {
  controllerId: BackendId;
  displayName: string;
  detachedAt: string;
}

export interface NodeAttachments {
  version: 1;
  controllers: ControllerAttachment[];
  detachedControllers: DetachedController[];
}

export interface AttachControllerArgs {
  controllerId: BackendId;
  displayName: string;
  portalOrigins: string[];
}

export interface AttachControllerResult {
  nodeId: BackendId;
  mode: NodeMode;
}

/** Machine-readable refusals shared by both sides of an attachment. */
export const NODE_REFUSAL_CODES = {
  /** This node is in leaf mode and cannot register or control nodes. */
  nodeIsSubordinate: "node-is-subordinate",
  /** Registration is not enabled on this node. */
  registrationDisabled: "registration-disabled",
  /** The controller is one of this node's own subordinates: a cycle. */
  controllerIsSubordinate: "controller-is-subordinate",
  selfAttach: "self-attach",
  /** The node is already registered here. */
  duplicateNode: "duplicate-node",
  tooManyNodes: "too-many-nodes",
  tooManyControllers: "too-many-controllers",
  unknownNode: "unknown-node",
  /** The node's backend predates command nodes. */
  needsUpdate: "needs-update",
  /** The user detached this command node on the node itself. */
  detachedOnNode: "detached-on-node",
  /** Only a command node attached to this node may hand its command over here. */
  notController: "not-controller",
} as const;

export type NodeRefusalCode = (typeof NODE_REFUSAL_CODES)[keyof typeof NODE_REFUSAL_CODES];

const NODE_REFUSAL_PREFIX = "NodeRefusal:";

/**
 * A refusal that crosses `/invoke` as an error string, so the prefix carries
 * the code: `NodeRefusal:<code>: <message>`.
 */
export class NodeRefusalError extends Error {
  readonly detail: string;

  constructor(
    readonly code: NodeRefusalCode,
    message: string,
  ) {
    super(`${NODE_REFUSAL_PREFIX}${code}: ${message}`);
    this.name = "NodeRefusalError";
    this.detail = message;
  }
}

export function parseNodeRefusal(
  message: string,
): { code: NodeRefusalCode; message: string } | null {
  if (!message.startsWith(NODE_REFUSAL_PREFIX)) return null;
  const rest = message.slice(NODE_REFUSAL_PREFIX.length);
  const separator = rest.indexOf(": ");
  if (separator <= 0) return null;
  const code = rest.slice(0, separator);
  if (!(Object.values(NODE_REFUSAL_CODES) as string[]).includes(code)) return null;
  return { code: code as NodeRefusalCode, message: rest.slice(separator + 2) };
}

/*
 * Validation
 */

export function normalizeNodeDisplayName(value: unknown, label = "displayName"): string {
  if (typeof value !== "string") throw new Error(`Expected ${label} to be a string.`);
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MACHINE_DISPLAY_NAME_LENGTH);
  if (!name) throw new Error(`Expected ${label} to be non-empty.`);
  return name;
}

export function parseNodeId(value: unknown, label = "nodeId"): BackendId {
  if (!isBackendId(value)) throw new Error(`Expected ${label} to be a node identity.`);
  return value;
}

export function parseGatewayCredential(value: unknown, label = "token"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    throw new Error(`Expected ${label} to be a gateway token.`);
  }
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Expected ${label} to be a gateway token.`);
  }
  return value;
}

export function parseNodeImportEntries(value: unknown): NodeImportEntry[] {
  if (!Array.isArray(value) || value.length > MAX_IMPORT_ENTRIES) {
    throw new Error("Expected entries to be a bounded array.");
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Expected entries[${index}] to be an object.`);
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.importedFrom !== "string" ||
      !entry.importedFrom ||
      entry.importedFrom.length > 200
    ) {
      throw new Error(`Expected entries[${index}].importedFrom.`);
    }
    const routes = parseNodeRoutes(entry.routes);
    const parsed: NodeImportEntry = {
      importedFrom: entry.importedFrom,
      fallbackName: normalizeNodeDisplayName(entry.fallbackName, "fallbackName"),
      routes,
      routeOrder: normalizeRouteOrder(routes, entry.routeOrder),
      token:
        entry.token === null || entry.token === undefined
          ? null
          : parseGatewayCredential(entry.token),
      enabled: entry.enabled !== false,
    };
    if (entry.verifiedNodeId !== undefined) {
      if (!isBackendId(entry.verifiedNodeId) || entry.verifiedNodeId.startsWith("provisional:")) {
        throw new Error(`Expected entries[${index}].verifiedNodeId to be a node identity.`);
      }
      parsed.verifiedNodeId = entry.verifiedNodeId;
    }
    const cache = entry.profileCache as CachedBackendProfile | undefined;
    if (
      cache &&
      typeof cache.displayName === "string" &&
      typeof cache.colorToken === "string" &&
      Number.isSafeInteger(cache.revision)
    ) {
      parsed.profileCache = {
        displayName: cache.displayName.slice(0, 64),
        colorToken: cache.colorToken.slice(0, 32),
        revision: cache.revision,
      };
    }
    return parsed;
  });
}

export function parsePortalOrigins(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Expected portalOrigins to be an array.");
  if (value.length > MAX_PORTAL_ORIGINS) throw new Error("Too many portal origins.");
  const origins = value.map((origin, index) =>
    parsePortalOrigin(origin, `portalOrigins[${index}]`),
  );
  return [...new Set(origins)];
}

/** An `http(s)` origin, or a desktop renderer scheme origin such as `app://orkestrator`. */
function parsePortalOrigin(value: unknown, label: string): string {
  if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+$/i.test(value)) {
    const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
    if (scheme !== "http" && scheme !== "https") return value.toLowerCase();
  }
  return parseStoredOrigin(value, label);
}

export function parseAttachControllerArgs(args: Record<string, unknown>): AttachControllerArgs {
  return {
    controllerId: parseNodeId(args.controllerId, "controllerId"),
    displayName: normalizeNodeDisplayName(args.displayName),
    portalOrigins: parsePortalOrigins(args.portalOrigins),
  };
}

export function parseNodeRoute(value: unknown, label = "route"): NodeRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (!isRouteId(record.id)) throw new Error(`Expected ${label}.id to be a route identity.`);
  const enabled = record.enabled !== false;
  if (record.kind === "https") {
    const origin = parseStoredOrigin(record.origin, `${label}.origin`);
    const url = new URL(origin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
      throw new Error("A node route must use HTTPS unless it is on this computer.");
    }
    return { id: record.id, kind: "https", enabled, origin };
  }
  if (record.kind === "ssh") {
    const route: NodeSshRoute = {
      id: record.id,
      kind: "ssh",
      enabled,
      destination: validateSshDestination(record.destination),
      remoteGatewayPort: validatePort(record.remoteGatewayPort, "remote gateway port"),
    };
    if (record.sshPort !== undefined) route.sshPort = validatePort(record.sshPort, "SSH port");
    const identityFile = validateIdentityFile(record.identityFile);
    if (identityFile) route.identityFile = identityFile;
    return route;
  }
  throw new Error(`Expected ${label}.kind to be https or ssh.`);
}

export function parseNodeRoutes(value: unknown): NodeRoute[] {
  if (!Array.isArray(value)) throw new Error("Expected routes to be an array.");
  if (value.length === 0 || value.length > MAX_ROUTES_PER_BACKEND) {
    throw new Error(`Expected between 1 and ${MAX_ROUTES_PER_BACKEND} routes.`);
  }
  const routes = value.map((route, index) => parseNodeRoute(route, `routes[${index}]`));
  if (new Set(routes.map((route) => route.id)).size !== routes.length) {
    throw new Error("Routes must have distinct IDs.");
  }
  return routes;
}

/** Keep a requested order's known IDs, then append any route it left out. */
export function normalizeRouteOrder(routes: NodeRoute[], requested: unknown): RouteId[] {
  const ids = routes.map((route) => route.id);
  const order = Array.isArray(requested)
    ? requested.filter(
        (id, position): id is RouteId =>
          isRouteId(id) && ids.includes(id) && requested.indexOf(id) === position,
      )
    : [];
  return [...order, ...ids.filter((id) => !order.includes(id))];
}

export function orderedNodeRoutes(record: Pick<NodeRecord, "routes" | "routeOrder">): NodeRoute[] {
  const byId = new Map(record.routes.map((route) => [route.id, route]));
  return normalizeRouteOrder(record.routes, record.routeOrder)
    .map((id) => byId.get(id))
    .filter((route): route is NodeRoute => route !== undefined && route.enabled);
}

export function emptyNodeRegistry(): NodeRegistry {
  return {
    version: 1,
    revision: 0,
    registrationEnabled: false,
    nodes: [],
    tombstones: [],
    importedSources: [],
  };
}

export function emptyNodeAttachments(): NodeAttachments {
  return { version: 1, controllers: [], detachedControllers: [] };
}

/**
 * Mode rule: attached anywhere means leaf; otherwise commanding at least one
 * enabled, attached subordinate means command; otherwise standalone.
 */
export function deriveNodeMode(input: {
  controllerCount: number;
  commandedNodeCount: number;
}): NodeMode {
  if (input.controllerCount > 0) return "leaf";
  return input.commandedNodeCount > 0 ? "command" : "standalone";
}

/** Routed reads do not invalidate the machine’s project/environment summaries. */
export function isNodeReadCommand(command: string): boolean {
  return ["get_", "list_", "read_", "search_", "check_", "describe_"].some((prefix) =>
    command.startsWith(prefix),
  );
}
