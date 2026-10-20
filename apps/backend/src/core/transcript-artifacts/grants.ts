/**
 * Artifact scope grants: separate artifact authority for shared
 * (environment-wide) tool registrations.
 *
 * A grant is an opaque bearer value minted by backend dispatch code for one
 * dispatched turn. It binds {owner, providerSessionId?, turnId, verbs,
 * revocationGeneration, expiresAt ≤ 24 h}. Only its SHA-256 digest and the
 * binding are persisted; the signature uses this module's own secret and
 * signing domain (`orkestrator-artifact-grant:v1`), never the workflow-result
 * secret, so neither authority can stand in for the other.
 *
 * Grants are revoked when their turn settles or aborts, and all of an
 * environment's grants by bumping its revocation generation. A fresh grant for
 * the same owner may read or retry earlier operations: authority is the
 * owner, not the grant.
 *
 * Redaction: grant values never appear in results, diagnostics, logs or
 * projections. Callers pass them only as the `scopeCapability` tool argument
 * (excluded from request digests) or inside trusted dispatch instructions.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import { ARTIFACT_TOOL_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { ArtifactOwner } from "@orkestrator/protocol/transcript-artifacts";
import type { StorageDatabase } from "../storage-database.js";
import { sha256Hex } from "./hashing.js";
import {
  TRANSCRIPT_ARTIFACT_AUTHORITY_STORE,
  TRANSCRIPT_ARTIFACT_GRANTS_STORE,
} from "./store-layout.js";

export const ARTIFACT_GRANT_VERBS = [
  "create",
  "update",
  "preview",
  "publish",
  "read",
  "cancel",
] as const;
export type ArtifactGrantVerb = (typeof ARTIFACT_GRANT_VERBS)[number];

const SIGNING_DOMAIN = "orkestrator-artifact-grant:v1";
const TOKEN_PREFIX = "oag1";
const TOKEN = /^oag1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const GENERATION_KEY_PREFIX = "generation/";
const MAX_TURN_ID = 256;

export interface ArtifactGrantBinding {
  owner: ArtifactOwner;
  providerSessionId?: string;
  turnId: string;
  verbs: ArtifactGrantVerb[];
  revocationGeneration: number;
  issuedAt: string;
  expiresAt: string;
}

interface StoredGrant extends ArtifactGrantBinding {
  schemaVersion: 1;
  grantId: string;
  digest: string;
  revokedAt?: string;
}

interface AuthorityIdentity {
  version: 1;
  secret: string;
}

export interface MintArtifactGrantInput {
  /** Owner without `backendId`; the backend fills its own identity. */
  environmentId: string;
  projectId: string;
  /** Durable conversation key (native logical session key). */
  conversationKey: string;
  turnId: string;
  providerSessionId?: string;
  verbs?: readonly ArtifactGrantVerb[];
  /** Clamped to 24 hours. */
  ttlMs?: number;
}

export interface MintedArtifactGrant {
  /** Opaque bearer value. Never log it. */
  grant: string;
  grantId: string;
  expiresAt: string;
}

export class ArtifactGrantService {
  private identity: AuthorityIdentity | null = null;

  constructor(
    private readonly database: () => StorageDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  private backendId(): string {
    return this.database().instanceId;
  }

  /** Loads or creates this authority's own signing secret (one transaction). */
  private secret(): string {
    if (this.identity) return this.identity.secret;
    const database = this.database();
    this.identity = database.transaction(() => {
      const stored = database.readStoreValueInTransaction(TRANSCRIPT_ARTIFACT_AUTHORITY_STORE)
        ?.value as Partial<AuthorityIdentity> | undefined;
      if (
        stored?.version === 1 &&
        typeof stored.secret === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(stored.secret)
      ) {
        return stored as AuthorityIdentity;
      }
      const identity: AuthorityIdentity = {
        version: 1,
        secret: randomBytes(32).toString("base64url"),
      };
      database.writeStoreInTransaction(TRANSCRIPT_ARTIFACT_AUTHORITY_STORE, identity);
      return identity;
    });
    return this.identity.secret;
  }

  private sign(grantId: string, binding: ArtifactGrantBinding): string {
    return createHmac("sha256", this.secret())
      .update(`${SIGNING_DOMAIN}\0${grantId}\0${canonicalJson(binding)}`)
      .digest("base64url");
  }

  private generation(environmentId: string): number {
    const raw = this.database()
      .rows(TRANSCRIPT_ARTIFACT_GRANTS_STORE)
      .get(`${GENERATION_KEY_PREFIX}${environmentId}`);
    const parsed = raw === undefined ? 0 : Number(JSON.parse(raw));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
  }

  mint(input: MintArtifactGrantInput): MintedArtifactGrant {
    if (!input.turnId || input.turnId.length > MAX_TURN_ID)
      throw new Error("A turn id is required");
    if (!input.environmentId || !input.projectId || !input.conversationKey) {
      throw new Error("Artifact grant owner is incomplete");
    }
    const ttl = Math.max(
      1_000,
      Math.min(
        input.ttlMs ?? ARTIFACT_TOOL_POLICY.scopeCapabilityTtlMs,
        ARTIFACT_TOOL_POLICY.scopeCapabilityTtlMs,
      ),
    );
    const verbs = Array.from(new Set(input.verbs ?? ARTIFACT_GRANT_VERBS))
      .filter((verb) => (ARTIFACT_GRANT_VERBS as readonly string[]).includes(verb))
      .sort();
    const grantId = randomBytes(16).toString("base64url");
    const now = this.now();
    const binding: ArtifactGrantBinding = {
      owner: {
        backendId: this.backendId(),
        environmentId: input.environmentId,
        projectId: input.projectId,
        conversationKey: input.conversationKey,
      },
      ...(input.providerSessionId
        ? { providerSessionId: input.providerSessionId.slice(0, 256) }
        : {}),
      turnId: input.turnId,
      verbs,
      revocationGeneration: this.generation(input.environmentId),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    const grant = `${TOKEN_PREFIX}.${grantId}.${this.sign(grantId, binding)}`;
    const record: StoredGrant = { schemaVersion: 1, grantId, digest: sha256Hex(grant), ...binding };
    const database = this.database();
    database.transaction(() => {
      database.rows(TRANSCRIPT_ARTIFACT_GRANTS_STORE).put(grantId, JSON.stringify(record));
    });
    return { grant, grantId, expiresAt: binding.expiresAt };
  }

  /**
   * Verifies a presented grant against its persisted binding. Returns null for
   * anything forged, expired, revoked, from another backend, or lacking the verb.
   */
  verify(
    token: string,
    scope: { environmentId: string; projectId: string },
    verb: ArtifactGrantVerb,
  ): ArtifactGrantBinding | null {
    const match = TOKEN.exec(token);
    if (!match) return null;
    const grantId = match[1]!;
    const signature = match[2]!;
    const raw = this.database().rows(TRANSCRIPT_ARTIFACT_GRANTS_STORE).get(grantId);
    if (raw === undefined) return null;
    let record: StoredGrant;
    try {
      record = JSON.parse(raw) as StoredGrant;
    } catch {
      return null;
    }
    if (record.schemaVersion !== 1 || record.grantId !== grantId) return null;
    const binding: ArtifactGrantBinding = {
      owner: record.owner,
      ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
      turnId: record.turnId,
      verbs: record.verbs,
      revocationGeneration: record.revocationGeneration,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    };
    const expected = Buffer.from(this.sign(grantId, binding));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const digest = Buffer.from(sha256Hex(token));
    const stored = Buffer.from(String(record.digest));
    if (digest.length !== stored.length || !timingSafeEqual(digest, stored)) return null;
    if (record.revokedAt) return null;
    if (Date.parse(record.expiresAt) <= this.now()) return null;
    if (record.owner.backendId !== this.backendId()) return null;
    if (
      record.owner.environmentId !== scope.environmentId ||
      record.owner.projectId !== scope.projectId
    ) {
      return null;
    }
    if (record.revocationGeneration !== this.generation(scope.environmentId)) return null;
    if (!record.verbs.includes(verb)) return null;
    return binding;
  }

  /**
   * The environment and project a presented grant is bound to, when it
   * verifies (same checks as {@link verify}, for the `read` verb every grant
   * carries). Used to authenticate the artifact-only MCP connection, whose
   * bearer token is the turn's grant; each tool call is then authorized
   * against the grant again with its own verb.
   */
  bearerScope(token: string): { environmentId: string; projectId: string } | null {
    const match = TOKEN.exec(token);
    if (!match) return null;
    const raw = this.database().rows(TRANSCRIPT_ARTIFACT_GRANTS_STORE).get(match[1]!);
    if (raw === undefined) return null;
    let owner: Partial<ArtifactOwner> | undefined;
    try {
      owner = (JSON.parse(raw) as Partial<StoredGrant>).owner;
    } catch {
      return null;
    }
    if (typeof owner?.environmentId !== "string" || typeof owner.projectId !== "string") {
      return null;
    }
    const scope = { environmentId: owner.environmentId, projectId: owner.projectId };
    return this.verify(token, scope, "read") ? scope : null;
  }

  /** Revoke every grant of one dispatched turn (turn settlement or abort). */
  revokeForTurn(environmentId: string, turnId: string): number {
    const database = this.database();
    const now = new Date(this.now()).toISOString();
    return database.transaction(() => {
      const rows = database.rows(TRANSCRIPT_ARTIFACT_GRANTS_STORE);
      let revoked = 0;
      for (const entry of rows.list({ owner: environmentId })) {
        if (!entry.value) continue;
        const record = JSON.parse(entry.value) as StoredGrant;
        if (record.turnId !== turnId || record.revokedAt) continue;
        rows.put(entry.key, JSON.stringify({ ...record, revokedAt: now }));
        revoked += 1;
      }
      return revoked;
    });
  }

  /** Revoke every grant bound to one conversation (explicit conversation deletion). */
  revokeConversation(environmentId: string, conversationKey: string): number {
    const database = this.database();
    const now = new Date(this.now()).toISOString();
    return database.transaction(() => {
      const rows = database.rows(TRANSCRIPT_ARTIFACT_GRANTS_STORE);
      let revoked = 0;
      for (const entry of rows.list({ owner: environmentId })) {
        if (!entry.value) continue;
        const record = JSON.parse(entry.value) as StoredGrant;
        if (record.owner?.conversationKey !== conversationKey || record.revokedAt) continue;
        rows.put(entry.key, JSON.stringify({ ...record, revokedAt: now }));
        revoked += 1;
      }
      return revoked;
    });
  }

  /** Revoke every grant of an environment, including ones minted concurrently. */
  revokeEnvironment(environmentId: string): void {
    const database = this.database();
    database.transaction(() => {
      const rows = database.rows(TRANSCRIPT_ARTIFACT_GRANTS_STORE);
      const next = this.generation(environmentId) + 1;
      rows.deleteWhere({ owner: environmentId });
      rows.put(`${GENERATION_KEY_PREFIX}${environmentId}`, JSON.stringify(next), { owner: null });
    });
  }

  /** Drop expired or revoked rows (the generation row stays). */
  prune(): number {
    const database = this.database();
    const now = this.now();
    return database.transaction(() => {
      const rows = database.rows(TRANSCRIPT_ARTIFACT_GRANTS_STORE);
      let removed = 0;
      for (const entry of rows.list()) {
        if (entry.key.startsWith(GENERATION_KEY_PREFIX) || !entry.value) continue;
        let record: StoredGrant | null = null;
        try {
          record = JSON.parse(entry.value) as StoredGrant;
        } catch {
          record = null;
        }
        if (!record || record.revokedAt || Date.parse(record.expiresAt) <= now) {
          rows.delete(entry.key);
          removed += 1;
        }
      }
      return removed;
    });
  }
}
