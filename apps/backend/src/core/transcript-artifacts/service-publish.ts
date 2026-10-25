/**
 * publish_artifact: turn an exact, verified revision into an immutable
 * transcript publication.
 *
 * The receipt is loaded by id and must belong to the caller, name exactly the
 * artifact and `expectedRevision`, carry every required gate, match the
 * immutable revision's source and asset manifest, match current
 * renderer/policy/profile versions, the current renderer bundle of its kind
 * (the runner's `rendererBundleHashes`; the versioned chart renderer), the
 * current browser build (HTML always; Mermaid when a browser is known) and,
 * for interactive HTML, the dependency manifest; its evidence bytes must
 * still verify. The head
 * must still be `expectedRevision` inside the commit transaction. A
 * publication is unique per (owner, artifact, revision); a second call with a
 * different request key returns the same canonical publication. Its
 * conversation sequence is allocated in the same transaction, together with
 * an outbox event; subscribers are told only after commit.
 */
import {
  ArtifactFailure,
  REQUIRED_ARTIFACT_GATES,
  artifactError,
  type TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import { validateWorkflowSnapshot } from "@orkestrator/protocol/workflow-snapshot";
import { snapshotHash } from "./hashing.js";
import { notFound, ownsRecord, type ResolvedArtifactCaller } from "./owner.js";
import {
  assertConversationLive,
  errorResponse,
  isRecordableError,
  newId,
  okResponse,
  priorRequest,
  recordRequest,
  replayed,
  requestIdentity,
  toArtifactError,
  type ArtifactResponse,
  type ArtifactServiceContext,
  type RequestIdentity,
} from "./service-context.js";
import {
  CHART_RENDERER_BUNDLE_HASH,
  identityInputHash,
  staleIdentityFields,
} from "./service-identity.js";
import type {
  StoredDerived,
  StoredPublication,
  StoredReceipt,
  StoredRevision,
} from "./store-records.js";

export class ArtifactPublisher {
  constructor(private readonly ctx: ArtifactServiceContext) {}

  async publish(
    caller: ResolvedArtifactCaller,
    args: {
      requestKey: unknown;
      artifactId: unknown;
      expectedRevision: unknown;
      receiptId: unknown;
    },
    anchor: { toolCallId?: string } = {},
  ): Promise<ArtifactResponse> {
    const environmentId = caller.owner.environmentId;
    let request: RequestIdentity;
    try {
      request = requestIdentity(caller.owner, "publish", args.requestKey, {
        artifactId: args.artifactId ?? null,
        expectedRevision: args.expectedRevision ?? null,
        receiptId: args.receiptId ?? null,
      });
      const prior = priorRequest(this.ctx.store.records(environmentId), request);
      if (prior) return replayed(prior);
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
    let published: { response: ArtifactResponse; created?: StoredPublication } | null = null;
    try {
      if (!this.ctx.rollout().artifactPublication) {
        throw new ArtifactFailure(
          artifactError("policy_denied", "Artifact publication is disabled on this backend", {
            retryClass: "never",
          }),
        );
      }
      if (typeof args.artifactId !== "string") throw notFound();
      if (typeof args.receiptId !== "string") throw notFound("Receipt");
      const artifactId = args.artifactId;
      const receiptId = args.receiptId;
      const expectedRevision = args.expectedRevision;
      if (
        typeof expectedRevision !== "number" ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1
      ) {
        throw new ArtifactFailure(
          artifactError("invalid_input", "expectedRevision must be a positive integer", {
            fieldErrors: [
              { path: "expectedRevision", code: "type", message: "Expected a positive integer" },
            ],
          }),
        );
      }
      const records = this.ctx.store.records(environmentId);
      const head = records.get("head", artifactId);
      if (!head || !ownsRecord(caller.owner, head)) throw notFound();
      const existingId = records.publicationKey(artifactId, expectedRevision);
      if (!existingId) {
        const revision = records.get("revision", `${artifactId}/${expectedRevision}`);
        if (!revision) throw notFound("Artifact revision");
        if (head.currentRevision !== expectedRevision) throw this.conflict(head.currentRevision);
        const receipt = records.get("receipt", receiptId);
        if (!receipt || !ownsRecord(caller.owner, receipt)) throw notFound("Receipt");
        await this.verifyReceipt(
          environmentId,
          receipt,
          revision,
          records.get("derived", `${artifactId}/${expectedRevision}`),
        );
      }
      published = this.ctx.store.transact(environmentId, (tx) => {
        assertConversationLive(tx, caller.owner.conversationKey);
        const again = priorRequest(tx, request);
        if (again) return { response: replayed(again) };
        const now = this.ctx.iso();
        const canonicalId = tx.publicationKey(artifactId, expectedRevision);
        if (canonicalId) {
          const canonical = tx.get("publication", canonicalId);
          if (!canonical || !ownsRecord(caller.owner, canonical)) throw notFound();
          const response = okResponse(publicationSummary(canonical));
          recordRequest(tx, request, response, now, artifactId);
          return { response };
        }
        const latest = tx.get("head", artifactId);
        if (!latest || !ownsRecord(caller.owner, latest)) throw notFound();
        if (latest.currentRevision !== expectedRevision)
          throw this.conflict(latest.currentRevision);
        const revision = tx.get("revision", `${artifactId}/${expectedRevision}`);
        const receipt = tx.get("receipt", receiptId);
        if (!revision || !receipt || !ownsRecord(caller.owner, receipt)) throw notFound("Receipt");
        this.checkReceiptShape(receipt, revision);
        const conversation = tx.get("conversation", caller.owner.conversationKey) ?? {
          schemaVersion: 1 as const,
          conversationKey: caller.owner.conversationKey,
          sequence: 0,
        };
        const sequence = conversation.sequence + 1;
        const publicationId = newId("pub");
        const ref: TranscriptArtifactRef = {
          schemaVersion: 1,
          artifactId,
          revision: expectedRevision,
          publicationId,
          kind: revision.payload.kind,
          title: revision.title,
          summary: revision.summary,
          provenance: { backendId: caller.owner.backendId, origin: revision.createdBy.origin },
        };
        const publication: StoredPublication = {
          schemaVersion: 1,
          publicationId,
          artifactId,
          revision: expectedRevision,
          receiptId,
          owner: caller.owner,
          conversationSequence: sequence,
          publishedAt: now,
          ...(caller.turnId || anchor.toolCallId
            ? {
                anchor: {
                  ...(caller.turnId ? { turnId: caller.turnId } : {}),
                  ...(anchor.toolCallId ? { toolCallId: anchor.toolCallId } : {}),
                },
              }
            : {}),
          ref,
        };
        tx.put("publication", publicationId, publication, caller.owner.conversationKey);
        tx.putPublicationKey(artifactId, expectedRevision, publicationId);
        tx.put("conversation", caller.owner.conversationKey, { ...conversation, sequence });
        tx.put(
          "head",
          artifactId,
          { ...latest, publishedRevision: expectedRevision, updatedAt: now },
          caller.owner.conversationKey,
        );
        tx.put("outbox", publicationId, {
          schemaVersion: 1,
          eventId: publicationId,
          kind: "publication",
          publicationId,
          conversationKey: caller.owner.conversationKey,
          sequence,
          createdAt: now,
        });
        const response = okResponse(publicationSummary(publication));
        recordRequest(tx, request, response, now, artifactId);
        return { response, created: publication };
      });
    } catch (error) {
      const failure = toArtifactError(error);
      if (failure.code === "preview_stale") this.ctx.metrics.increment("receipt_mismatches");
      const response = errorResponse(failure);
      if (!isRecordableError(failure)) return response;
      try {
        return this.ctx.store.transact(environmentId, (records) => {
          const prior = priorRequest(records, request);
          if (prior) return replayed(prior);
          recordRequest(records, request, response, this.ctx.iso());
          return response;
        });
      } catch {
        return response;
      }
    }
    if (published.created) {
      this.ctx.metrics.increment("publications", { kind: published.created.ref.kind });
      this.ctx.notifyPublication(
        environmentId,
        caller.owner.conversationKey,
        published.created.publicationId,
        published.created.conversationSequence,
      );
    }
    return published.response;
  }

  private conflict(currentRevision: number): ArtifactFailure {
    return new ArtifactFailure(
      artifactError(
        "revision_conflict",
        `Only the current head (revision ${currentRevision}) can be published`,
        {
          currentRevision,
          suggestion: "Preview the current revision and publish it with its receipt.",
        },
      ),
    );
  }

  /** Synchronous receipt checks also repeated inside the commit transaction. */
  private checkReceiptShape(receipt: StoredReceipt, revision: StoredRevision): void {
    if (
      receipt.artifactId !== revision.artifactId ||
      receipt.revision !== revision.revision ||
      receipt.kind !== revision.payload.kind
    ) {
      throw new ArtifactFailure(
        artifactError(
          "preview_required",
          `This receipt does not verify revision ${revision.revision}`,
          {
            currentRevision: revision.revision,
            suggestion: "Preview this exact revision, then publish with the new receipt.",
          },
        ),
      );
    }
    const gates = new Set(
      receipt.gates.filter((gate) => gate.result === "passed").map((gate) => gate.gate),
    );
    const missing = REQUIRED_ARTIFACT_GATES[revision.payload.kind].filter(
      (gate) => !gates.has(gate),
    );
    if (missing.length > 0 || receipt.evidence.kind !== revision.payload.kind) {
      throw new ArtifactFailure(
        artifactError(
          "preview_required",
          "The receipt does not carry every required verification gate",
        ),
      );
    }
    if (identityInputHash(receipt.identity) !== receipt.inputHash) {
      throw this.stale(revision.revision, ["inputHash"]);
    }
  }

  private stale(revision: number, fields: string[]): ArtifactFailure {
    return new ArtifactFailure(
      artifactError(
        "preview_stale",
        `Revision ${revision} requires verification under the current render policy (${fields.slice(0, 6).join(", ")})`,
        {
          currentRevision: revision,
          suggestion: "Run preview_artifact again, then publish the new receipt.",
        },
      ),
    );
  }

  private async verifyReceipt(
    environmentId: string,
    receipt: StoredReceipt,
    revision: StoredRevision,
    derived: StoredDerived | null,
  ): Promise<void> {
    this.checkReceiptShape(receipt, revision);
    const kind = revision.payload.kind;
    const current: {
      browserBuild?: string;
      dependencyManifestHash?: string;
      rendererBundleHash?: string;
    } = {};
    const status = this.ctx.runtime.runner?.status();
    if (kind === "html-static" || kind === "html-interactive") {
      if (!status?.available) {
        throw new ArtifactFailure(
          artifactError(
            "renderer_unavailable",
            "HTML artifacts cannot be published without the headless preview runtime",
          ),
        );
      }
      current.browserBuild = status.browserBuild;
    }
    if (kind === "mermaid" && status?.available && status.browserBuild !== "unknown") {
      // The saved SVG stays valid evidence without a browser, but when one is
      // known a different build than the one that rendered it is stale.
      current.browserBuild = status.browserBuild;
    }
    if (kind === "html-static" || kind === "html-interactive" || kind === "mermaid") {
      const bundle = status?.rendererBundleHashes?.[kind];
      if (bundle) current.rendererBundleHash = bundle;
    }
    if (kind === "chart") current.rendererBundleHash = CHART_RENDERER_BUNDLE_HASH;
    if (kind === "html-interactive") {
      const preparer = this.ctx.runtime.preparer;
      if (!preparer) {
        throw new ArtifactFailure(
          artifactError("renderer_unavailable", "Interactive HTML preparation is unavailable"),
        );
      }
      // The receipt binds the dependencies this revision resolved to; re-resolve
      // them under the current manifest so a changed pinned bundle is stale.
      const payload = revision.payload as { dependencyIds?: string[] };
      current.dependencyManifestHash = preparer.dependencyManifestHash(payload.dependencyIds ?? []);
    }
    const stale = staleIdentityFields(
      receipt.identity,
      revision,
      receipt.profile,
      current,
      this.ctx.overrides,
    );
    if (stale.length > 0) throw this.stale(revision.revision, stale);

    // Evidence must still exist and verify byte-for-byte.
    const evidence = receipt.evidence;
    const outputs: Array<{ sha256: string; byteLength: number }> = [];
    switch (evidence.kind) {
      case "html-static":
      case "html-interactive":
        if (evidence.captures.length === 0)
          throw new ArtifactFailure(
            artifactError("preview_required", "HTML receipts need a capture"),
          );
        outputs.push(...evidence.captures);
        break;
      case "mermaid":
      case "chart":
        outputs.push(evidence.rendererOutput, ...(evidence.captures ?? []));
        break;
      case "workflow-snapshot": {
        if (revision.payload.kind !== "workflow-snapshot")
          throw this.stale(revision.revision, ["kind"]);
        const snapshot = revision.payload.snapshot;
        if (
          !validateWorkflowSnapshot(snapshot).ok ||
          snapshotHash(snapshot) !== evidence.sourceSnapshot.snapshotHash ||
          snapshot.runId !== evidence.sourceSnapshot.runId ||
          snapshot.sourceRevision !== evidence.sourceSnapshot.sourceRevision
        ) {
          throw this.stale(revision.revision, ["snapshotHash"]);
        }
        break;
      }
    }
    if (evidence.kind === "html-interactive" && revision.payload.kind === "html-interactive") {
      const probes = revision.payload.probes ?? [];
      const passed = probes.every(
        (_probe, index) =>
          evidence.probeResults.find((result) => result.index === index)?.status === "passed",
      );
      if (!passed || evidence.probeResults.length !== probes.length) {
        throw new ArtifactFailure(
          artifactError("preview_required", "Every declared probe must pass"),
        );
      }
    }
    const records = this.ctx.store.records(environmentId);
    if (kind === "html-static" || kind === "html-interactive") {
      const asset =
        kind === "html-interactive"
          ? derived?.prepared.find(
              (entry) => entry.documentSha256 === receipt.identity.effectiveSourceHash,
            )
          : records.get("asset", receipt.identity.effectiveSourceHash);
      if (!asset) throw this.corrupt();
      outputs.push({ sha256: receipt.identity.effectiveSourceHash, byteLength: asset.byteLength });
    }
    for (const output of outputs) {
      await this.ctx.store
        .readAsset(environmentId, output.sha256, output.byteLength)
        .catch((error: unknown) => {
          this.ctx.metrics.increment("storage_corrupt");
          throw error;
        });
    }
    for (const asset of revision.assets) {
      await this.ctx.store.readAsset(environmentId, asset.sha256, asset.byteLength);
    }
  }

  private corrupt(): ArtifactFailure {
    this.ctx.metrics.increment("storage_corrupt");
    return new ArtifactFailure(
      artifactError("storage_corrupt", "Verification evidence for this receipt is missing"),
    );
  }
}

export function publicationSummary(publication: StoredPublication): Record<string, unknown> {
  return {
    publicationId: publication.publicationId,
    artifactId: publication.artifactId,
    revision: publication.revision,
    conversationSequence: publication.conversationSequence,
    publishedAt: publication.publishedAt,
    ref: publication.ref,
  };
}
