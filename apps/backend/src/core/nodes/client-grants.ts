import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { BackendId } from "@orkestrator/protocol/federation";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("nodes");

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
 * - Whatever removes a grant tells the listeners of that grant (`onRevoke`), so
 *   a connection authorized by it does not outlive it.
 * - Valid for the workspace only: the commands defined with `access:
 *   "workspace"` (`admitsWorkspaceCommand`, plan item 7012), which are agent
 *   chat, terminals, previews, files and the project boards. Never for
 *   administration (token rotation, attachment, grants, registry commands,
 *   the machine's global settings and credentials, host updates) or any
 *   command without a definition: the allow-list fails closed.
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
  /** Held on the record, so they cannot outlive it. A removed grant never comes back. */
  revocationListeners: Set<() => void>;
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
      revocationListeners: new Set(),
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
    this.remove([grant]);
    return true;
  }

  revokeController(controllerId: BackendId): number {
    const grants = Array.from(this.grants.values()).filter(
      (grant) => grant.controllerId === controllerId,
    );
    this.remove(grants);
    return grants.length;
  }

  revokeAll(): void {
    this.remove(Array.from(this.grants.values()));
  }

  /**
   * Calls `listener` once when the grant this token proves is removed, whether
   * revoked or found expired, and returns the unsubscribe. `null` means the token
   * proves no grant held here. A grant past its deadline still counts until it
   * is removed, so a subscriber racing that deadline hears about the removal
   * rather than finding nothing to subscribe to.
   */
  onRevoke(token: string, listener: () => void): (() => void) | null {
    const grant = this.find(token);
    if (!grant || !timingSafeEqual(hashToken(token), grant.hash)) return null;
    grant.revocationListeners.add(listener);
    return () => {
      grant.revocationListeners.delete(listener);
    };
  }

  /** The live grant a bearer token proves, or `null`. Constant-time on the hash. */
  authenticate(token: string): ClientGrant | null {
    const grant = this.find(token);
    if (!grant) return null;
    if (grant.expiresAt <= this.now()) {
      this.remove([grant]);
      return null;
    }
    const hash = hashToken(token);
    return timingSafeEqual(hash, grant.hash) ? publicGrant(grant) : null;
  }

  static looksLikeGrant(token: string): boolean {
    return token.startsWith(GRANT_PREFIX);
  }

  private find(token: string): StoredGrant | null {
    if (!token.startsWith(GRANT_PREFIX)) return null;
    const separator = token.indexOf(".");
    if (separator <= GRANT_PREFIX.length) return null;
    return this.grants.get(token.slice(GRANT_PREFIX.length, separator)) ?? null;
  }

  private prune(): void {
    const now = this.now();
    this.remove(Array.from(this.grants.values()).filter((grant) => grant.expiresAt <= now));
  }

  /** Every record goes before any listener runs, and one that throws cannot strand the rest. */
  private remove(grants: StoredGrant[]): void {
    for (const grant of grants) this.grants.delete(grant.grantId);
    for (const grant of grants) {
      const listeners = Array.from(grant.revocationListeners);
      grant.revocationListeners.clear();
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          log.warn("grant.revocation-listener-failed", { error: formatLogError(error) });
        }
      }
    }
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
