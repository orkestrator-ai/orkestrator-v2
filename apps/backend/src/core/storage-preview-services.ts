import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  BACKEND_PROFILE_CONFLICT_CODE,
  defaultMachineColor,
  MAX_MACHINE_DISPLAY_NAME_LENGTH,
  normalizeMachineDisplayName,
  parseBackendProfile,
  parseBackendProfileUpdate,
  type BackendProfile,
  type BackendProfileUpdate,
} from "@orkestrator/protocol/backend-profile";

import {
  isOpaquePreviewId,
  PREVIEW_ADDRESS_FAMILIES,
  PREVIEW_DEFINITION_SCHEMA_VERSION,
  PREVIEW_PROVENANCE_KINDS,
  PREVIEW_SCHEMES,
  PREVIEW_TARGET_KINDS,
  type PreviewServiceDefinition,
} from "@orkestrator/protocol/preview-services";

import { isRecord } from "./storage-shared.js";
import type { StorageContext } from "./storage-context.js";

/** Idempotency record for one committed registry mutation. */
export interface PreviewMutationRecord {
  operationId: string;
  kind: "register" | "update" | "remove";
  serviceId: string;
  definitionRevision: number;
  committedAt: string;
}

export interface PreviewServiceStore {
  version: 1;
  definitions: Record<string, PreviewServiceDefinition>;
  /** Bounded, oldest first. */
  operations: PreviewMutationRecord[];
}

export interface LoadedPreviewServiceStore {
  store: PreviewServiceStore;
  /** Stored records that failed validation. They are kept on disk untouched, never served. */
  invalid: Array<{ key: string; reason: string }>;
}

export interface PreviewBackendIdentity {
  instanceId: string;
  /** True when this call minted a new identity (first run or copied data). */
  created: boolean;
}

/**
 * Raised by `updateBackendProfile` when `expectedRevision` is stale. The
 * message starts with {@link BACKEND_PROFILE_CONFLICT_CODE}, which is all that
 * crosses the gateway; `current` is for in-process callers.
 */
export class BackendProfileConflictError extends Error {
  constructor(readonly current: BackendProfile) {
    super(
      `${BACKEND_PROFILE_CONFLICT_CODE}: The machine profile changed; reload it and try again.`,
    );
    this.name = "BackendProfileConflictError";
  }
}

const DEFAULT_MACHINE_DISPLAY_NAME = "Orkestrator";

/**
 * The first-run machine name: the host name without a trailing `.local`,
 * bounded and stripped of control characters, else "Orkestrator".
 */
export function defaultMachineDisplayName(hostname: string = os.hostname()): string {
  const base = hostname.trim().replace(/\.local\.?$/i, "");
  try {
    return (
      normalizeMachineDisplayName(
        Array.from(base).slice(0, MAX_MACHINE_DISPLAY_NAME_LENGTH).join(""),
      ) ?? DEFAULT_MACHINE_DISPLAY_NAME
    );
  } catch {
    return DEFAULT_MACHINE_DISPLAY_NAME;
  }
}

function storedBackendProfile(value: unknown): BackendProfile | null {
  try {
    return parseBackendProfile(value);
  } catch {
    return null;
  }
}

/**
 * Operator-controlled preview feature settings. Environment variables
 * override the stored values so test profiles and operators can force a mode.
 */
export interface PreviewSettings {
  version: 1;
  /** Issue new scoped access (desktop tunnel / browser sessions). The kill switch. */
  transport: boolean;
  /** Optional in-container relay. */
  relay: boolean;
  publication: {
    enabled: boolean;
    /** Base domain; services are `s-<id>.<domain>`, bootstrap is `bootstrap.<domain>`. */
    domain: string | null;
    certFile: string | null;
    keyFile: string | null;
    /** Extra CA bundle for verifying HTTPS *upstreams*. */
    upstreamCaFile: string | null;
    listenAddress: string | null;
    /** Listen port; 0 selects an ephemeral port (tests). Defaults to 8443. */
    port: number | null;
    /**
     * Port browsers use when a TCP forwarder (for example Tailscale Serve on
     * 443) fronts the listener. Defaults to the bound port.
     */
    publicPort: number | null;
  };
}

export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
  version: 1,
  transport: false,
  relay: false,
  publication: {
    enabled: false,
    domain: null,
    certFile: null,
    keyFile: null,
    upstreamCaFile: null,
    listenAddress: null,
    port: null,
    publicPort: null,
  },
};

const MAX_INVALID_DIAGNOSTICS = 32;
const MAX_OPERATIONS = 256;

function member<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** Returns a reason string when a stored definition is not usable. */
export function previewDefinitionProblem(key: string, value: unknown): string | null {
  if (!isRecord(value)) return "not an object";
  if (value.schemaVersion !== PREVIEW_DEFINITION_SCHEMA_VERSION)
    return "unsupported schema version";
  if (!isOpaquePreviewId(value.serviceId) || value.serviceId !== key) return "invalid service id";
  if (typeof value.environmentId !== "string" || !value.environmentId)
    return "invalid environment id";
  if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 120)
    return "invalid label";
  if (!member(PREVIEW_TARGET_KINDS, value.targetKind)) return "invalid target kind";
  if (
    typeof value.applicationPort !== "number" ||
    !Number.isInteger(value.applicationPort) ||
    value.applicationPort < 1 ||
    value.applicationPort > 65_535
  ) {
    return "invalid application port";
  }
  if (!member(PREVIEW_SCHEMES, value.scheme)) return "invalid scheme";
  if (!member(PREVIEW_ADDRESS_FAMILIES, value.addressFamily)) return "invalid address family";
  if (!member(PREVIEW_PROVENANCE_KINDS, value.provenance)) return "invalid provenance";
  if (value.tlsServerName !== undefined && typeof value.tlsServerName !== "string")
    return "invalid TLS server name";
  if (
    value.readinessPath !== undefined &&
    (typeof value.readinessPath !== "string" || !value.readinessPath.startsWith("/"))
  ) {
    return "invalid readiness path";
  }
  for (const field of ["userOverride", "entry", "enabled"] as const) {
    if (typeof value[field] !== "boolean") return `invalid ${field}`;
  }
  if (!Number.isSafeInteger(value.definitionRevision) || (value.definitionRevision as number) < 1)
    return "invalid definition revision";
  return null;
}

function isMutationRecord(value: unknown): value is PreviewMutationRecord {
  return (
    isRecord(value) &&
    typeof value.operationId === "string" &&
    member(["register", "update", "remove"] as const, value.kind) &&
    typeof value.serviceId === "string" &&
    Number.isSafeInteger(value.definitionRevision) &&
    typeof value.committedAt === "string"
  );
}

function sanitizeSettings(value: unknown): PreviewSettings {
  if (!isRecord(value)) return structuredClone(DEFAULT_PREVIEW_SETTINGS);
  const publication = isRecord(value.publication) ? value.publication : {};
  const text = (field: unknown) =>
    typeof field === "string" && field.trim() ? field.trim() : null;
  const port = publication.port;
  const publicPort = publication.publicPort;
  return {
    version: 1,
    transport: value.transport === true,
    relay: value.relay === true,
    publication: {
      enabled: publication.enabled === true,
      domain: text(publication.domain)?.toLowerCase() ?? null,
      certFile: text(publication.certFile),
      keyFile: text(publication.keyFile),
      upstreamCaFile: text(publication.upstreamCaFile),
      listenAddress: text(publication.listenAddress),
      port:
        typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65_535
          ? port
          : null,
      publicPort:
        typeof publicPort === "number" &&
        Number.isInteger(publicPort) &&
        publicPort >= 1 &&
        publicPort <= 65_535
          ? publicPort
          : null,
    },
  };
}

/**
 * Durable preview state. Only definitions, idempotency records, the backend
 * identity, and operator settings are stored here — never resolved host ports,
 * grants, cookies, or connectivity assumptions.
 */
export class PreviewServicesRepository {
  constructor(private readonly context: StorageContext) {}

  private previewIdentityPromise: Promise<PreviewBackendIdentity> | null = null;

  private previewServicesFile(): string {
    return this.context.file("preview-services.json");
  }

  private previewSettingsFile(): string {
    return this.context.file("preview-settings.json");
  }

  private backendIdentityFile(): string {
    return this.context.file("backend-identity.json");
  }

  private backendProfileFile(): string {
    return this.context.file("backend-profile.json");
  }

  private enqueuePreview<T>(
    file: string,
    description: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.context.serialize(file, description, operation);
  }

  async loadPreviewServiceStore(): Promise<LoadedPreviewServiceStore> {
    const raw = await this.context.loadJson<unknown>(this.previewServicesFile(), () => ({}));
    const record = isRecord(raw) ? raw : {};
    const definitions: Record<string, PreviewServiceDefinition> = {};
    const invalid: LoadedPreviewServiceStore["invalid"] = [];
    const storedDefinitions = isRecord(record.definitions) ? record.definitions : {};
    for (const [key, value] of Object.entries(storedDefinitions)) {
      const problem = previewDefinitionProblem(key, value);
      if (problem) {
        if (invalid.length < MAX_INVALID_DIAGNOSTICS)
          invalid.push({ key: key.slice(0, 128), reason: problem });
        continue;
      }
      definitions[key] = value as PreviewServiceDefinition;
    }
    const operations = Array.isArray(record.operations)
      ? record.operations.filter(isMutationRecord).slice(-MAX_OPERATIONS)
      : [];
    return { store: { version: 1, definitions, operations }, invalid };
  }

  /**
   * Serialized read-modify-write. `mutate` returns `changed: false` to skip the
   * write. Invalid stored records are preserved verbatim so a newer schema's
   * data survives an older reader.
   */
  async mutatePreviewServiceStore<T>(
    mutate: (store: PreviewServiceStore) => { changed: boolean; result: T },
  ): Promise<T> {
    return this.enqueuePreview(this.previewServicesFile(), "preview service storage", async () => {
      const raw = await this.context.loadJson<unknown>(this.previewServicesFile(), () => ({}));
      const opaque = isRecord(raw) && isRecord(raw.definitions) ? raw.definitions : {};
      const { store } = await this.loadPreviewServiceStore();
      const { changed, result } = mutate(store);
      if (!changed) return result;
      const preserved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(opaque)) {
        if (previewDefinitionProblem(key, value)) preserved[key] = value;
      }
      store.operations = store.operations.slice(-MAX_OPERATIONS);
      await this.context.saveJson(this.previewServicesFile(), {
        version: 1,
        definitions: { ...preserved, ...store.definitions },
        operations: store.operations,
      });
      return result;
    });
  }

  /**
   * Stable, non-secret backend identity. It is bound to the resolved data
   * directory: a copied data directory mints a new identity instead of
   * advertising the source's, so two live backends never claim one identity.
   */
  getPreviewBackendIdentity(): Promise<PreviewBackendIdentity> {
    this.previewIdentityPromise ??= this.loadOrCreatePreviewIdentity().catch((error) => {
      this.previewIdentityPromise = null;
      throw error;
    });
    return this.previewIdentityPromise;
  }

  private async loadOrCreatePreviewIdentity(): Promise<PreviewBackendIdentity> {
    const fingerprint = createHash("sha256")
      .update(path.resolve(this.context.dataDir))
      .digest("hex");
    return this.enqueuePreview(this.backendIdentityFile(), "backend identity", async () => {
      const stored = await this.context.loadJson<unknown>(this.backendIdentityFile(), () => null);
      if (
        isRecord(stored) &&
        isOpaquePreviewId(stored.instanceId) &&
        stored.dataDirFingerprint === fingerprint
      ) {
        return { instanceId: stored.instanceId, created: false };
      }
      if (isRecord(stored) && isOpaquePreviewId(stored.instanceId)) {
        console.warn(
          "[backend] Data directory moved or copied; minting a new backend identity for previews",
        );
      }
      const instanceId = `bk_${randomBytes(16).toString("base64url")}`;
      await this.context.saveJson(this.backendIdentityFile(), {
        version: 1,
        instanceId,
        dataDirFingerprint: fingerprint,
        createdAt: new Date().toISOString(),
      });
      return { instanceId, created: true };
    });
  }

  /**
   * The canonical machine profile every client renders for this backend.
   * Created once, on the first read, from the host name and a colour derived
   * from the installation identity; later reads return what is stored.
   */
  async getBackendProfile(): Promise<BackendProfile> {
    const stored = storedBackendProfile(
      await this.context.loadJson<unknown>(this.backendProfileFile(), () => null),
    );
    if (stored) return stored;
    const { instanceId } = await this.getPreviewBackendIdentity();
    return this.context.serialize(this.backendProfileFile(), "backend profile", () =>
      this.loadOrCreateBackendProfile(instanceId),
    );
  }

  /**
   * Compare-and-swap edit. A stale `expectedRevision` throws
   * {@link BackendProfileConflictError} and writes nothing.
   */
  async updateBackendProfile(update: BackendProfileUpdate): Promise<BackendProfile> {
    const parsed = parseBackendProfileUpdate(update);
    const { instanceId } = await this.getPreviewBackendIdentity();
    return this.context.serialize(this.backendProfileFile(), "backend profile", async () => {
      const current = await this.loadOrCreateBackendProfile(instanceId);
      if (current.revision !== parsed.expectedRevision) {
        throw new BackendProfileConflictError(current);
      }
      const next: BackendProfile = {
        revision: current.revision + 1,
        displayName: parsed.displayName ?? current.displayName,
        colorToken: parsed.colorToken ?? current.colorToken,
        updatedAt: new Date().toISOString(),
      };
      await this.context.saveJson(this.backendProfileFile(), { version: 1, ...next });
      return next;
    });
  }

  /** Call only under the backend profile lease. */
  private async loadOrCreateBackendProfile(installationId: string): Promise<BackendProfile> {
    const raw = await this.context.loadJson<unknown>(this.backendProfileFile(), () => null);
    const stored = storedBackendProfile(raw);
    if (stored) return stored;
    // An unreadable record is replaced, but past its revision, so an edit
    // based on the old one still conflicts instead of applying blindly.
    const previousRevision =
      isRecord(raw) && Number.isSafeInteger(raw.revision) && (raw.revision as number) > 0
        ? (raw.revision as number)
        : 0;
    if (raw !== null) {
      console.warn("[backend] The stored machine profile was invalid; restoring the default");
    }
    const profile: BackendProfile = {
      revision: previousRevision + 1,
      displayName: defaultMachineDisplayName(),
      colorToken: defaultMachineColor(installationId),
      updatedAt: new Date().toISOString(),
    };
    await this.context.saveJson(this.backendProfileFile(), { version: 1, ...profile });
    return profile;
  }

  async loadPreviewSettings(): Promise<PreviewSettings> {
    return sanitizeSettings(
      await this.context.loadJson<unknown>(
        this.previewSettingsFile(),
        () => DEFAULT_PREVIEW_SETTINGS,
      ),
    );
  }

  async updatePreviewSettings(
    update: (current: PreviewSettings) => PreviewSettings,
  ): Promise<PreviewSettings> {
    return this.enqueuePreview(this.previewSettingsFile(), "preview settings", async () => {
      const next = sanitizeSettings(update(await this.loadPreviewSettings()));
      await this.context.saveJson(this.previewSettingsFile(), next);
      return next;
    });
  }
}

/**
 * Service previews, preview settings and the machine profile: what callers reach as `storage.previewServices`.
 *
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to, like a public method of `StorageService`. Add a
 * method here only when code outside the storage files calls it.
 */
export type PreviewServicesStorage = Pick<
  PreviewServicesRepository,
  | "loadPreviewServiceStore"
  | "mutatePreviewServiceStore"
  | "getPreviewBackendIdentity"
  | "getBackendProfile"
  | "updateBackendProfile"
  | "loadPreviewSettings"
  | "updatePreviewSettings"
>;
