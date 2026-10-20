/**
 * The `pdf` representation of published HTML artifacts.
 *
 * A PDF is produced on explicit request by the supervised preview worker
 * (same admission, deadlines, fencing and cancellation as previews: it is a
 * runner job scoped to the publication's owner conversation) from exactly the
 * bytes the revision's receipt verified, under the fixed print profile
 * (print-profile.ts). It is then stored as a content-addressed asset and
 * recorded on the revision's derived row with the receipt id, the
 * effective-document hash and the print-profile identity, so later reads
 * return the stored bytes. A static document's printed effective hash must
 * equal the receipt's; an interactive document is the stored prepared package
 * the receipt names, under the current policy and runtime only. Late results
 * for a deleted environment, conversation or publication are discarded.
 */
import { randomBytes } from "node:crypto";

import type {
  ArtifactPrintPaper,
  ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  ARTIFACT_VERSIONS,
  ArtifactFailure,
  artifactError,
  safeArtifactFilename,
} from "@orkestrator/protocol/transcript-artifacts";

import type { PreviewJob } from "./contracts.js";
import { logArtifactEvent } from "./metrics.js";
import {
  ARTIFACT_PRINT_PROFILE_VERSION,
  artifactPrintProfile,
  printProfileIdentity,
} from "./print-profile.js";
import type { ArtifactServiceContext } from "./service-context.js";
import { storageCorrupt, type EnvironmentRecords } from "./store.js";
import type {
  PrintedPdfRef,
  StoredDerived,
  StoredPublication,
  StoredReceipt,
  StoredRevision,
} from "./store-records.js";

/** Printed PDFs kept per revision (newest win); older ones become unreferenced. */
const MAX_PRINTED_PER_REVISION = 4;

export interface PrintTarget {
  records: EnvironmentRecords;
  publication: StoredPublication;
  revision: StoredRevision;
  receipt: StoredReceipt;
}

/** The publication still exists for the same owner, revision and receipt. */
function stillCurrent(target: PrintTarget, records: EnvironmentRecords): boolean {
  const publication = records.get("publication", target.publication.publicationId);
  return (
    publication !== null &&
    publication.owner.conversationKey === target.publication.owner.conversationKey &&
    publication.owner.backendId === target.publication.owner.backendId &&
    publication.artifactId === target.publication.artifactId &&
    publication.revision === target.publication.revision &&
    publication.receiptId === target.receipt.receiptId
  );
}

interface Running {
  environmentId: string;
  conversationKey: string;
  controller: AbortController;
}

export class ArtifactPrinting {
  private readonly inFlight = new Map<string, Promise<ArtifactRepresentationResponse>>();
  private readonly running = new Map<string, Running>();

  constructor(private readonly ctx: ArtifactServiceContext) {}

  readPdf(target: PrintTarget, paper: ArtifactPrintPaper): Promise<ArtifactRepresentationResponse> {
    const kind = target.revision.payload.kind;
    if (kind !== "html-static" && kind !== "html-interactive") {
      return Promise.reject(
        new ArtifactFailure(
          artifactError("invalid_input", "A PDF is only available for HTML artifacts"),
        ),
      );
    }
    if (!target.receipt.profile) return Promise.reject(storageCorrupt());
    const print = artifactPrintProfile(paper, target.receipt.profile);
    const profileHash = printProfileIdentity(print);
    const stored = this.storedPdf(target, profileHash);
    if (stored) return this.respond(target, stored);
    const environmentId = target.publication.owner.environmentId;
    const key = `${environmentId}\0${target.publication.publicationId}\0${profileHash}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = this.print(target, paper, profileHash).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  /** Cancels running print jobs: a whole environment, one conversation, or everything. */
  abort(filter: { environmentId?: string; conversationKey?: string } = {}): void {
    for (const job of this.running.values()) {
      if (filter.environmentId !== undefined && job.environmentId !== filter.environmentId)
        continue;
      if (filter.conversationKey !== undefined && job.conversationKey !== filter.conversationKey)
        continue;
      job.controller.abort();
    }
  }

  private storedPdf(target: PrintTarget, profileHash: string): PrintedPdfRef | null {
    const derived = target.records.get(
      "derived",
      `${target.revision.artifactId}/${target.revision.revision}`,
    );
    const entry = derived?.printed?.find(
      (candidate) =>
        candidate.receiptId === target.receipt.receiptId &&
        candidate.printProfileHash === profileHash &&
        candidate.effectiveSourceHash === target.receipt.identity.effectiveSourceHash,
    );
    if (!entry) return null;
    // Collected or damaged bytes are printed again rather than reported missing.
    return this.ctx.store.assetFileExists(
      target.publication.owner.environmentId,
      entry.sha256,
      entry.byteLength,
    )
      ? entry
      : null;
  }

  private async respond(
    target: PrintTarget,
    entry: PrintedPdfRef,
  ): Promise<ArtifactRepresentationResponse> {
    const bytes = await this.ctx.store.readAsset(
      target.publication.owner.environmentId,
      entry.sha256,
      entry.byteLength,
    );
    return {
      artifactId: target.publication.artifactId,
      revision: target.publication.revision,
      representation: "pdf",
      mimeType: "application/pdf",
      filename: safeArtifactFilename(target.revision.title, "pdf"),
      encoding: "base64",
      data: bytes.toString("base64"),
      sha256: entry.sha256,
      byteLength: bytes.byteLength,
      totalBytes: bytes.byteLength,
      nextOffsetBytes: null,
      executableOutsideOrkestrator: false,
      print: {
        profileVersion: entry.printProfileVersion,
        profileHash: entry.printProfileHash,
        paper: entry.paper,
        pageCount: entry.pageCount,
        receiptId: entry.receiptId,
      },
    };
  }

  private async documentFor(target: PrintTarget): Promise<PreviewJob & { kind: "html-print" }> {
    const { revision, receipt } = target;
    const payload = revision.payload;
    const print = artifactPrintProfile("a4", receipt.profile!);
    if (payload.kind === "html-static") {
      const effective = target.records.get("asset", receipt.identity.effectiveSourceHash);
      if (!effective) throw storageCorrupt();
      const html = (
        await this.ctx.store.readAsset(
          target.publication.owner.environmentId,
          effective.sha256,
          effective.byteLength,
        )
      ).toString("utf8");
      return {
        kind: "html-print",
        print,
        profile: receipt.profile!,
        document: { type: "static", html },
      };
    }
    const prepared = target.records
      .get("derived", `${revision.artifactId}/${revision.revision}`)
      ?.prepared.find((entry) => entry.documentSha256 === receipt.identity.effectiveSourceHash);
    if (!prepared) throw storageCorrupt();
    // Old bytes never run under a newer policy or runtime (as for live sessions).
    if (prepared.policyVersion !== ARTIFACT_VERSIONS.interactivePolicyVersion)
      throw new ArtifactFailure(
        artifactError(
          "policy_denied",
          "This artifact was prepared under an interactive policy that is no longer current; print the saved preview instead",
          { retryClass: "never" },
        ),
      );
    if (prepared.runtimeVersion !== ARTIFACT_VERSIONS.interactiveRuntime)
      throw new ArtifactFailure(
        artifactError(
          "preview_stale",
          "This artifact was prepared for an older interactive runtime; print the saved preview instead",
          { retryClass: "never", currentRevision: revision.revision },
        ),
      );
    const bytes = await this.ctx.store.readAsset(
      target.publication.owner.environmentId,
      prepared.documentSha256,
      prepared.byteLength,
    );
    return {
      kind: "html-print",
      print,
      profile: receipt.profile!,
      document: {
        type: "interactive",
        preparedDocument: bytes.toString("utf8"),
        contentSecurityPolicy: prepared.contentSecurityPolicy,
        ...(prepared.readinessNonce ? { readinessNonce: prepared.readinessNonce } : {}),
        identity: { artifactId: revision.artifactId, revision: revision.revision },
      },
    };
  }

  private async print(
    target: PrintTarget,
    paper: ArtifactPrintPaper,
    profileHash: string,
  ): Promise<ArtifactRepresentationResponse> {
    const runner = this.ctx.runtime.runner;
    if (!runner || !runner.status().available) {
      throw new ArtifactFailure(
        artifactError(
          "renderer_unavailable",
          "PDF printing needs the isolated preview worker, which is unavailable on this host; print the saved preview instead",
        ),
      );
    }
    const { publication, receipt } = target;
    const environmentId = publication.owner.environmentId;
    const conversationKey = publication.owner.conversationKey;
    const job = await this.documentFor(target);
    job.print = artifactPrintProfile(paper, receipt.profile!);
    const operationId = `op_print_${randomBytes(12).toString("hex")}`;
    const controller = new AbortController();
    this.running.set(operationId, { environmentId, conversationKey, controller });
    const started = this.ctx.now();
    let result;
    try {
      result = await runner.run(
        job,
        { environmentId, conversationKey, operationId },
        controller.signal,
      );
    } finally {
      this.running.delete(operationId);
    }
    if (!result.ok) {
      logArtifactEvent("pdf-print-failed", {
        environmentId,
        operation: operationId,
        code: result.error.code,
        resource: result.error.resource,
      });
      throw new ArtifactFailure(result.error);
    }
    if (result.kind !== "html-print")
      throw new ArtifactFailure(
        artifactError("renderer_unavailable", "The renderer returned the wrong result kind"),
      );
    if (
      job.document.type === "static" &&
      result.effectiveHtmlSha256 !== receipt.identity.effectiveSourceHash
    ) {
      this.ctx.metrics.increment("receipt_mismatches", { kind: "html-print" });
      throw new ArtifactFailure(
        artifactError(
          "preview_stale",
          "The document printed differs from the verified revision; print the saved preview instead",
          { retryClass: "never", currentRevision: target.revision.revision },
        ),
      );
    }
    // Fencing: nothing is stored for a deleted environment or a publication
    // this reader can no longer see.
    if (
      this.ctx.store.isDeleted(environmentId) ||
      !stillCurrent(target, this.ctx.store.records(environmentId))
    ) {
      this.ctx.metrics.increment("late_completions_discarded", { kind: "html-print" });
      throw new ArtifactFailure(artifactError("not_found", "Publication not found"));
    }
    const written = await this.ctx.store.writeAsset(environmentId, result.pdf);
    const entry: PrintedPdfRef = {
      receiptId: receipt.receiptId,
      effectiveSourceHash: receipt.identity.effectiveSourceHash,
      printProfileHash: profileHash,
      printProfileVersion: ARTIFACT_PRINT_PROFILE_VERSION,
      paper,
      sha256: written.sha256,
      byteLength: written.byteLength,
      pageCount: result.pageCount,
      browserBuild: result.browserBuild,
      rendererBundleHash: result.rendererBundleHash,
      createdAt: this.ctx.iso(),
    };
    try {
      this.ctx.store.transact(environmentId, (records) => {
        if (!stillCurrent(target, records))
          throw new ArtifactFailure(artifactError("not_found", "Publication not found"));
        this.ctx.store.registerAssetsInTransaction(
          records,
          [{ sha256: written.sha256, byteLength: written.byteLength, mimeType: "application/pdf" }],
          entry.createdAt,
        );
        const key = `${target.revision.artifactId}/${target.revision.revision}`;
        const existing: StoredDerived = records.get("derived", key) ?? {
          schemaVersion: 1,
          artifactId: target.revision.artifactId,
          revision: target.revision.revision,
          prepared: [],
        };
        const printed = (existing.printed ?? []).filter(
          (candidate) =>
            !(
              candidate.receiptId === entry.receiptId &&
              candidate.printProfileHash === entry.printProfileHash
            ),
        );
        records.put("derived", key, {
          ...existing,
          printed: [...printed, entry].slice(-MAX_PRINTED_PER_REVISION),
        });
      });
    } finally {
      written.release();
    }
    logArtifactEvent("pdf-printed", {
      environmentId,
      operation: operationId,
      pages: entry.pageCount,
      bytes: entry.byteLength,
      ms: this.ctx.now() - started,
    });
    return this.respond(target, entry);
  }
}
