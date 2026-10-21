import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { BackendId } from "@orkestrator/protocol/federation";

/**
 * Short-lived client grants a leaf issues to an attached command node, which
 * hands them to a client so the client can open a leaf workspace (agent
 * chat, terminals, previews) directly, without ever holding the leaf's
 * gateway token.
 *
 * - Bound to the issuing controller; revoked when it detaches.
 * - At most `MAX_GRANT_TTL_MS` per issue or renewal.
 * - Kept in memory as hashes only: a restart of the leaf revokes every grant
 *   and the command node issues a new one.
 * - Never valid for administration (see `NODE_EXCLUDED_COMMANDS`): token
 *   rotation, attachment, grants and registry commands.
 */

export const MAX_GRANT_TTL_MS = 15 * 60_000;
const MAX_GRANTS = 256;
const GRANT_PREFIX = "okg_";

export interface ClientGrant {
  grantId: string;
  controllerId: BackendId;
  label: string;
  expiresAt: number;
}

interface StoredGrant extends ClientGrant {
  hash: Buffer;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export class ClientGrantService {
  private readonly grants = new Map<string, StoredGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns the bearer token once; only its hash is kept. */
  issue(input: { controllerId: BackendId; label: string; ttlMs: number }): {
    grant: ClientGrant;
    token: string;
  } {
    this.prune();
    if (this.grants.size >= MAX_GRANTS) {
      throw new Error("Too many client grants are active on this node.");
    }
    const ttlMs = Math.max(30_000, Math.min(MAX_GRANT_TTL_MS, Math.floor(input.ttlMs)));
    const grantId = randomBytes(12).toString("base64url");
    const token = `${GRANT_PREFIX}${grantId}.${randomBytes(32).toString("base64url")}`;
    const stored: StoredGrant = {
      grantId,
      controllerId: input.controllerId,
      label: input.label.slice(0, 64),
      expiresAt: this.now() + ttlMs,
      hash: hashToken(token),
    };
    this.grants.set(grantId, stored);
    return { grant: publicGrant(stored), token };
  }

  /** Extends a live grant issued to the same controller. */
  renew(input: { grantId: string; controllerId: BackendId; ttlMs: number }): ClientGrant | null {
    const grant = this.grants.get(input.grantId);
    if (!grant || grant.controllerId !== input.controllerId || grant.expiresAt <= this.now()) {
      return null;
    }
    grant.expiresAt =
      this.now() + Math.max(30_000, Math.min(MAX_GRANT_TTL_MS, Math.floor(input.ttlMs)));
    return publicGrant(grant);
  }

  revoke(grantId: string, controllerId?: BackendId): boolean {
    const grant = this.grants.get(grantId);
    if (!grant || (controllerId && grant.controllerId !== controllerId)) return false;
    return this.grants.delete(grantId);
  }

  revokeController(controllerId: BackendId): number {
    let revoked = 0;
    for (const [id, grant] of this.grants) {
      if (grant.controllerId === controllerId) {
        this.grants.delete(id);
        revoked += 1;
      }
    }
    return revoked;
  }

  revokeAll(): void {
    this.grants.clear();
  }

  /** The live grant a bearer token proves, or `null`. Constant-time on the hash. */
  authenticate(token: string): ClientGrant | null {
    if (!token.startsWith(GRANT_PREFIX)) return null;
    const separator = token.indexOf(".");
    if (separator <= GRANT_PREFIX.length) return null;
    const grant = this.grants.get(token.slice(GRANT_PREFIX.length, separator));
    if (!grant) return null;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(grant.grantId);
      return null;
    }
    const hash = hashToken(token);
    return timingSafeEqual(hash, grant.hash) ? publicGrant(grant) : null;
  }

  static looksLikeGrant(token: string): boolean {
    return token.startsWith(GRANT_PREFIX);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id);
  }
}

function publicGrant(grant: StoredGrant): ClientGrant {
  return {
    grantId: grant.grantId,
    controllerId: grant.controllerId,
    label: grant.label,
    expiresAt: grant.expiresAt,
  };
}
