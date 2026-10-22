/**
 * Identities and resource references for a client that talks to several
 * independent backends at once.
 *
 * A backend keeps receiving its own ordinary entity IDs on the wire; the
 * client selects the owning connection first. These references exist so a
 * client can never confuse two resources that share a local ID on different
 * backends. See `docs/architecture/federation.md`.
 *
 * Four identities are deliberately distinct:
 * - **BackendId** — the persistent installation identity (`installationId`).
 * - **Backend generation** — one backend process lifetime.
 * - **RouteId** — one saved way to reach a backend; routes change without
 *   changing resources.
 * - **Connection epoch** — a client-local counter that fences late work after
 *   reconnects, route changes and authorization changes.
 *
 * Neither an address, a hostname, a display name, a colour nor a forwarded
 * port is a backend identity.
 */

export type BackendId = string & { readonly __brand: "BackendId" };
export type RouteId = string & { readonly __brand: "RouteId" };

/** Installation IDs are minted as `bk_<base64url>`; older or test IDs may differ. */
const BACKEND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ENTITY_ID_MAX_LENGTH = 256;

/**
 * Prefix for a client-local identity given to a backend that has not proved
 * its installation identity (an older backend without the hello handshake).
 * A provisional identity is never merged with another entry.
 */
export const PROVISIONAL_BACKEND_ID_PREFIX = "provisional:";

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && BACKEND_ID_PATTERN.test(value);
}

export function parseBackendId(value: unknown, label = "backendId"): BackendId {
  if (!isBackendId(value)) throw new Error(`Expected ${label} to be a backend identity.`);
  return value;
}

export function isProvisionalBackendId(value: BackendId): boolean {
  return value.startsWith(PROVISIONAL_BACKEND_ID_PREFIX);
}

/** A client-local identity for a saved entry whose backend has not proved one. */
export function provisionalBackendId(catalogueEntryId: string): BackendId {
  const suffix = catalogueEntryId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  if (!suffix) throw new Error("A provisional backend identity needs a catalogue entry ID.");
  return `${PROVISIONAL_BACKEND_ID_PREFIX}${suffix}` as BackendId;
}

export function isRouteId(value: unknown): value is RouteId {
  return typeof value === "string" && ROUTE_ID_PATTERN.test(value);
}

export function parseRouteId(value: unknown, label = "routeId"): RouteId {
  if (!isRouteId(value)) throw new Error(`Expected ${label} to be a route identity.`);
  return value;
}

function parseEntityId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ENTITY_ID_MAX_LENGTH) {
    throw new Error(`Expected ${label} to be a non-empty identifier.`);
  }
  return value;
}

export interface BackendRef {
  backendId: BackendId;
}

export interface ProjectRef extends BackendRef {
  projectId: string;
}

export interface EnvironmentRef extends BackendRef {
  environmentId: string;
}

export interface SessionRef extends EnvironmentRef {
  sessionId: string;
}

export interface FileRef extends EnvironmentRef {
  /** Workspace lineage: a path alone does not identify file content. */
  workspaceGeneration: string;
  relativePath: string;
}

export type ResourceRef =
  | ({ kind: "project" } & ProjectRef)
  | ({ kind: "environment" } & EnvironmentRef)
  | ({ kind: "session" } & SessionRef)
  | ({ kind: "file" } & FileRef);

export function projectRef(backendId: BackendId, projectId: string): ProjectRef {
  return { backendId, projectId: parseEntityId(projectId, "projectId") };
}

export function environmentRef(backendId: BackendId, environmentId: string): EnvironmentRef {
  return { backendId, environmentId: parseEntityId(environmentId, "environmentId") };
}

export function sessionRef(
  backendId: BackendId,
  environmentId: string,
  sessionId: string,
): SessionRef {
  return {
    ...environmentRef(backendId, environmentId),
    sessionId: parseEntityId(sessionId, "sessionId"),
  };
}

export function parseProjectRef(value: unknown): ProjectRef {
  const record = asRecord(value, "project reference");
  return projectRef(parseBackendId(record.backendId), parseEntityId(record.projectId, "projectId"));
}

export function parseEnvironmentRef(value: unknown): EnvironmentRef {
  const record = asRecord(value, "environment reference");
  return environmentRef(
    parseBackendId(record.backendId),
    parseEntityId(record.environmentId, "environmentId"),
  );
}

export function parseFileRef(value: unknown): FileRef {
  const record = asRecord(value, "file reference");
  const relativePath = parseEntityId(record.relativePath, "relativePath");
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("Expected relativePath to stay inside the workspace.");
  }
  return {
    ...parseEnvironmentRef(record),
    workspaceGeneration: parseEntityId(record.workspaceGeneration, "workspaceGeneration"),
    relativePath,
  };
}

/*
 * Structured serialization: a delimiter-joined key would let a backend ID
 * containing the delimiter collide with another backend's resource.
 */

export function backendKey(backendId: BackendId): string {
  return JSON.stringify([backendId, "backend"]);
}

export function projectKey(ref: ProjectRef): string {
  return JSON.stringify([ref.backendId, "project", ref.projectId]);
}

export function environmentKey(ref: EnvironmentRef): string {
  return JSON.stringify([ref.backendId, "environment", ref.environmentId]);
}

export function sessionKey(ref: SessionRef): string {
  return JSON.stringify([ref.backendId, "session", ref.environmentId, ref.sessionId]);
}

export function fileKey(ref: FileRef): string {
  return JSON.stringify([
    ref.backendId,
    "file",
    ref.environmentId,
    ref.workspaceGeneration,
    ref.relativePath,
  ]);
}

export function resourceKey(ref: ResourceRef): string {
  switch (ref.kind) {
    case "project":
      return projectKey(ref);
    case "environment":
      return environmentKey(ref);
    case "session":
      return sessionKey(ref);
    case "file":
      return fileKey(ref);
  }
}

/** Inverse of {@link environmentKey}; `null` for anything that is not one. */
export function parseEnvironmentKey(key: string): EnvironmentRef | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[1] !== "environment") return null;
    return parseEnvironmentRef({ backendId: parsed[0], environmentId: parsed[2] });
  } catch {
    return null;
  }
}

export function sameBackend(a: BackendRef, b: BackendRef): boolean {
  return a.backendId === b.backendId;
}

export function sameEnvironment(a: EnvironmentRef, b: EnvironmentRef): boolean {
  return a.backendId === b.backendId && a.environmentId === b.environmentId;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected the ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

/*
 * Deep links name a backend and a resource, never a route, port or
 * credential. A link for a backend this client has not saved presents an
 * add-route action rather than being reinterpreted as Local.
 */

export const FEDERATED_LINK_PARAM = "resource";

export function encodeResourceLink(ref: EnvironmentRef | ProjectRef): string {
  const value =
    "environmentId" in ref
      ? { b: ref.backendId, e: ref.environmentId }
      : { b: ref.backendId, p: ref.projectId };
  return encodeURIComponent(JSON.stringify(value));
}

export function decodeResourceLink(value: string): EnvironmentRef | ProjectRef | null {
  try {
    const parsed = asRecord(JSON.parse(decodeURIComponent(value)), "resource link");
    if (typeof parsed.e === "string") {
      return environmentRef(parseBackendId(parsed.b), parsed.e);
    }
    if (typeof parsed.p === "string") return projectRef(parseBackendId(parsed.b), parsed.p);
    return null;
  } catch {
    return null;
  }
}
