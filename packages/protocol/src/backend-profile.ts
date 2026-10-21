/**
 * A backend's canonical machine profile and its client-facing hello.
 *
 * The profile (display name + colour token) lives on the backend so every
 * client with access converges on the same appearance. A client nickname is
 * only a local alias "on this device". The colour is a semantic palette
 * token, never CSS: clients map tokens to theme colours themselves, and an
 * older client treats a token it does not know as a labelled neutral
 * fallback without rewriting the stored value.
 *
 * The hello is the authenticated handshake a client performs before it
 * publishes a backend's entities or enables mutations. It carries only safe
 * metadata: never data paths, auth-file locations or credentials.
 */

import { isBackendId, type BackendId } from "./federation.js";

export const MACHINE_COLOR_TOKENS = [
  "violet",
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "slate",
] as const;

export type MachineColorToken = (typeof MACHINE_COLOR_TOKENS)[number];

/** Rendered when a client does not know a token. It is never stored. */
export const FALLBACK_MACHINE_COLOR = "neutral" as const;

export const MAX_MACHINE_DISPLAY_NAME_LENGTH = 64;
const MAX_COLOR_TOKEN_LENGTH = 32;

export function isMachineColorToken(value: unknown): value is MachineColorToken {
  return typeof value === "string" && (MACHINE_COLOR_TOKENS as readonly string[]).includes(value);
}

/**
 * Deterministic default from the installation identity, so a backend that
 * has not yet persisted a profile does not get a different colour on every
 * client. FNV-1a keeps it stable across runtimes without a crypto dependency.
 */
export function defaultMachineColor(installationId: string): MachineColorToken {
  let hash = 2_166_136_261;
  for (let index = 0; index < installationId.length; index += 1) {
    hash ^= installationId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return MACHINE_COLOR_TOKENS[(hash >>> 0) % MACHINE_COLOR_TOKENS.length]!;
}

/**
 * Normalize a backend-sourced or user-entered machine name: control
 * characters removed, whitespace collapsed, bounded. Returns `undefined` for
 * a blank value.
 */
export function normalizeMachineDisplayName(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Expected the machine name to be a string.");
  // oxlint-disable-next-line no-control-regex -- strips control characters from remote input
  const name = value
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return undefined;
  if (Array.from(name).length > MAX_MACHINE_DISPLAY_NAME_LENGTH) {
    throw new Error(
      `Use a machine name of ${MAX_MACHINE_DISPLAY_NAME_LENGTH} characters or fewer.`,
    );
  }
  return name;
}

export interface BackendProfile {
  /** Compare-and-swap revision; starts at 1 and increments on every accepted edit. */
  revision: number;
  displayName: string;
  /**
   * A palette token. Parsed as a plain string so a client keeps (and does not
   * rewrite) a token newer than its palette; render it through
   * {@link machineColorForDisplay}.
   */
  colorToken: string;
  updatedAt: string;
}

export interface BackendProfileUpdate {
  expectedRevision: number;
  displayName?: string;
  colorToken?: MachineColorToken;
}

export const BACKEND_PROFILE_CHANGED_EVENT = "backend-profile-changed";

/** Raised by the backend when `expectedRevision` is stale; the client reloads. */
export const BACKEND_PROFILE_CONFLICT_CODE = "backend-profile-conflict";

export function machineColorForDisplay(
  token: string | undefined,
): MachineColorToken | typeof FALLBACK_MACHINE_COLOR {
  return isMachineColorToken(token) ? token : FALLBACK_MACHINE_COLOR;
}

export function parseBackendProfile(value: unknown): BackendProfile {
  const record = asRecord(value, "backend profile");
  const revision = record.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new Error("Expected the backend profile revision to be a positive integer.");
  }
  const displayName = normalizeMachineDisplayName(record.displayName);
  if (!displayName) throw new Error("Expected the backend profile to have a display name.");
  const colorToken = record.colorToken;
  if (
    typeof colorToken !== "string" ||
    colorToken.length === 0 ||
    colorToken.length > MAX_COLOR_TOKEN_LENGTH ||
    !/^[a-z][a-z0-9-]*$/.test(colorToken)
  ) {
    throw new Error("Expected the backend profile colour to be a palette token.");
  }
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt.slice(0, 64) : "";
  return { revision: revision as number, displayName, colorToken, updatedAt };
}

export function parseBackendProfileUpdate(value: unknown): BackendProfileUpdate {
  const record = asRecord(value, "backend profile update");
  for (const key of Object.keys(record)) {
    if (key !== "expectedRevision" && key !== "displayName" && key !== "colorToken") {
      throw new Error(`Unexpected backend profile field: ${key.slice(0, 40)}`);
    }
  }
  const expectedRevision = record.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    throw new Error("Expected expectedRevision to be a positive integer.");
  }
  const update: BackendProfileUpdate = { expectedRevision: expectedRevision as number };
  if (record.displayName !== undefined) {
    const displayName = normalizeMachineDisplayName(record.displayName);
    if (!displayName) throw new Error("Enter a machine name.");
    update.displayName = displayName;
  }
  if (record.colorToken !== undefined) {
    if (!isMachineColorToken(record.colorToken)) {
      throw new Error("Choose one of the supported machine colours.");
    }
    update.colorToken = record.colorToken;
  }
  if (update.displayName === undefined && update.colorToken === undefined) {
    throw new Error("A backend profile update must change the name or the colour.");
  }
  return update;
}

/*
 * Hello handshake
 */

export const BACKEND_HELLO_PATH = "/__orkestrator/hello";
export const BACKEND_HELLO_SCHEMA_VERSION = 1;

/** Client API range this build of the protocol speaks. */
export const CLIENT_API_VERSION = 1;

/**
 * Role of the listener that answered the hello. A managed SSH route may only
 * forward to a `client` listener: the loopback `control` listener also serves
 * maintenance routes (updater, web-client access) that are not part of the
 * ordinary client API.
 */
export type BackendEndpointRole = "client" | "control";

/** Capability names this protocol knows; values are capability versions. */
export const BACKEND_CAPABILITIES = {
  /** `get_backend_profile` / `update_backend_profile` + profile event. */
  backendProfile: "backend-profile",
  /** A loopback client gateway suitable for an SSH forward is configured. */
  loopbackClientGateway: "loopback-client-gateway",
  /** `get_projects` / `get_environment_snapshots` summary reads. */
  summaryReads: "summary-reads",
  /** `attach_controller` / `detach_controller` and node mode (command nodes). */
  nodeAttachment: "node-attachment",
} as const;

const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_NAME_LENGTH = 64;

export interface BackendHello {
  schemaVersion: 1;
  installationId: BackendId;
  generation: string;
  appVersion: string;
  clientApi: { minVersion: number; maxVersion: number };
  capabilities: Record<string, number>;
  profile: BackendProfile;
  endpointRole: BackendEndpointRole;
  /** Optional non-secret grant identity; absent when the gateway has one shared grant. */
  authorizationScopeId?: string;
  /** Command-node role; absent from backends that predate command nodes. */
  nodeMode?: "standalone" | "command" | "leaf";
}

export function parseBackendHello(value: unknown): BackendHello {
  const record = asRecord(value, "backend hello");
  if (record.schemaVersion !== BACKEND_HELLO_SCHEMA_VERSION) {
    throw new Error("The backend hello uses an unsupported schema version.");
  }
  if (!isBackendId(record.installationId)) {
    throw new Error("The backend hello has an invalid installation identity.");
  }
  const generation = boundedText(record.generation, "generation", 200);
  const appVersion = boundedText(record.appVersion, "appVersion", 64);
  const clientApi = asRecord(record.clientApi, "client API range");
  const minVersion = clientApi.minVersion;
  const maxVersion = clientApi.maxVersion;
  if (
    !Number.isSafeInteger(minVersion) ||
    !Number.isSafeInteger(maxVersion) ||
    (minVersion as number) < 1 ||
    (maxVersion as number) < (minVersion as number) ||
    (maxVersion as number) > 1_000
  ) {
    throw new Error("The backend hello has an invalid client API range.");
  }
  const rawCapabilities = asRecord(record.capabilities, "capabilities");
  const capabilityEntries = Object.entries(rawCapabilities);
  if (capabilityEntries.length > MAX_CAPABILITIES) {
    throw new Error("The backend hello lists too many capabilities.");
  }
  const capabilities: Record<string, number> = {};
  for (const [name, version] of capabilityEntries) {
    if (
      name.length === 0 ||
      name.length > MAX_CAPABILITY_NAME_LENGTH ||
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      !Number.isSafeInteger(version) ||
      (version as number) < 0 ||
      (version as number) > 1_000_000
    ) {
      throw new Error("The backend hello has an invalid capability.");
    }
    capabilities[name] = version as number;
  }
  const endpointRole = record.endpointRole;
  if (endpointRole !== "client" && endpointRole !== "control") {
    throw new Error("The backend hello has an invalid endpoint role.");
  }
  const hello: BackendHello = {
    schemaVersion: BACKEND_HELLO_SCHEMA_VERSION,
    installationId: record.installationId,
    generation,
    appVersion,
    clientApi: { minVersion: minVersion as number, maxVersion: maxVersion as number },
    capabilities,
    profile: parseBackendProfile(record.profile),
    endpointRole,
  };
  if (
    record.nodeMode === "standalone" ||
    record.nodeMode === "command" ||
    record.nodeMode === "leaf"
  ) {
    hello.nodeMode = record.nodeMode;
  }
  if (record.authorizationScopeId !== undefined) {
    hello.authorizationScopeId = boundedText(
      record.authorizationScopeId,
      "authorizationScopeId",
      128,
    );
  }
  return hello;
}

export function isClientApiCompatible(hello: Pick<BackendHello, "clientApi">): boolean {
  return (
    hello.clientApi.minVersion <= CLIENT_API_VERSION &&
    hello.clientApi.maxVersion >= CLIENT_API_VERSION
  );
}

export function hasBackendCapability(
  hello: Pick<BackendHello, "capabilities"> | null | undefined,
  name: string,
  minimumVersion = 1,
): boolean {
  const version = hello?.capabilities[name];
  return typeof version === "number" && version >= minimumVersion;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`The backend hello field is invalid: ${label}`);
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected the ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}
