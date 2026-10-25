/**
 * Renderer-facing reads behind the `transcript_artifact_*` commands.
 *
 * Every read names the conversation it is displayed in; a publication whose
 * owner is not exactly (this backend, that environment, that logical session)
 * answers `not_found`, like a missing one. Representations are served by
 * exact revision with hash re-checks, bounded, under filenames derived
 * independently of titles. HTML downloads are flagged as executable outside
 * Orkestrator. Missing or damaged bytes become an artifact-level
 * `storage_corrupt`/`missing` state, never a blank success.
 */
import { createHash, randomBytes } from "node:crypto";
import { chartToCsv } from "@orkestrator/protocol/chart-scene";
import { MERMAID_POLICY, utf8ByteLength } from "@orkestrator/protocol/rich-content-policy";
import type {
  ArtifactConversationScope,
  ArtifactLiveSessionResponse,
  ArtifactPublicationView,
  ArtifactRepresentation,
  ArtifactRepresentationRequest,
  ArtifactRepresentationResponse,
  MermaidRenderRequest,
  MermaidRenderResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  ARTIFACT_VERSIONS,
  ArtifactFailure,
  artifactError,
  safeArtifactFilename,
  type ArtifactCapture,
} from "@orkestrator/protocol/transcript-artifacts";
import { artifactSourceHash, sha256Hex } from "./hashing.js";
import { notFound } from "./owner.js";
import type { ArtifactServiceContext } from "./service-context.js";
import { ArtifactPrinting } from "./service-print.js";
import { sliceUtf8, sourceText } from "./service-read.js";
import { storageCorrupt, type EnvironmentRecords } from "./store.js";
import type { StoredPublication, StoredReceipt, StoredRevision } from "./store-records.js";

const MAX_TEXT_REPRESENTATION_BYTES = 4 * 1024 * 1024;
const DEFAULT_TEXT_REPRESENTATION_BYTES = 1024 * 1024;
const MERMAID_CACHE_ENTRIES = 64;

interface Located {
  records: EnvironmentRecords;
  publication: StoredPublication;
  revision: StoredRevision;
  receipt: StoredReceipt;
}

function evidenceOutputs(receipt: StoredReceipt): Array<{ sha256: string; byteLength: number }> {
  const evidence = receipt.evidence;
  switch (evidence.kind) {
    case "html-static":
    case "html-interactive":
      return [...evidence.captures];
    case "mermaid":
    case "chart":
      return [evidence.rendererOutput, ...(evidence.captures ?? [])];
    case "workflow-snapshot":
      return [];
  }
}

export class ArtifactUiReads {
  private readonly mermaidCache = new Map<string, MermaidRenderResponse>();
  private readonly mermaidInFlight = new Map<string, Promise<MermaidRenderResponse>>();
  private readonly liveSessions = new Map<string, string>();

  constructor(
    private readonly ctx: ArtifactServiceContext,
    /** PDF printing of HTML publications (on demand, stored per print profile). */
    readonly printing: ArtifactPrinting = new ArtifactPrinting(ctx),
  ) {}

  private locate(scope: ArtifactConversationScope, publicationId: unknown): Located {
    if (
      typeof publicationId !== "string" ||
      typeof scope.environmentId !== "string" ||
      typeof scope.logicalSessionKey !== "string"
    ) {
      throw notFound("Publication");
    }
    const records = this.ctx.store.records(scope.environmentId);
    const publication = records.get("publication", publicationId);
    if (
      !publication ||
      publication.owner.backendId !== this.ctx.backendId() ||
      publication.owner.environmentId !== scope.environmentId ||
      publication.owner.conversationKey !== scope.logicalSessionKey
    ) {
      throw notFound("Publication");
    }
    const revision = records.get("revision", `${publication.artifactId}/${publication.revision}`);
    const receipt = records.get("receipt", publication.receiptId);
    if (!revision || !receipt) throw storageCorrupt();
    return { records, publication, revision, receipt };
  }

  private availability(located: Located, verify: false): ArtifactPublicationView["availability"];
  private availability(
    located: Located,
    verify: true,
  ): Promise<ArtifactPublicationView["availability"]>;
  private availability(
    located: Located,
    verify: boolean,
  ): ArtifactPublicationView["availability"] | Promise<ArtifactPublicationView["availability"]> {
    const environmentId = located.publication.owner.environmentId;
    const files = [...evidenceOutputs(located.receipt), ...located.revision.assets];
    const effective = this.effectiveAsset(located);
    if (effective) files.push(effective);
    if (!verify) {
      return files.every((file) =>
        this.ctx.store.assetFileExists(environmentId, file.sha256, file.byteLength),
      )
        ? "available"
        : "missing";
    }
    return (async () => {
      if (
        artifactSourceHash(located.revision.payload.kind, located.revision.payload) !==
        located.revision.sourceHash
      ) {
        return "storage_corrupt";
      }
      for (const file of files) {
        if (!this.ctx.store.assetFileExists(environmentId, file.sha256, file.byteLength))
          return "missing";
        try {
          await this.ctx.store.readAsset(environmentId, file.sha256, file.byteLength);
        } catch {
          this.ctx.metrics.increment("storage_corrupt");
          return "storage_corrupt";
        }
      }
      return "available";
    })();
  }

  private effectiveAsset(located: Located): { sha256: string; byteLength: number } | null {
    const kind = located.revision.payload.kind;
    const sha = located.receipt.identity.effectiveSourceHash;
    if (kind === "html-static") {
      const row = located.records.get("asset", sha);
      return row ? { sha256: sha, byteLength: row.byteLength } : { sha256: sha, byteLength: -1 };
    }
    if (kind === "html-interactive") {
      const prepared = located.records
        .get("derived", `${located.revision.artifactId}/${located.revision.revision}`)
        ?.prepared.find((entry) => entry.documentSha256 === sha);
      return prepared
        ? { sha256: sha, byteLength: prepared.byteLength }
        : { sha256: sha, byteLength: -1 };
    }
    return null;
  }

  private view(
    located: Located,
    availability: ArtifactPublicationView["availability"],
  ): ArtifactPublicationView {
    const { publication, revision, receipt } = located;
    const evidence = receipt.evidence;
    const captures: ArtifactCapture[] =
      evidence.kind === "html-static" || evidence.kind === "html-interactive"
        ? evidence.captures
        : evidence.kind === "mermaid" || evidence.kind === "chart"
          ? (evidence.captures ?? [])
          : [];
    return {
      ref: publication.ref,
      publishedAt: publication.publishedAt,
      conversationSequence: publication.conversationSequence,
      kind: publication.ref.kind,
      receipt: {
        receiptId: receipt.receiptId,
        completedAt: receipt.completedAt,
        profile: receipt.profile,
        captures: captures.map((capture) => ({
          assetId: capture.assetId,
          sha256: capture.sha256,
          width: capture.width,
          height: capture.height,
          byteLength: capture.byteLength,
        })),
        ...(evidence.kind === "html-interactive"
          ? {
              probeSummary: {
                total: evidence.probeResults.length,
                passed: evidence.probeResults.filter((result) => result.status === "passed").length,
              },
            }
          : {}),
        semantics: receipt.semantics,
        ...(evidence.kind === "mermaid" || evidence.kind === "chart"
          ? {
              rendererOutput: {
                sha256: evidence.rendererOutput.sha256,
                mimeType: evidence.rendererOutput.mimeType,
                byteLength: evidence.rendererOutput.byteLength,
              },
            }
          : {}),
      },
      source: {
        sha256: revision.sourceHash,
        byteLength: utf8ByteLength(sourceText(revision.payload)),
        effectiveSha256: receipt.identity.effectiveSourceHash,
      },
      ...(revision.payload.kind === "workflow-snapshot"
        ? {
            workflow: {
              workflowId: revision.payload.snapshot.workflowId,
              runId: revision.payload.snapshot.runId,
              sourceRevision: revision.payload.snapshot.sourceRevision,
              capturedAt: revision.payload.snapshot.capturedAt,
            },
          }
        : {}),
      ...(publication.anchor && (publication.anchor.turnId || publication.anchor.toolCallId)
        ? {
            anchor: {
              ...(publication.anchor.turnId ? { turnId: publication.anchor.turnId } : {}),
              ...(publication.anchor.toolCallId
                ? { toolCallId: publication.anchor.toolCallId }
                : {}),
            },
          }
        : {}),
      availability,
    };
  }

  async getPublication(
    scope: ArtifactConversationScope,
    publicationId: unknown,
  ): Promise<ArtifactPublicationView> {
    const located = this.locate(scope, publicationId);
    return this.view(located, await this.availability(located, true));
  }

  listPublications(
    scope: ArtifactConversationScope,
    options: { afterSequence?: unknown; limit?: unknown },
  ): { publications: ArtifactPublicationView[]; nextSequence: number | null } {
    const after =
      typeof options.afterSequence === "number" && Number.isSafeInteger(options.afterSequence)
        ? options.afterSequence
        : 0;
    const limit =
      typeof options.limit === "number" && Number.isSafeInteger(options.limit)
        ? Math.max(1, Math.min(200, options.limit))
        : 100;
    if (typeof scope.environmentId !== "string" || typeof scope.logicalSessionKey !== "string") {
      return { publications: [], nextSequence: null };
    }
    let records: EnvironmentRecords;
    try {
      records = this.ctx.store.records(scope.environmentId);
    } catch {
      throw new ArtifactFailure(
        artifactError("storage_unavailable", "The publication ledger is unavailable"),
      );
    }
    const all = records
      .list("publication", { owner: scope.logicalSessionKey })
      .filter(
        (publication) =>
          publication.owner.backendId === this.ctx.backendId() &&
          publication.owner.environmentId === scope.environmentId &&
          publication.owner.conversationKey === scope.logicalSessionKey &&
          publication.conversationSequence > after,
      )
      .sort((a, b) => a.conversationSequence - b.conversationSequence);
    const page = all.slice(0, limit);
    const publications: ArtifactPublicationView[] = [];
    for (const publication of page) {
      try {
        const located = this.locate(scope, publication.publicationId);
        publications.push(this.view(located, this.availability(located, false)));
      } catch {
        // A damaged record is skipped here; get_publication reports it.
      }
    }
    return {
      publications,
      nextSequence:
        all.length > limit ? (page[page.length - 1]?.conversationSequence ?? null) : null,
    };
  }

  async readRepresentation(
    request: ArtifactRepresentationRequest,
  ): Promise<ArtifactRepresentationResponse> {
    const located = this.locate(request, request.publicationId);
    const { revision, receipt, publication } = located;
    const environmentId = publication.owner.environmentId;
    const payload = revision.payload;
    const representation = request.representation as ArtifactRepresentation;
    const html = payload.kind === "html-static" || payload.kind === "html-interactive";
    const base = {
      artifactId: publication.artifactId,
      revision: publication.revision,
      representation,
    };
    const text = (
      content: string,
      mimeType: string,
      extension: string,
      executable = false,
    ): ArtifactRepresentationResponse => {
      const bytes = new TextEncoder().encode(content);
      const limit = Math.min(
        MAX_TEXT_REPRESENTATION_BYTES,
        Math.max(1, request.sourceRange?.limitBytes ?? DEFAULT_TEXT_REPRESENTATION_BYTES),
      );
      const slice = sliceUtf8(bytes, request.sourceRange?.offsetBytes ?? 0, limit);
      return {
        ...base,
        mimeType,
        filename: safeArtifactFilename(revision.title, extension),
        encoding: "utf8",
        data: slice.text,
        sha256: sha256Hex(bytes),
        byteLength: slice.byteLength,
        totalBytes: slice.totalBytes,
        nextOffsetBytes: slice.nextOffsetBytes,
        executableOutsideOrkestrator: executable,
      };
    };
    const assetText = async (
      sha256: string,
      byteLength: number,
      mimeType: string,
      extension: string,
      executable: boolean,
    ) => {
      const bytes = await this.ctx.store.readAsset(environmentId, sha256, byteLength);
      return text(bytes.toString("utf8"), mimeType, extension, executable);
    };
    const unsupported = () =>
      new ArtifactFailure(
        artifactError(
          "invalid_input",
          `Representation ${String(representation).slice(0, 40)} is not available for this artifact`,
        ),
      );
    switch (representation) {
      case "source": {
        if (artifactSourceHash(payload.kind, payload) !== revision.sourceHash)
          throw storageCorrupt();
        const extension = html ? "html" : payload.kind === "mermaid" ? "mmd" : "json";
        const mimeType = html
          ? "text/html; charset=utf-8"
          : payload.kind === "mermaid"
            ? "text/plain; charset=utf-8"
            : "application/json";
        return text(sourceText(payload), mimeType, extension, html);
      }
      case "effective-html": {
        if (payload.kind !== "html-static") throw unsupported();
        const asset = this.effectiveAsset(located);
        if (!asset || asset.byteLength < 0) throw storageCorrupt();
        return assetText(asset.sha256, asset.byteLength, "text/html; charset=utf-8", "html", true);
      }
      case "prepared-html": {
        if (payload.kind !== "html-interactive") throw unsupported();
        const asset = this.effectiveAsset(located);
        if (!asset || asset.byteLength < 0) throw storageCorrupt();
        return assetText(asset.sha256, asset.byteLength, "text/html; charset=utf-8", "html", true);
      }
      case "rendered-svg": {
        const evidence = receipt.evidence;
        if (evidence.kind !== "mermaid" && evidence.kind !== "chart") throw unsupported();
        return assetText(
          evidence.rendererOutput.sha256,
          evidence.rendererOutput.byteLength,
          "image/svg+xml",
          "svg",
          false,
        );
      }
      case "capture": {
        const evidence = receipt.evidence;
        const captures =
          evidence.kind === "html-static" || evidence.kind === "html-interactive"
            ? evidence.captures
            : evidence.kind === "mermaid" || evidence.kind === "chart"
              ? (evidence.captures ?? [])
              : [];
        const index = request.captureIndex ?? 0;
        const capture = Number.isSafeInteger(index) && index >= 0 ? captures[index] : undefined;
        if (!capture) throw unsupported();
        const bytes = await this.ctx.store.readAsset(
          environmentId,
          capture.sha256,
          capture.byteLength,
        );
        return {
          ...base,
          mimeType: "image/png",
          filename: safeArtifactFilename(revision.title, "png"),
          encoding: "base64",
          data: bytes.toString("base64"),
          sha256: capture.sha256,
          byteLength: bytes.byteLength,
          totalBytes: bytes.byteLength,
          nextOffsetBytes: null,
          executableOutsideOrkestrator: false,
        };
      }
      case "chart-json":
        if (payload.kind !== "chart") throw unsupported();
        return text(JSON.stringify(payload.spec, null, 2), "application/json", "json");
      case "chart-csv":
        if (payload.kind !== "chart") throw unsupported();
        return text(
          chartToCsv(payload.spec, { mode: "spreadsheet-safe" }),
          "text/csv; charset=utf-8",
          "csv",
        );
      case "pdf": {
        if (!html) throw unsupported();
        return this.printing.readPdf(located, request.paper === "letter" ? "letter" : "a4");
      }
      case "workflow-json":
        if (payload.kind !== "workflow-snapshot") throw unsupported();
        return text(JSON.stringify(payload.snapshot, null, 2), "application/json", "json");
      default:
        throw unsupported();
    }
  }

  async openLiveSession(
    scope: ArtifactConversationScope,
    publicationId: unknown,
  ): Promise<ArtifactLiveSessionResponse> {
    const located = this.locate(scope, publicationId);
    const { revision, receipt, publication } = located;
    if (revision.payload.kind !== "html-interactive") {
      throw new ArtifactFailure(
        artifactError("invalid_input", "Only interactive HTML artifacts have live sessions"),
      );
    }
    if (!this.ctx.rollout().liveInteractive) {
      throw new ArtifactFailure(
        artifactError(
          "policy_denied",
          "Live interactive artifacts are disabled; the saved preview remains available",
        ),
      );
    }
    const server = this.ctx.runtime.contentServer;
    if (!server || server.origin() === null) {
      throw new ArtifactFailure(
        artifactError("renderer_unavailable", "The artifact content server is unavailable"),
      );
    }
    const prepared = located.records
      .get("derived", `${revision.artifactId}/${revision.revision}`)
      ?.prepared.find((entry) => entry.documentSha256 === receipt.identity.effectiveSourceHash);
    if (!prepared) throw storageCorrupt();
    // Never run bytes prepared under an older policy or runtime under the
    // current one: the saved preview stays available, execution does not.
    if (prepared.policyVersion !== ARTIFACT_VERSIONS.interactivePolicyVersion) {
      throw new ArtifactFailure(
        artifactError(
          "policy_denied",
          "This artifact was prepared under an interactive policy that is no longer current; the saved preview remains available",
          { retryClass: "never" },
        ),
      );
    }
    if (prepared.runtimeVersion !== ARTIFACT_VERSIONS.interactiveRuntime) {
      throw new ArtifactFailure(
        artifactError(
          "preview_stale",
          "This artifact was prepared for an older interactive runtime; the saved preview remains available",
          { retryClass: "never", currentRevision: revision.revision },
        ),
      );
    }
    const environmentId = publication.owner.environmentId;
    // Verify before minting; the server re-verifies on every load.
    await this.ctx.store.readAsset(environmentId, prepared.documentSha256, prepared.byteLength);
    let generation: string | undefined;
    const minted = server.mint({
      artifactId: revision.artifactId,
      revision: revision.revision,
      preparedSha256: prepared.documentSha256,
      contentSecurityPolicy: prepared.contentSecurityPolicy,
      load: async () =>
        this.ctx.store.readAsset(environmentId, prepared.documentSha256, prepared.byteLength),
      // Re-checked on every request the content origin serves: the owner,
      // publication and exact prepared bytes must still be current, the
      // environment not deleted, live viewing still enabled, and this live
      // session not closed or revoked. Read-only and fast.
      authorize: async () => {
        try {
          if (generation === undefined || !this.liveSessions.has(generation)) return false;
          if (!this.ctx.rollout().liveInteractive || this.ctx.store.isDeleted(environmentId)) {
            return false;
          }
          const again = this.locate(scope, publicationId);
          return (
            again.revision.artifactId === revision.artifactId &&
            again.revision.revision === revision.revision &&
            again.receipt.identity.effectiveSourceHash === prepared.documentSha256
          );
        } catch {
          return false;
        }
      },
    });
    generation = minted.generation;
    this.liveSessions.set(minted.generation, revision.artifactId);
    if (this.liveSessions.size > 256) {
      const oldest = this.liveSessions.keys().next().value;
      if (oldest !== undefined) this.liveSessions.delete(oldest);
    }
    return {
      contentUrl: minted.url,
      shellUrl: minted.shellUrl,
      expiresAt: minted.expiresAt,
      preparedSha256: prepared.documentSha256,
      artifactId: revision.artifactId,
      revision: revision.revision,
      generation: minted.generation,
      readinessNonce: prepared.readinessNonce || randomBytes(12).toString("base64url"),
    };
  }

  closeLiveSession(generation: unknown): void {
    if (typeof generation !== "string" || generation.length > 256) return;
    this.liveSessions.delete(generation);
    this.ctx.runtime.contentServer?.revoke(generation);
  }

  /** Revoke every live capability for the given artifacts (environment deletion). */
  revokeArtifacts(artifactIds: Iterable<string>): void {
    for (const artifactId of artifactIds)
      this.ctx.runtime.contentServer?.revokeArtifact(artifactId);
  }

  /**
   * Inline Markdown Mermaid rendering through the preview runner. A small LRU
   * keyed by (source hash, theme, renderer version) caches successes and
   * deterministic syntax failures; transient failures are not cached.
   */
  async renderMermaid(request: MermaidRenderRequest): Promise<MermaidRenderResponse> {
    const source = typeof request?.source === "string" ? request.source : "";
    const theme = request?.theme === "dark" ? "dark" : "light";
    if (source.length === 0 || utf8ByteLength(source) > MERMAID_POLICY.maxSourceBytes) {
      return {
        ok: false,
        error: artifactError(
          "invalid_input",
          `Mermaid source must be 1–${MERMAID_POLICY.maxSourceBytes} bytes`,
        ),
      };
    }
    const key = createHash("sha256")
      .update(`mermaid-render:v1\0${ARTIFACT_VERSIONS.mermaidRenderer}\0${theme}\0`)
      .update(source)
      .digest("hex");
    const cached = this.mermaidCache.get(key);
    if (cached) {
      this.mermaidCache.delete(key);
      this.mermaidCache.set(key, cached);
      return cached;
    }
    const inFlight = this.mermaidInFlight.get(key);
    if (inFlight) return inFlight;
    const task = this.renderMermaidUncached(source, theme, key);
    this.mermaidInFlight.set(key, task);
    try {
      return await task;
    } finally {
      this.mermaidInFlight.delete(key);
    }
  }

  private async renderMermaidUncached(
    source: string,
    theme: "light" | "dark",
    key: string,
  ): Promise<MermaidRenderResponse> {
    const runner = this.ctx.runtime.runner;
    if (!runner || !runner.status().available) {
      return {
        ok: false,
        error: artifactError(
          "renderer_unavailable",
          "Diagram rendering is unavailable on this host",
        ),
      };
    }
    let response: MermaidRenderResponse;
    try {
      const result = await runner.run(
        { kind: "mermaid", source, theme },
        {
          environmentId: "ui-mermaid",
          conversationKey: "ui-mermaid",
          operationId: `mermaid-${key.slice(0, 16)}`,
        },
        new AbortController().signal,
      );
      if (result.ok && result.kind === "mermaid") {
        response = {
          ok: true,
          svg: result.svg,
          diagramType: result.diagramType,
          rendererVersion: ARTIFACT_VERSIONS.mermaidRenderer,
          svgBytes: utf8ByteLength(result.svg),
          svgElements: result.svgElements,
          edges: result.edges,
          renderDigest: sha256Hex(result.svg),
        };
      } else if (!result.ok) {
        const location = result.diagnostics.find((entry) => entry.location)?.location;
        const match = location ? /^(\d+):(\d+)$/.exec(location) : null;
        response = {
          ok: false,
          error: {
            ...result.error,
            ...(match ? { line: Number(match[1]), column: Number(match[2]) } : {}),
          },
        };
      } else {
        response = {
          ok: false,
          error: artifactError("renderer_unavailable", "Unexpected renderer result"),
        };
      }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ArtifactFailure
            ? error.error
            : artifactError("renderer_unavailable", "Diagram rendering failed"),
      };
    }
    const deterministic =
      response.ok ||
      response.error.code === "validation_failed" ||
      response.error.code === "invalid_input" ||
      response.error.code === "policy_denied";
    if (deterministic) {
      this.mermaidCache.set(key, response);
      while (this.mermaidCache.size > MERMAID_CACHE_ENTRIES) {
        const oldest = this.mermaidCache.keys().next().value;
        if (oldest === undefined) break;
        this.mermaidCache.delete(oldest);
      }
    }
    return response;
  }
}
