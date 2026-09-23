import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import {
  isOpaquePreviewId,
  PREVIEW_ADDRESS_FAMILIES,
  PREVIEW_DEFINITION_SCHEMA_VERSION,
  PREVIEW_PROVENANCE_KINDS,
  PREVIEW_SCHEMES,
  PREVIEW_TARGET_KINDS,
  type PreviewServiceDefinition,
} from "@orkestrator/protocol/preview-services";

import { StorageKanban } from "./storage-kanban.js";
import { isRecord } from "./storage-shared.js";

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
export class StoragePreviewServices extends StorageKanban {
  protected previewServiceMutation: Promise<unknown> = Promise.resolve();
  protected previewSettingsMutation: Promise<unknown> = Promise.resolve();
  private previewIdentityPromise: Promise<PreviewBackendIdentity> | null = null;

  protected previewServicesFile(): string {
    return this.file("preview-services.json");
  }

  protected previewSettingsFile(): string {
    return this.file("preview-settings.json");
  }

  protected backendIdentityFile(): string {
    return this.file("backend-identity.json");
  }

  private enqueuePreview<T>(
    field: "previewServiceMutation" | "previewSettingsMutation",
    file: string,
    description: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(file, description);
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this[field].then(run, run);
    this[field] = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async loadPreviewServiceStore(): Promise<LoadedPreviewServiceStore> {
    const raw = await this.loadJson<unknown>(this.previewServicesFile(), () => ({}));
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
    return this.enqueuePreview(
      "previewServiceMutation",
      this.previewServicesFile(),
      "preview service storage",
      async () => {
        const raw = await this.loadJson<unknown>(this.previewServicesFile(), () => ({}));
        const opaque = isRecord(raw) && isRecord(raw.definitions) ? raw.definitions : {};
        const { store } = await this.loadPreviewServiceStore();
        const { changed, result } = mutate(store);
        if (!changed) return result;
        const preserved: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(opaque)) {
          if (previewDefinitionProblem(key, value)) preserved[key] = value;
        }
        store.operations = store.operations.slice(-MAX_OPERATIONS);
        await this.saveJson(this.previewServicesFile(), {
          version: 1,
          definitions: { ...preserved, ...store.definitions },
          operations: store.operations,
        });
        return result;
      },
    );
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
    const fingerprint = createHash("sha256").update(path.resolve(this.dataDir)).digest("hex");
    return this.enqueuePreview(
      "previewSettingsMutation",
      this.backendIdentityFile(),
      "backend identity",
      async () => {
        const stored = await this.loadJson<unknown>(this.backendIdentityFile(), () => null);
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
        await this.saveJson(this.backendIdentityFile(), {
          version: 1,
          instanceId,
          dataDirFingerprint: fingerprint,
          createdAt: new Date().toISOString(),
        });
        return { instanceId, created: true };
      },
    );
  }

  async loadPreviewSettings(): Promise<PreviewSettings> {
    return sanitizeSettings(
      await this.loadJson<unknown>(this.previewSettingsFile(), () => DEFAULT_PREVIEW_SETTINGS),
    );
  }

  async updatePreviewSettings(
    update: (current: PreviewSettings) => PreviewSettings,
  ): Promise<PreviewSettings> {
    return this.enqueuePreview(
      "previewSettingsMutation",
      this.previewSettingsFile(),
      "preview settings",
      async () => {
        const next = sanitizeSettings(update(await this.loadPreviewSettings()));
        await this.saveJson(this.previewSettingsFile(), next);
        return next;
      },
    );
  }
}
