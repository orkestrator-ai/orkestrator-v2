/**
 * The client device's machine-and-route catalogue (version 2).
 *
 * One saved machine can have several independently authorized routes
 * (HTTPS/Tailscale, managed SSH). The catalogue belongs to the client
 * device: it is never synchronised, never read from a backend, and remains
 * readable when the desktop's own local backend is stopped. Secrets are kept
 * only as OS-encrypted blobs; the renderer receives a safe projection
 * (`ConnectionSummary` in `connections.ts`) and never this record.
 *
 * Version 1 was the flat `StoredDesktopConnections` list persisted through
 * the local backend's `config.json`. {@link migrateDesktopConnections}
 * converts it once; the old list is left untouched as the downgrade path.
 */

import type { StoredDesktopConnection, StoredDesktopConnections } from "./connections.js";
import { LOCAL_CONNECTION_ID } from "./connections.js";
import { isBackendId, isRouteId, type BackendId, type RouteId } from "./federation.js";
import { defaultMachineColor, MAX_MACHINE_DISPLAY_NAME_LENGTH } from "./backend-profile.js";

export const DEVICE_CATALOGUE_VERSION = 2;
export const MAX_SAVED_BACKENDS = 64;
export const MAX_ROUTES_PER_BACKEND = 8;
const MAX_DESTINATION_LENGTH = 255;
const MAX_IDENTITY_FILE_LENGTH = 1024;
const MAX_ENCRYPTED_TOKEN_LENGTH = 16 * 1024;

export type RouteKind = "https" | "ssh";

interface SavedRouteBase {
  id: RouteId;
  enabled: boolean;
  /** OS-encrypted gateway token (base64), or `""` when it is held for this session only. */
  encryptedToken: string;
  lastConnectedAt?: string;
}

export interface SavedHttpsRoute extends SavedRouteBase {
  kind: "https";
  /** Normalized origin; HTTPS unless loopback. */
  origin: string;
}

export interface SavedSshRoute extends SavedRouteBase {
  kind: "ssh";
  /** A trusted OpenSSH destination or alias. A user or port is never forced. */
  destination: string;
  /** Absent preserves the alias's own configured port. */
  sshPort?: number;
  /** A local key path, never key material. Absent preserves the alias's configuration. */
  identityFile?: string;
  /** Port of the remote backend's loopback client gateway. */
  remoteGatewayPort: number;
}

export type SavedRoute = SavedHttpsRoute | SavedSshRoute;

export interface CachedBackendProfile {
  displayName: string;
  colorToken: string;
  revision: number;
}

export interface SavedBackend {
  /** Stable catalogue entry ID. Migrated entries keep their version-1 connection ID. */
  id: string;
  /** Set once an authenticated hello proved the installation identity. */
  verifiedInstallationId?: BackendId;
  /** Device-local nickname, shown as "on this device". */
  localAlias?: string;
  /** Hostname-derived fallback name for display before a hello. */
  fallbackName: string;
  routeOrder: RouteId[];
  routes: SavedRoute[];
  autoConnect: boolean;
  lastConnectedAt?: string;
  /** Last-known canonical profile, for labelled offline display only. */
  profileCache?: CachedBackendProfile;
  /** Colour persisted for a backend with no canonical profile and no verified ID. */
  provisionalColor?: string;
}

export interface FederationFeatureFlags {
  /** Unified multi-machine sidebar and backend-scoped panels. */
  federation: boolean;
  /** Desktop-managed OpenSSH routes. */
  sshRoutes: boolean;
  /** Automatic fallback to another approved route of the same verified backend. */
  routeFallback: boolean;
}

export const DEFAULT_FEDERATION_FEATURES: FederationFeatureFlags = {
  federation: true,
  sshRoutes: true,
  routeFallback: true,
};

export interface DeviceCatalogue {
  version: typeof DEVICE_CATALOGUE_VERSION;
  /** Backend a new window binds to by default (`"local"` or a saved entry ID). */
  activeConnectionId: string;
  backends: SavedBackend[];
  features: FederationFeatureFlags;
  /** Present when this catalogue was produced from a version-1 list. */
  migratedFromVersion?: 1;
  migratedAt?: string;
}

export function emptyDeviceCatalogue(): DeviceCatalogue {
  return {
    version: DEVICE_CATALOGUE_VERSION,
    activeConnectionId: LOCAL_CONNECTION_ID,
    backends: [],
    features: { ...DEFAULT_FEDERATION_FEATURES },
  };
}

/*
 * Validation
 */

/**
 * Validate an SSH destination before it can reach an argv. Rejects anything
 * that could be read as an option (`-oProxyCommand=…`), whitespace, control
 * characters and shell metacharacters. The value is passed as one argv
 * element after `--`, never through a shell, but defence in depth matters
 * because OpenSSH itself interprets some destination syntax.
 */
export function validateSshDestination(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter the SSH destination.");
  const destination = value.trim();
  if (!destination) throw new Error("Enter the SSH destination.");
  if (destination.length > MAX_DESTINATION_LENGTH) {
    throw new Error("The SSH destination is too long.");
  }
  if (destination.startsWith("-")) {
    throw new Error("The SSH destination cannot start with '-'.");
  }
  if (destination.includes("://")) {
    throw new Error("Enter an SSH host or alias such as build-machine or user@host, not a URL.");
  }
  if (!/^[A-Za-z0-9._%@:[\]-]+$/.test(destination)) {
    throw new Error(
      "The SSH destination may contain only letters, digits and . _ - @ : [ ] characters.",
    );
  }
  const atCount = destination.split("@").length - 1;
  if (atCount > 1) throw new Error("The SSH destination may contain at most one '@'.");
  const host = destination.slice(destination.indexOf("@") + 1);
  if (!host || host.startsWith("-")) throw new Error("Enter a valid SSH host.");
  return destination;
}

export function validatePort(value: unknown, label: string): number {
  if (typeof value === "string" && /^\d{1,5}$/.test(value.trim())) value = Number(value.trim());
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`Enter a ${label} between 1 and 65535.`);
  }
  return value as number;
}

export function validateIdentityFile(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("The identity file must be a path.");
  const path = value.trim();
  if (!path) return undefined;
  if (path.length > MAX_IDENTITY_FILE_LENGTH)
    throw new Error("The identity file path is too long.");
  // oxlint-disable-next-line no-control-regex -- rejects control characters in a local path
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("The identity file path contains control characters.");
  }
  if (!path.startsWith("/") && !path.startsWith("~/")) {
    throw new Error("Use an absolute identity file path or one starting with ~/.");
  }
  if (path.startsWith("-")) throw new Error("The identity file path cannot start with '-'.");
  if (/-----BEGIN/.test(path)) {
    throw new Error("Enter the path of the key file, not the key itself.");
  }
  return path;
}

/*
 * Parsing
 */

export function parseDeviceCatalogue(value: unknown): DeviceCatalogue {
  const root = asRecord(value, "device catalogue");
  if (root.version !== DEVICE_CATALOGUE_VERSION) {
    throw new Error("The device catalogue has an unsupported version.");
  }
  const activeConnectionId = asString(root.activeConnectionId, "activeConnectionId", 200);
  if (!Array.isArray(root.backends)) throw new Error("Expected backends to be an array.");
  if (root.backends.length > MAX_SAVED_BACKENDS) {
    throw new Error("The device catalogue has too many machines.");
  }
  const backends = root.backends.map((entry, index) => parseSavedBackend(entry, index));
  const ids = new Set<string>();
  for (const backend of backends) {
    if (ids.has(backend.id) || backend.id === LOCAL_CONNECTION_ID) {
      throw new Error("The device catalogue has a duplicate machine entry.");
    }
    ids.add(backend.id);
  }
  const catalogue: DeviceCatalogue = {
    version: DEVICE_CATALOGUE_VERSION,
    activeConnectionId:
      activeConnectionId === LOCAL_CONNECTION_ID || ids.has(activeConnectionId)
        ? activeConnectionId
        : LOCAL_CONNECTION_ID,
    backends,
    features: parseFeatures(root.features),
  };
  if (root.migratedFromVersion === 1) catalogue.migratedFromVersion = 1;
  if (typeof root.migratedAt === "string") catalogue.migratedAt = root.migratedAt.slice(0, 64);
  return catalogue;
}

function parseFeatures(value: unknown): FederationFeatureFlags {
  if (value === undefined) return { ...DEFAULT_FEDERATION_FEATURES };
  const record = asRecord(value, "features");
  const flag = (key: keyof FederationFeatureFlags) =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : DEFAULT_FEDERATION_FEATURES[key];
  return {
    federation: flag("federation"),
    sshRoutes: flag("sshRoutes"),
    routeFallback: flag("routeFallback"),
  };
}

function parseSavedBackend(value: unknown, index: number): SavedBackend {
  const label = `backends[${index}]`;
  const record = asRecord(value, label);
  const id = asString(record.id, `${label}.id`, 200);
  if (!Array.isArray(record.routes)) throw new Error(`Expected ${label}.routes to be an array.`);
  if (record.routes.length === 0 || record.routes.length > MAX_ROUTES_PER_BACKEND) {
    throw new Error(`Expected ${label} to have between 1 and ${MAX_ROUTES_PER_BACKEND} routes.`);
  }
  const routes = record.routes.map((route, routeIndex) =>
    parseSavedRoute(route, `${label}.routes[${routeIndex}]`),
  );
  const routeIds = new Set(routes.map((route) => route.id));
  if (routeIds.size !== routes.length) throw new Error(`${label} has duplicate route IDs.`);
  const requestedOrder = Array.isArray(record.routeOrder)
    ? record.routeOrder.filter((routeId): routeId is RouteId => isRouteId(routeId))
    : [];
  const routeOrder = [
    ...requestedOrder.filter((routeId, position) => {
      return routeIds.has(routeId) && requestedOrder.indexOf(routeId) === position;
    }),
    ...routes.map((route) => route.id).filter((routeId) => !requestedOrder.includes(routeId)),
  ];
  const backend: SavedBackend = {
    id,
    fallbackName: asString(record.fallbackName, `${label}.fallbackName`, 255),
    routeOrder,
    routes,
    autoConnect: record.autoConnect !== false,
  };
  if (record.verifiedInstallationId !== undefined) {
    if (!isBackendId(record.verifiedInstallationId)) {
      throw new Error(`Expected ${label}.verifiedInstallationId to be a backend identity.`);
    }
    backend.verifiedInstallationId = record.verifiedInstallationId;
  }
  if (typeof record.localAlias === "string" && record.localAlias) {
    backend.localAlias = record.localAlias.slice(0, MAX_MACHINE_DISPLAY_NAME_LENGTH);
  }
  if (typeof record.lastConnectedAt === "string") {
    backend.lastConnectedAt = record.lastConnectedAt.slice(0, 64);
  }
  if (record.profileCache !== undefined) {
    const cache = asRecord(record.profileCache, `${label}.profileCache`);
    if (
      typeof cache.displayName === "string" &&
      typeof cache.colorToken === "string" &&
      Number.isSafeInteger(cache.revision)
    ) {
      backend.profileCache = {
        displayName: cache.displayName.slice(0, MAX_MACHINE_DISPLAY_NAME_LENGTH),
        colorToken: cache.colorToken.slice(0, 32),
        revision: cache.revision as number,
      };
    }
  }
  if (typeof record.provisionalColor === "string" && record.provisionalColor.length <= 32) {
    backend.provisionalColor = record.provisionalColor;
  }
  return backend;
}

function parseSavedRoute(value: unknown, label: string): SavedRoute {
  const record = asRecord(value, label);
  const id = record.id;
  if (!isRouteId(id)) throw new Error(`Expected ${label}.id to be a route identity.`);
  const encryptedToken = asString(
    record.encryptedToken ?? "",
    `${label}.encryptedToken`,
    MAX_ENCRYPTED_TOKEN_LENGTH,
    true,
  );
  const base = {
    id,
    enabled: record.enabled !== false,
    encryptedToken,
    ...(typeof record.lastConnectedAt === "string"
      ? { lastConnectedAt: record.lastConnectedAt.slice(0, 64) }
      : {}),
  };
  if (record.kind === "https") {
    return { ...base, kind: "https", origin: parseStoredOrigin(record.origin, `${label}.origin`) };
  }
  if (record.kind === "ssh") {
    const route: SavedSshRoute = {
      ...base,
      kind: "ssh",
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

export function parseStoredOrigin(value: unknown, label: string): string {
  const text = asString(value, label, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Expected ${label} to be an origin.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.origin !== text
  ) {
    throw new Error(`Expected ${label} to be an origin.`);
  }
  return url.origin;
}

/*
 * Migration from version 1
 */

/** Route ID given to the single route of a migrated version-1 entry. */
export function migratedRouteId(connectionId: string): RouteId {
  const suffix = connectionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || "route";
  return `https-${suffix}` as RouteId;
}

/**
 * Convert the version-1 list. Every address becomes one HTTPS route under a
 * provisional entry that keeps its version-1 ID, nickname, encrypted token
 * and last-connected time. Entries are never merged here: identity is only
 * associated later, after an authenticated hello.
 */
export function migrateDesktopConnections(
  legacy: StoredDesktopConnections,
  now = new Date().toISOString(),
): DeviceCatalogue {
  const backends = legacy.connections.slice(0, MAX_SAVED_BACKENDS).flatMap((connection) => {
    try {
      return [migrateConnection(connection)];
    } catch {
      // A malformed historical row is dropped from the new catalogue but stays
      // in the untouched version-1 list for recovery.
      return [];
    }
  });
  return {
    version: DEVICE_CATALOGUE_VERSION,
    activeConnectionId: backends.some((backend) => backend.id === legacy.activeConnectionId)
      ? legacy.activeConnectionId
      : LOCAL_CONNECTION_ID,
    backends,
    features: { ...DEFAULT_FEDERATION_FEATURES },
    migratedFromVersion: 1,
    migratedAt: now,
  };
}

function migrateConnection(connection: StoredDesktopConnection): SavedBackend {
  const routeId = migratedRouteId(connection.id);
  return {
    id: connection.id,
    provisionalColor: defaultMachineColor(connection.id),
    fallbackName: connection.name,
    ...(connection.nickname ? { localAlias: connection.nickname } : {}),
    routeOrder: [routeId],
    routes: [
      {
        id: routeId,
        kind: "https",
        origin: parseStoredOrigin(connection.address, "address"),
        encryptedToken: connection.encryptedToken,
        enabled: true,
        lastConnectedAt: connection.lastConnectedAt,
      },
    ],
    autoConnect: true,
    lastConnectedAt: connection.lastConnectedAt,
  };
}

/**
 * The version-1 view of a catalogue, for the legacy single-backend facade.
 * SSH-only machines are not representable to an older client and are
 * omitted rather than down-converted into an unusable HTTP address.
 */
export function legacyDesktopConnections(catalogue: DeviceCatalogue): StoredDesktopConnections {
  const connections = catalogue.backends.flatMap((backend): StoredDesktopConnection[] => {
    const route = orderedRoutes(backend).find(
      (candidate): candidate is SavedHttpsRoute => candidate.kind === "https",
    );
    if (!route) return [];
    return [
      {
        id: backend.id,
        name: backend.fallbackName,
        ...(backend.localAlias ? { nickname: backend.localAlias } : {}),
        address: route.origin,
        encryptedToken: route.encryptedToken,
        lastConnectedAt: backend.lastConnectedAt ?? route.lastConnectedAt ?? "",
      },
    ];
  });
  return {
    activeConnectionId: connections.some(
      (connection) => connection.id === catalogue.activeConnectionId,
    )
      ? catalogue.activeConnectionId
      : LOCAL_CONNECTION_ID,
    connections,
  };
}

export function orderedRoutes(backend: SavedBackend): SavedRoute[] {
  const byId = new Map(backend.routes.map((route) => [route.id, route]));
  return backend.routeOrder.flatMap((routeId) => {
    const route = byId.get(routeId);
    return route ? [route] : [];
  });
}

/** A short, non-secret description of where a route goes. */
export function describeRoute(route: SavedRoute): string {
  if (route.kind === "https") return new URL(route.origin).host;
  return route.sshPort ? `ssh ${route.destination}:${route.sshPort}` : `ssh ${route.destination}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new Error(`Expected ${label} to be a string.`);
  }
  return value;
}
