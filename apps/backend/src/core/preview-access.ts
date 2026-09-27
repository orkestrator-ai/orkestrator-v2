import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  isPreviewSurface,
  PREVIEW_SESSION_CODE_TTL_MS,
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
  type PreviewAttachmentDescriptor,
  type PreviewAttachmentSummary,
  type PreviewSurface,
} from "@orkestrator/protocol/preview-access";
import {
  normalizePreviewPath,
  PREVIEW_LIMITS,
  previewFailure,
  type PreviewErrorCategory,
  type PreviewLimits,
} from "@orkestrator/protocol/preview-services";

import type {
  PreviewRevocationReason,
  PreviewServiceRegistry,
} from "./preview-service-registry.js";

export type PreviewAccessRevocationReason =
  | PreviewRevocationReason
  | "credential-rotated"
  | "operator-revoked"
  | "released"
  | "expired";

/** Publication hooks supplied by the private-origin manager (step 10). */
export interface PreviewPublicationPort {
  /** Absolute bootstrap action URL, or null when browser publication is unavailable. */
  bootstrapAction(): string | null;
  originFor(serviceId: string): string | null;
}

export interface PreviewAccessOptions {
  registry: PreviewServiceRegistry;
  limits?: PreviewLimits;
  now?: () => number;
  /** Kill switch for new issuance. Disabling it does not revoke active access. */
  issuanceEnabled: () => boolean;
  publication?: () => PreviewPublicationPort | null;
  sweepIntervalMs?: number;
  logger?: Pick<Console, "warn">;
}

interface TrackedResource {
  close(reason: PreviewAccessRevocationReason): void;
}

interface Attachment {
  attachmentId: string;
  serviceId: string;
  environmentId: string;
  surface: PreviewSurface;
  generation: number;
  clientKey: string;
  /** sha256 of the tunnel credential or browser session secret. */
  secretHash: Buffer | null;
  createdAt: number;
  idleExpiresAt: number;
  expiresAt: number;
  state: PreviewAttachmentSummary["state"];
  resources: Set<TrackedResource>;
  path: string;
}

interface OneUseSecret {
  hash: Buffer;
  attachmentId: string;
  expiresAt: number;
  clientKey: string;
}

export interface AuthenticatedPreviewAccess {
  attachmentId: string;
  serviceId: string;
  environmentId: string;
  surface: PreviewSurface;
  generation: number;
  expiresAt: number;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function matches(stored: Buffer | null, candidate: string): boolean {
  if (!stored || typeof candidate !== "string" || candidate.length > 256) return false;
  const hashed = digest(candidate);
  return stored.length === hashed.length && timingSafeEqual(stored, hashed);
}

function denied(category: PreviewErrorCategory, message?: string) {
  return previewFailure(category, message ? { message } : {});
}

/**
 * Scoped preview access. Every credential here authorizes exactly one
 * registered service at one endpoint generation, for one surface, until it
 * expires or is revoked. None of them authenticate the control API, select an
 * upstream, or survive a backend restart (all state is in memory, and only
 * hashes of secrets are held).
 */
export class PreviewAccessService {
  private readonly attachments = new Map<string, Attachment>();
  private readonly grants = new Map<string, OneUseSecret>();
  private readonly sessionCodes = new Map<string, OneUseSecret>();
  private readonly limits: PreviewLimits;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private readonly logger: Pick<Console, "warn">;
  private disposed = false;
  private readonly counters = { issued: 0, revoked: 0, expired: 0, denied: 0 };

  constructor(private readonly options: PreviewAccessOptions) {
    this.limits = options.limits ?? PREVIEW_LIMITS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.unsubscribe = options.registry.onRevoked((serviceIds, reason) => {
      this.revokeServices(serviceIds, reason);
    });
    this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 15_000);
    this.sweepTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.revokeAll("shutdown");
    this.disposed = true;
    clearInterval(this.sweepTimer);
    this.unsubscribe();
  }

  stats() {
    let resources = 0;
    let active = 0;
    for (const attachment of this.attachments.values()) {
      if (attachment.state === "active") active += 1;
      resources += attachment.resources.size;
    }
    return {
      attachments: active,
      resources,
      pendingGrants: this.grants.size,
      pendingSessionCodes: this.sessionCodes.size,
      ...this.counters,
    };
  }

  summaries(): PreviewAttachmentSummary[] {
    return Array.from(this.attachments.values()).map((attachment) => ({
      attachmentId: attachment.attachmentId,
      serviceId: attachment.serviceId,
      surface: attachment.surface,
      endpointGeneration: attachment.generation,
      state: attachment.state,
      activeResources: attachment.resources.size,
      expiresAt: new Date(attachment.expiresAt).toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // Issuance (trusted control API only)

  async createAttachment(raw: Record<string, unknown>): Promise<PreviewAttachmentDescriptor> {
    if (this.disposed) throw denied("backend-unavailable");
    if (!this.options.issuanceEnabled()) {
      throw denied("unsupported", "New preview access is disabled on this backend.");
    }
    const serviceId = raw.serviceId;
    if (typeof serviceId !== "string") throw denied("invalid-request", "serviceId is required.");
    if (!isPreviewSurface(raw.surface)) throw denied("invalid-request", "Invalid surface.");
    const surface = raw.surface;
    if (surface === "browser-embedded") {
      throw denied(
        "unsupported",
        "Embedded browser previews are not supported; use the top-level preview.",
      );
    }
    const clientKey =
      typeof raw.clientKey === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(raw.clientKey)
        ? raw.clientKey
        : "anonymous";
    const path = normalizePreviewPath(raw.path);

    const registry = this.options.registry;
    let service = registry.serviceSnapshot(serviceId);
    if (!service) throw denied("not-found");
    if (!service.definition.enabled) throw denied("forbidden", "This service is disabled.");
    if (service.endpoint.state !== "available") {
      service = await registry.refresh(serviceId);
    }
    if (service.endpoint.state !== "available") {
      throw previewFailure(
        service.endpoint.failure?.category ?? "target-unmapped",
        service.endpoint.failure ?? {},
      );
    }
    if (surface === "desktop-tunnel" && service.definition.scheme !== "http") {
      throw denied(
        "unsupported",
        "The desktop tunnel carries HTTP services only. Open HTTPS services through the private preview origin.",
      );
    }
    const publication = surface === "browser-top-level" ? this.options.publication?.() : null;
    const bootstrapAction = publication?.bootstrapAction() ?? null;
    const origin = publication?.originFor(serviceId) ?? null;
    if (surface === "browser-top-level" && (!bootstrapAction || !origin)) {
      throw denied("unsupported", "Browser preview publication is not available on this backend.");
    }

    this.sweep();
    let perService = 0;
    let total = 0;
    for (const attachment of this.attachments.values()) {
      if (attachment.state !== "active") continue;
      total += 1;
      if (attachment.serviceId === serviceId) perService += 1;
    }
    if (
      perService >= this.limits.attachmentsPerService ||
      total >= this.limits.attachmentsPerBackend
    ) {
      this.counters.denied += 1;
      throw denied(
        "capacity-exceeded",
        "Too many preview attachments are open. Close unused previews and retry.",
      );
    }

    const now = this.now();
    const attachmentId = `att_${randomBytes(12).toString("base64url")}`;
    const credential = surface === "desktop-tunnel" ? secret() : null;
    const attachment: Attachment = {
      attachmentId,
      serviceId,
      environmentId: service.definition.environmentId,
      surface,
      generation: service.endpoint.endpointGeneration,
      clientKey,
      secretHash: credential ? digest(credential) : null,
      createdAt: now,
      idleExpiresAt: now + this.limits.sessionIdleMs,
      expiresAt: now + this.limits.sessionAbsoluteMs,
      state: "active",
      resources: new Set(),
      path,
    };

    let grant: string | null = null;
    if (surface === "browser-top-level") {
      let pendingForClient = 0;
      for (const pending of this.grants.values()) {
        const owner = this.attachments.get(pending.attachmentId);
        if (pending.clientKey === clientKey && owner?.serviceId === serviceId)
          pendingForClient += 1;
      }
      if (
        pendingForClient >= this.limits.grantsPendingPerClientService ||
        this.grants.size >= this.limits.grantsPendingPerBackend
      ) {
        this.counters.denied += 1;
        throw denied(
          "capacity-exceeded",
          "Too many preview sign-ins are pending. Wait a minute and retry.",
        );
      }
      grant = secret();
      this.grants.set(attachmentId, {
        hash: digest(grant),
        attachmentId,
        expiresAt: now + this.limits.grantTtlMs,
        clientKey,
      });
    }
    this.attachments.set(attachmentId, attachment);
    this.counters.issued += 1;

    return {
      attachmentId,
      serviceId,
      environmentId: attachment.environmentId,
      backendInstanceId: registry.backendInstanceId,
      backendEpoch: registry.backendEpoch,
      endpointGeneration: attachment.generation,
      surface,
      applicationPort: service.definition.applicationPort,
      scheme: service.definition.scheme,
      expiresAt: new Date(attachment.expiresAt).toISOString(),
      idleExpiresAt: new Date(attachment.idleExpiresAt).toISOString(),
      ...(credential
        ? {
            tunnel: {
              path: PREVIEW_TUNNEL_PATH,
              subprotocol: PREVIEW_TUNNEL_SUBPROTOCOL,
              credential,
            },
          }
        : {}),
      ...(grant && bootstrapAction && origin
        ? {
            bootstrap: {
              action: bootstrapAction,
              grant,
              origin,
              expiresAt: new Date(now + this.limits.grantTtlMs).toISOString(),
            },
          }
        : {}),
    };
  }

  /** Trusted-control renewal; never extends past the absolute lifetime. */
  renewAttachment(attachmentId: unknown): { idleExpiresAt: string; expiresAt: string } {
    const attachment =
      typeof attachmentId === "string" ? this.attachments.get(attachmentId) : undefined;
    if (!attachment) throw denied("not-found");
    this.assertUsable(attachment);
    attachment.idleExpiresAt = Math.min(
      this.now() + this.limits.sessionIdleMs,
      attachment.expiresAt,
    );
    return {
      idleExpiresAt: new Date(attachment.idleExpiresAt).toISOString(),
      expiresAt: new Date(attachment.expiresAt).toISOString(),
    };
  }

  /** Idempotent release of one consumer. Never touches the service or its app. */
  releaseAttachment(attachmentId: unknown): { released: boolean } {
    const attachment =
      typeof attachmentId === "string" ? this.attachments.get(attachmentId) : undefined;
    if (!attachment) return { released: false };
    this.close(attachment, "released", "released");
    return { released: true };
  }

  // -------------------------------------------------------------------------
  // Transport authentication (no gateway credential involved)

  authenticateTunnel(attachmentId: string, credential: string): AuthenticatedPreviewAccess {
    const attachment = this.attachments.get(attachmentId);
    if (
      !attachment ||
      attachment.surface !== "desktop-tunnel" ||
      !matches(attachment.secretHash, credential)
    ) {
      this.counters.denied += 1;
      throw denied("forbidden");
    }
    this.assertUsable(attachment);
    return this.authenticated(attachment);
  }

  /**
   * Bootstrap step 1, on the dedicated bootstrap authority: consume the
   * one-use grant atomically and mint a short, one-use, host-bound session
   * code. Concurrent exchanges of one grant yield exactly one success.
   */
  consumeBootstrapGrant(
    attachmentId: unknown,
    grant: unknown,
  ): { code: string; origin: string; serviceId: string } {
    if (typeof attachmentId !== "string" || typeof grant !== "string") throw denied("forbidden");
    const pending = this.grants.get(attachmentId);
    // Delete before validating the secret so a replay after a mismatch cannot
    // retry; the legitimate client obtains a fresh grant instead.
    this.grants.delete(attachmentId);
    const attachment = this.attachments.get(attachmentId);
    if (!pending || !attachment || !matches(pending.hash, grant)) {
      this.counters.denied += 1;
      throw denied("forbidden");
    }
    if (pending.expiresAt <= this.now()) {
      this.counters.expired += 1;
      throw denied("access-expired");
    }
    this.assertUsable(attachment);
    const origin = this.options.publication?.()?.originFor(attachment.serviceId);
    if (!origin) throw denied("unsupported");
    const code = secret();
    this.sessionCodes.set(attachmentId, {
      hash: digest(code),
      attachmentId,
      expiresAt: this.now() + PREVIEW_SESSION_CODE_TTL_MS,
      clientKey: pending.clientKey,
    });
    return { code: `${attachmentId}.${code}`, origin, serviceId: attachment.serviceId };
  }

  /**
   * Bootstrap step 2, on the service host: exchange the session code for the
   * host-only session cookie secret. The code only yields a session for the
   * service whose host it arrived on.
   */
  consumeSessionCode(
    code: unknown,
    serviceId: string,
  ): { session: string; path: string; access: AuthenticatedPreviewAccess } {
    if (typeof code !== "string" || code.length > 300) throw denied("forbidden");
    const [attachmentId, value] = code.split(".", 2);
    const pending = attachmentId ? this.sessionCodes.get(attachmentId) : undefined;
    if (attachmentId) this.sessionCodes.delete(attachmentId);
    const attachment = attachmentId ? this.attachments.get(attachmentId) : undefined;
    if (
      !pending ||
      !attachment ||
      !value ||
      !matches(pending.hash, value) ||
      attachment.serviceId !== serviceId
    ) {
      this.counters.denied += 1;
      throw denied("forbidden");
    }
    if (pending.expiresAt <= this.now()) throw denied("access-expired");
    this.assertUsable(attachment);
    const session = secret();
    attachment.secretHash = digest(session);
    return {
      session: `${attachmentId}.${session}`,
      path: attachment.path,
      access: this.authenticated(attachment),
    };
  }

  /** Browser session cookie check. Traffic extends idle expiry up to the absolute cap. */
  authenticateSession(cookieValue: string | null, serviceId: string): AuthenticatedPreviewAccess {
    if (!cookieValue || cookieValue.length > 300) throw denied("forbidden");
    const [attachmentId, value] = cookieValue.split(".", 2);
    const attachment = attachmentId ? this.attachments.get(attachmentId) : undefined;
    if (
      !attachment ||
      attachment.surface !== "browser-top-level" ||
      attachment.serviceId !== serviceId ||
      !value ||
      !matches(attachment.secretHash, value)
    ) {
      this.counters.denied += 1;
      throw denied("forbidden");
    }
    this.assertUsable(attachment);
    attachment.idleExpiresAt = Math.min(
      this.now() + this.limits.sessionIdleMs,
      attachment.expiresAt,
    );
    return this.authenticated(attachment);
  }

  /**
   * Track a live transport resource (socket, request) under its attachment so
   * revocation can close it. Returns an idempotent release. Rejects new work
   * immediately once the attachment is no longer usable.
   */
  track(access: AuthenticatedPreviewAccess, resource: TrackedResource): () => void {
    const attachment = this.attachments.get(access.attachmentId);
    if (!attachment) throw denied("access-expired");
    this.assertUsable(attachment);
    attachment.resources.add(resource);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      attachment.resources.delete(resource);
    };
  }

  /** Re-check an authenticated access before starting new upstream work. */
  assertCurrent(access: AuthenticatedPreviewAccess): void {
    const attachment = this.attachments.get(access.attachmentId);
    if (!attachment) throw denied("access-expired");
    this.assertUsable(attachment);
  }

  // -------------------------------------------------------------------------
  // Revocation

  revokeServices(serviceIds: string[], reason: PreviewAccessRevocationReason): number {
    const ids = new Set(serviceIds);
    let revoked = 0;
    for (const attachment of Array.from(this.attachments.values())) {
      if (!ids.has(attachment.serviceId) || attachment.state !== "active") continue;
      // A generation that is still current survives unrelated revocation
      // notices; anything bound to an older generation is closed.
      if (
        reason === "binding-changed" &&
        this.options.registry.isCurrentGeneration(attachment.serviceId, attachment.generation)
      ) {
        continue;
      }
      this.close(attachment, "revoked", reason);
      revoked += 1;
    }
    return revoked;
  }

  revokeAll(reason: PreviewAccessRevocationReason): number {
    let revoked = 0;
    for (const attachment of Array.from(this.attachments.values())) {
      if (attachment.state !== "active") continue;
      this.close(attachment, "revoked", reason);
      revoked += 1;
    }
    this.grants.clear();
    this.sessionCodes.clear();
    return revoked;
  }

  private close(
    attachment: Attachment,
    state: Attachment["state"],
    reason: PreviewAccessRevocationReason,
  ): void {
    if (attachment.state === "active") {
      attachment.state = state;
      if (state === "revoked") this.counters.revoked += 1;
      if (state === "expired") this.counters.expired += 1;
    }
    this.grants.delete(attachment.attachmentId);
    this.sessionCodes.delete(attachment.attachmentId);
    // The hash is kept until the tombstone expires so a holder of the correct
    // credential learns `access-expired` (reauthorize) rather than `forbidden`.
    for (const resource of Array.from(attachment.resources)) {
      attachment.resources.delete(resource);
      try {
        resource.close(reason);
      } catch (error) {
        this.logger.warn(
          `[previews] Closing a revoked resource failed: ${error instanceof Error ? error.name : "error"}`,
        );
      }
    }
    // Keep a bounded tombstone so a late request gets `access-expired`, then forget it.
    const tombstoneMs = 60_000;
    const forgetAt = this.now() + tombstoneMs;
    attachment.expiresAt = Math.min(attachment.expiresAt, forgetAt);
    attachment.idleExpiresAt = Math.min(attachment.idleExpiresAt, forgetAt);
  }

  private assertUsable(attachment: Attachment): void {
    const now = this.now();
    if (
      attachment.state === "active" &&
      (now >= attachment.idleExpiresAt || now >= attachment.expiresAt)
    ) {
      this.close(attachment, "expired", "expired");
    }
    if (attachment.state !== "active") throw denied("access-expired");
    if (!this.options.registry.isCurrentGeneration(attachment.serviceId, attachment.generation)) {
      this.close(attachment, "revoked", "binding-changed");
      throw denied("generation-changed");
    }
  }

  private authenticated(attachment: Attachment): AuthenticatedPreviewAccess {
    return {
      attachmentId: attachment.attachmentId,
      serviceId: attachment.serviceId,
      environmentId: attachment.environmentId,
      surface: attachment.surface,
      generation: attachment.generation,
      expiresAt: attachment.expiresAt,
    };
  }

  /** Coalesced expiry of abandoned grants, codes, and attachments. */
  sweep(): void {
    const now = this.now();
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id);
    for (const [id, code] of this.sessionCodes)
      if (code.expiresAt <= now) this.sessionCodes.delete(id);
    for (const [id, attachment] of Array.from(this.attachments)) {
      if (
        attachment.state === "active" &&
        (now >= attachment.idleExpiresAt || now >= attachment.expiresAt)
      ) {
        this.close(attachment, "expired", "expired");
      }
      if (attachment.state !== "active" && now >= attachment.expiresAt) this.attachments.delete(id);
    }
  }
}
