/**
 * Phase-scoped trust in one sealed review-evidence generation.
 *
 * Every reviewer in a fan-out is sent the same immutable review package and
 * the same validation artifacts. Verifying them — reading, hashing and parsing
 * the package, then hashing every referenced log — once per reviewer made the
 * control plane's evidence I/O grow with the panel size. Instead the owner
 * verifies the exact generation once before admitting reviewers, records an
 * in-memory permit, and verifies again, independently, before consolidation.
 *
 * A permit is deliberately weak:
 *
 * - It is never persisted. After a backend restart the evidence may have been
 *   changed while nothing was watching, so the first admission re-verifies.
 * - It is scoped to one workflow, one controller token and one generation key.
 *   A controller takeover, a regenerated package or a changed snapshot is a
 *   different scope and verifies again.
 * - It is scoped to one phase. A fan-out permit never authorizes consolidation.
 * - It expires after {@link DEFAULT_EVIDENCE_PERMIT_MAX_AGE_MS} so a long,
 *   retry-heavy review still re-reads its evidence periodically.
 * - Any failed verification removes it; explicit restarts and terminal cleanup
 *   remove it too.
 *
 * The generation key is a digest of the persisted package identity (id, content
 * hash, size, commit range) and the pinned worktree fingerprint. No path, hash
 * or identifier leaves this module in a metric or error.
 */
import { createHash } from "node:crypto";

export type EvidencePermitPhase = "fanout" | "consolidation";

export const DEFAULT_EVIDENCE_PERMIT_MAX_AGE_MS = 30 * 60_000;
/** One permit per active workflow and phase; bounded well above the live set. */
const MAX_EVIDENCE_PERMITS = 256;

export interface EvidenceGenerationIdentity {
  environmentId: string;
  package: {
    id: string;
    sha256: string;
    bytes: number;
    baseRef: string;
    headRef: string;
    round?: number;
  };
  /** Content fingerprint of the pinned worktree snapshot, when one exists. */
  snapshotFingerprint?: string;
}

/**
 * Deterministic key for one sealed evidence generation. Field order is fixed;
 * nothing is sorted, so a change in any component changes the key.
 */
export function evidenceGenerationKey(identity: EvidenceGenerationIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.environmentId,
        identity.package.id,
        identity.package.sha256,
        identity.package.bytes,
        identity.package.baseRef,
        identity.package.headRef,
        identity.package.round ?? null,
        identity.snapshotFingerprint ?? null,
      ]),
    )
    .digest("hex");
}

interface Permit {
  generationKey: string;
  controllerToken: string;
  verifiedAt: number;
}

export interface EvidenceVerificationOutcome {
  /** True when an existing permit answered without reading the evidence. */
  reused: boolean;
}

export class ReviewEvidencePermits {
  private readonly permits = new Map<string, Permit>();

  constructor(
    private readonly maxAgeMs = DEFAULT_EVIDENCE_PERMIT_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Resolves once the generation is verified for `phase`, running `verify` only
   * when no live matching permit exists. A rejected `verify` leaves no permit
   * and propagates unchanged: evidence failures stay workflow-fatal.
   */
  async ensure(
    workflowId: string,
    phase: EvidencePermitPhase,
    scope: { generationKey: string; controllerToken: string },
    verify: () => Promise<void>,
  ): Promise<EvidenceVerificationOutcome> {
    const key = `${workflowId}\u0000${phase}`;
    const existing = this.permits.get(key);
    if (
      existing &&
      existing.generationKey === scope.generationKey &&
      existing.controllerToken === scope.controllerToken &&
      this.now() - existing.verifiedAt < this.maxAgeMs
    ) {
      return { reused: true };
    }
    this.permits.delete(key);
    await verify();
    if (this.permits.size >= MAX_EVIDENCE_PERMITS) {
      const oldest = this.permits.keys().next();
      if (!oldest.done) this.permits.delete(oldest.value);
    }
    this.permits.set(key, {
      generationKey: scope.generationKey,
      controllerToken: scope.controllerToken,
      verifiedAt: this.now(),
    });
    return { reused: false };
  }

  /** Drop every permit a workflow holds (restart, failure, terminal cleanup). */
  invalidate(workflowId: string): void {
    for (const phase of ["fanout", "consolidation"] as const) {
      this.permits.delete(`${workflowId}\u0000${phase}`);
    }
  }

  clear(): void {
    this.permits.clear();
  }

  get size(): number {
    return this.permits.size;
  }
}
