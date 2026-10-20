/**
 * Kind-specific verification work for one admitted operation, run outside
 * any transaction: native chart rendering, workflow snapshot re-validation,
 * and supervised preview jobs through the injected PreviewRunner (with
 * interactive preparation first). Produces an `Outcome` the executor commits
 * under its generation fence; this module never writes records.
 */
import { buildChartScene, ChartGeometryError } from "@orkestrator/protocol/chart-scene";
import { validateChartSpec } from "@orkestrator/protocol/chart-spec";
import { chartSceneToSvg } from "@orkestrator/protocol/chart-svg";
import {
  ARTIFACT_TOOL_POLICY,
  INTERACTIVE_HTML_POLICY,
  MERMAID_POLICY,
  PREVIEW_CAPTURE_POLICY,
  STATIC_HTML_POLICY,
  utf8ByteLength,
} from "@orkestrator/protocol/rich-content-policy";
import {
  ArtifactFailure,
  artifactError,
  type ArtifactCapture,
  type ArtifactDiagnostic,
  type ArtifactError,
  type ArtifactOutputRef,
  type ArtifactProbeResultV1,
  type ArtifactVerificationEvidence,
  type ArtifactVerificationGate,
} from "@orkestrator/protocol/transcript-artifacts";
import { validateWorkflowSnapshot } from "@orkestrator/protocol/workflow-snapshot";
import type { PreviewCapture, PreviewJob, PreviewJobResult } from "./contracts.js";
import { validateInteractiveAssets } from "./interactive-assets.js";
import { snapshotHash } from "./hashing.js";
import { notFound } from "./owner.js";
import { assetIdFor, type ArtifactServiceContext } from "./service-context.js";
import { CHART_RENDERER_BUNDLE_HASH, type RuntimeFacts } from "./service-identity.js";
import type { PreparedDocumentRef, StoredOperation } from "./store-records.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface StoredAssetRef {
  sha256: string;
  byteLength: number;
  mimeType: string;
}

export type Outcome =
  | {
      ok: true;
      gates: ArtifactVerificationGate[];
      evidence: ArtifactVerificationEvidence;
      facts: RuntimeFacts;
      diagnostics: ArtifactDiagnostic[];
      omitted: number;
      probeResults?: ArtifactProbeResultV1[];
      semantics: "not-assessed" | "probes-passed";
      assets: StoredAssetRef[];
      prepared?: PreparedDocumentRef;
    }
  | {
      ok: false;
      error: ArtifactError;
      diagnostics: ArtifactDiagnostic[];
      omitted: number;
      captures: ArtifactCapture[];
      probeResults?: ArtifactProbeResultV1[];
      assets: StoredAssetRef[];
      prepared?: PreparedDocumentRef;
    };

export function failure(
  error: ArtifactError,
  assets: StoredAssetRef[] = [],
): Extract<Outcome, { ok: false }> {
  return { ok: false, error, diagnostics: [], omitted: 0, captures: [], assets };
}

export class ArtifactPreviewJobs {
  constructor(private readonly ctx: ArtifactServiceContext) {}

  async perform(
    environmentId: string,
    operation: StoredOperation,
    signal: AbortSignal,
    releases: Array<() => void>,
  ): Promise<Outcome> {
    const revision = this.ctx.store
      .records(environmentId)
      .get("revision", `${operation.artifactId}/${operation.revision}`);
    if (!revision) throw notFound("Artifact revision");
    const payload = revision.payload;
    const profile = operation.profile;
    const store = async (bytes: Uint8Array, mimeType: string): Promise<ArtifactOutputRef> => {
      const written = await this.ctx.store.writeAsset(environmentId, bytes);
      releases.push(written.release);
      return {
        assetId: assetIdFor(written.sha256),
        sha256: written.sha256,
        mimeType,
        byteLength: written.byteLength,
      };
    };
    switch (payload.kind) {
      case "workflow-snapshot": {
        const validation = validateWorkflowSnapshot(payload.snapshot);
        if (!validation.ok) {
          return failure(
            artifactError("validation_failed", "The stored workflow snapshot failed validation", {
              fieldErrors: validation.errors,
            }),
          );
        }
        const snapshot = payload.snapshot;
        return {
          ok: true,
          gates: ["schema", "authoritative-source"],
          evidence: {
            kind: "workflow-snapshot",
            sourceSnapshot: {
              workflowId: snapshot.workflowId,
              runId: snapshot.runId,
              sourceRevision: snapshot.sourceRevision,
              snapshotHash: snapshotHash(snapshot),
              capturedAt: snapshot.capturedAt,
            },
          },
          facts: {},
          diagnostics: [],
          omitted: 0,
          semantics: "not-assessed",
          assets: [],
        };
      }
      case "chart": {
        const validation = validateChartSpec(payload.spec);
        if (!validation.ok) {
          return failure(
            artifactError("validation_failed", "The chart specification is invalid", {
              fieldErrors: validation.errors,
            }),
          );
        }
        let svg: string;
        try {
          const scene = buildChartScene(payload.spec, {
            width: profile?.viewport.width,
            height: profile?.viewport.height,
          });
          svg = chartSceneToSvg(scene, profile?.theme ?? "light");
        } catch (error) {
          if (error instanceof ChartGeometryError) {
            return failure(artifactError("validation_failed", error.message.slice(0, 300)));
          }
          throw error;
        }
        const bytes = new TextEncoder().encode(svg);
        if (bytes.byteLength > PREVIEW_CAPTURE_POLICY.maxPngBytes) {
          return failure(
            artifactError("validation_failed", "The rendered chart is too large", {
              resource: "svg-bytes",
            }),
          );
        }
        const output = await store(bytes, "image/svg+xml");
        return {
          ok: true,
          gates: ["schema", "bounded-render"],
          evidence: { kind: "chart", rendererOutput: output },
          facts: { rendererBundleHash: CHART_RENDERER_BUNDLE_HASH },
          diagnostics: [],
          omitted: 0,
          semantics: "not-assessed",
          assets: [output],
        };
      }
      case "mermaid": {
        const result = await this.runJob(
          { kind: "mermaid", source: payload.source, theme: profile?.theme ?? "light" },
          environmentId,
          operation,
          signal,
        );
        if (!result.ok) return this.failedJob(environmentId, result, releases);
        if (result.kind !== "mermaid")
          return failure(
            artifactError("renderer_unavailable", "The renderer returned the wrong result kind"),
          );
        const bytes = new TextEncoder().encode(result.svg);
        if (
          bytes.byteLength > MERMAID_POLICY.maxSvgBytes ||
          result.svgElements > MERMAID_POLICY.maxSvgElements ||
          result.edges > MERMAID_POLICY.maxEdges
        ) {
          return failure(
            artifactError("validation_failed", "The rendered diagram exceeds its bounds", {
              resource: "mermaid-output",
            }),
          );
        }
        const output = await store(bytes, "image/svg+xml");
        this.countBlocked(result.blockedRequests);
        return {
          ok: true,
          gates: ["schema", "syntax", "bounded-render"],
          evidence: { kind: "mermaid", rendererOutput: output },
          facts: {
            browserBuild: result.browserBuild,
            rendererBundleHash: result.rendererBundleHash,
          },
          diagnostics: result.diagnostics,
          omitted: result.omittedDiagnostics,
          semantics: "not-assessed",
          assets: [output],
        };
      }
      case "html-static": {
        const assets = [];
        for (const asset of revision.assets) {
          const bytes = await this.ctx.store.readAsset(
            environmentId,
            asset.sha256,
            asset.byteLength,
          );
          assets.push({ name: asset.name, mimeType: asset.mimeType, bytes, sha256: asset.sha256 });
        }
        const diagnostics: ArtifactDiagnostic[] = [];
        const validated = validateInteractiveAssets(assets, diagnostics);
        if (!validated)
          return {
            ...failure(artifactError("validation_failed", "Static assets failed validation")),
            diagnostics,
          };
        let missing = false;
        let preparedBytes = utf8ByteLength(payload.html);
        const html = payload.html.replace(
          /artifact-asset:([A-Za-z0-9_.-]+)/g,
          (token, name: string) => {
            const asset = validated.get(name);
            if (!asset) {
              missing = true;
              return "";
            }
            preparedBytes += asset.dataUrl.length - token.length;
            if (preparedBytes > STATIC_HTML_POLICY.maxPreparedBytes) {
              throw new ArtifactFailure(
                artifactError(
                  "package_size_exceeded",
                  "Embedded static HTML exceeds the prepared byte limit",
                ),
              );
            }
            return asset.dataUrl;
          },
        );
        if (missing)
          return failure(
            artifactError("validation_failed", "Static HTML references an unstaged asset"),
          );
        if (utf8ByteLength(html) > STATIC_HTML_POLICY.maxPreparedBytes)
          return failure(
            artifactError(
              "package_size_exceeded",
              "Embedded static HTML exceeds the prepared byte limit",
            ),
          );
        const result = await this.runJob(
          { kind: "html-static", html, profile: profile! },
          environmentId,
          operation,
          signal,
        );
        if (!result.ok) return this.failedJob(environmentId, result, releases);
        if (result.kind !== "html-static")
          return failure(
            artifactError("renderer_unavailable", "The renderer returned the wrong result kind"),
          );
        this.countBlocked(result.blockedRequests);
        const effective = await store(new TextEncoder().encode(result.effectiveHtml), "text/html");
        const captures = await this.storeCaptures(environmentId, result.captures, releases);
        if (captures.length === 0) {
          return failure(artifactError("validation_failed", "The preview produced no capture"), [
            effective,
          ]);
        }
        return {
          ok: true,
          gates: ["schema", "syntax", "supervised-visual"],
          evidence: { kind: "html-static", captures },
          facts: {
            browserBuild: result.browserBuild,
            rendererBundleHash: result.rendererBundleHash,
            effectiveSourceHash: effective.sha256,
          },
          diagnostics: [...staticSanitizerDiagnostics(result.sanitizer), ...result.diagnostics],
          omitted: result.omittedDiagnostics,
          semantics: "not-assessed",
          assets: [effective, ...captures],
        };
      }
      case "html-interactive": {
        const preparer = this.ctx.runtime.preparer;
        if (!preparer)
          return failure(
            artifactError("renderer_unavailable", "Interactive HTML preparation is unavailable"),
          );
        const assets = [];
        for (const asset of revision.assets) {
          const bytes = await this.ctx.store.readAsset(
            environmentId,
            asset.sha256,
            asset.byteLength,
          );
          assets.push({ name: asset.name, mimeType: asset.mimeType, bytes, sha256: asset.sha256 });
        }
        const preparedResult = await preparer.prepare({
          artifactId: revision.artifactId,
          revision: revision.revision,
          html: payload.html,
          dependencyIds: payload.dependencyIds ?? [],
          assets,
        });
        if (!preparedResult.ok) {
          return { ...failure(preparedResult.error), diagnostics: preparedResult.diagnostics };
        }
        const prepared = preparedResult.prepared;
        if (prepared.byteLength > INTERACTIVE_HTML_POLICY.maxPreparedBytes) {
          return failure(
            artifactError(
              "package_size_exceeded",
              `The prepared package is ${prepared.byteLength} bytes (limit ${INTERACTIVE_HTML_POLICY.maxPreparedBytes})`,
              {
                resource: "prepared-bytes",
              },
            ),
          );
        }
        const document = await store(new TextEncoder().encode(prepared.document), "text/html");
        if (document.sha256 !== prepared.documentSha256) {
          return failure(
            artifactError(
              "validation_failed",
              "The prepared document digest did not match its bytes",
            ),
          );
        }
        const preparedRef: PreparedDocumentRef = {
          documentSha256: prepared.documentSha256,
          byteLength: document.byteLength,
          contentSecurityPolicy: prepared.contentSecurityPolicy,
          scriptHashes: prepared.scriptHashes,
          dependencyManifestHash: prepared.dependencyManifestHash,
          runtimeVersion: prepared.runtimeVersion,
          policyVersion: prepared.policyVersion,
          readinessNonce: prepared.readinessNonce,
          resolvedDependencies: prepared.resolvedDependencies,
        };
        const probes = payload.probes ?? [];
        const result = await this.runJob(
          {
            kind: "html-interactive",
            preparedDocument: prepared.document,
            contentSecurityPolicy: prepared.contentSecurityPolicy,
            profile: profile!,
            probes,
            readinessNonce: prepared.readinessNonce,
            identity: { artifactId: revision.artifactId, revision: revision.revision },
          },
          environmentId,
          operation,
          signal,
        );
        if (!result.ok) {
          const failed = await this.failedJob(environmentId, result, releases);
          return { ...failed, assets: [document, ...failed.assets], prepared: preparedRef };
        }
        if (result.kind !== "html-interactive")
          return failure(
            artifactError("renderer_unavailable", "The renderer returned the wrong result kind"),
          );
        this.countBlocked(result.blockedRequests);
        const captures = await this.storeCaptures(environmentId, result.captures, releases);
        const probeResults = result.probeResults.slice(0, INTERACTIVE_HTML_POLICY.maxProbeSteps);
        const allPassed =
          probeResults.length === probes.length &&
          probes.every(
            (_probe, index) =>
              probeResults.find((entry) => entry.index === index)?.status === "passed",
          );
        if (!allPassed || captures.length === 0) {
          return {
            ok: false,
            error: artifactError(
              "validation_failed",
              captures.length === 0
                ? "The preview produced no capture"
                : "A declared interaction probe did not pass",
              {
                suggestion:
                  "Inspect probeResults and diagnostic captures, fix the source, and preview again.",
              },
            ),
            diagnostics: result.diagnostics,
            omitted: result.omittedDiagnostics,
            captures,
            probeResults,
            assets: [document, ...captures],
            prepared: preparedRef,
          };
        }
        return {
          ok: true,
          gates: ["schema", "syntax", "supervised-visual"],
          evidence: { kind: "html-interactive", captures, probeResults },
          facts: {
            browserBuild: result.browserBuild,
            rendererBundleHash: result.rendererBundleHash,
            effectiveSourceHash: prepared.documentSha256,
            dependencyManifestHash: prepared.dependencyManifestHash,
          },
          diagnostics: result.diagnostics,
          omitted: result.omittedDiagnostics,
          probeResults,
          semantics: probes.length > 0 ? "probes-passed" : "not-assessed",
          assets: [document, ...captures],
          prepared: preparedRef,
        };
      }
    }
  }

  /**
   * Runs one job with at most two transient retries (jittered backoff), never
   * for policy, data, syntax, cancellation, capacity or unavailability. A
   * worker crash (a transient result, or `run` throwing anything but a typed
   * refusal) is retried the same way.
   */
  private async runJob(
    job: PreviewJob,
    environmentId: string,
    operation: StoredOperation,
    signal: AbortSignal,
  ): Promise<PreviewJobResult> {
    const runner = this.ctx.runtime.runner;
    if (!runner || !runner.status().available) {
      throw new ArtifactFailure(
        artifactError("renderer_unavailable", "Headless preview is unavailable on this host"),
      );
    }
    let attempt = 0;
    for (;;) {
      let result: PreviewJobResult;
      try {
        result = await runner.run(
          job,
          {
            environmentId,
            conversationKey: operation.owner.conversationKey,
            operationId: operation.operationId,
          },
          signal,
        );
      } catch (error) {
        if (error instanceof ArtifactFailure) throw error;
        // A worker that died (threw instead of answering) is a transient
        // infrastructure failure: retried like any other transient result.
        this.ctx.metrics.increment("worker_deaths", { kind: job.kind });
        result = {
          kind: job.kind,
          ok: false,
          error: artifactError("renderer_unavailable", "The preview worker stopped unexpectedly", {
            retryClass: "transient",
            operationId: operation.operationId,
          }),
          diagnostics: [],
          omittedDiagnostics: 0,
          captures: [],
          blockedRequests: {},
          browserBuild: "unknown",
        };
      }
      const retryable =
        !result.ok &&
        result.error.retryClass === "transient" &&
        result.error.code !== "capacity_exceeded" &&
        result.error.code !== "cancelled" &&
        !signal.aborted &&
        attempt < ARTIFACT_TOOL_POLICY.maxTransientRetries;
      if (!retryable) return result;
      attempt += 1;
      this.ctx.metrics.increment("transient_retries", { kind: job.kind });
      this.ctx.store.transact(environmentId, (records) => {
        const current = records.get("operation", operation.operationId);
        if (current && current.generation === operation.generation) {
          records.put(
            "operation",
            operation.operationId,
            { ...current, transientRetries: attempt },
            current.owner.conversationKey,
          );
        }
      });
      const delay = 100 * attempt + Math.floor(Math.random() * 200);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      });
    }
  }

  private async failedJob(
    environmentId: string,
    result: Extract<PreviewJobResult, { ok: false }>,
    releases: Array<() => void>,
  ): Promise<Extract<Outcome, { ok: false }>> {
    this.countBlocked(result.blockedRequests);
    if (result.error.code === "render_timeout")
      this.ctx.metrics.increment("deadlines", { kind: result.kind });
    let captures: ArtifactCapture[] = [];
    try {
      captures = await this.storeCaptures(environmentId, result.captures, releases);
    } catch {
      captures = [];
    }
    return {
      ok: false,
      error: result.error,
      diagnostics: result.diagnostics,
      omitted: result.omittedDiagnostics,
      captures,
      ...(result.probeResults
        ? { probeResults: result.probeResults.slice(0, INTERACTIVE_HTML_POLICY.maxProbeSteps) }
        : {}),
      assets: captures,
    };
  }

  private countBlocked(blocked: Record<string, number>): void {
    for (const [reason, count] of Object.entries(blocked)) {
      if (Number.isSafeInteger(count) && count > 0)
        this.ctx.metrics.increment("blocked_requests", { reason }, count);
    }
  }

  /** At most three bounded PNG captures; anything else is dropped, never stored. */
  private async storeCaptures(
    environmentId: string,
    captures: PreviewCapture[],
    releases: Array<() => void>,
  ): Promise<ArtifactCapture[]> {
    const stored: ArtifactCapture[] = [];
    for (const capture of captures.slice(0, PREVIEW_CAPTURE_POLICY.maxCapturesPerReceipt)) {
      const p = PREVIEW_CAPTURE_POLICY;
      if (
        !(capture.png instanceof Uint8Array) ||
        capture.png.byteLength > p.maxPngBytes ||
        capture.png.byteLength < PNG_SIGNATURE.length ||
        !PNG_SIGNATURE.every((byte, index) => capture.png[index] === byte) ||
        !Number.isSafeInteger(capture.width) ||
        !Number.isSafeInteger(capture.height) ||
        capture.width < 1 ||
        capture.height < 1 ||
        capture.width > p.maxDimension ||
        capture.height > p.maxDimension ||
        capture.width * capture.height > p.maxPixels
      ) {
        continue;
      }
      const written = await this.ctx.store.writeAsset(environmentId, capture.png);
      releases.push(written.release);
      stored.push({
        assetId: assetIdFor(written.sha256),
        sha256: written.sha256,
        mimeType: "image/png",
        byteLength: written.byteLength,
        width: capture.width,
        height: capture.height,
      });
    }
    return stored;
  }
}

/**
 * Tell the author what the static policy removed: authored scripts, frames
 * and handlers never run in a static artifact, so a preview that silently
 * dropped them would read as "your behaviour works".
 */
export function staticSanitizerDiagnostics(sanitizer: {
  scripts: number;
  handlers: number;
  externalReferences: number;
  forbiddenElements: number;
  executableUrls: number;
}): ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];
  const add = (count: number, code: string, message: string) => {
    if (count > 0)
      diagnostics.push({ severity: "warning", code, message: `${message} (${count})` });
  };
  add(
    sanitizer.scripts,
    "static_script_removed",
    "Scripts were removed: html-static never runs JavaScript; use html-interactive for behaviour",
  );
  add(sanitizer.handlers, "static_handler_removed", "Inline event handlers were removed");
  add(
    sanitizer.forbiddenElements,
    "static_element_removed",
    "Frames, embeds, base, meta or link elements were removed",
  );
  add(sanitizer.executableUrls, "static_url_removed", "javascript:/vbscript: URLs were removed");
  add(
    sanitizer.externalReferences,
    "static_external_reference",
    "External resources are blocked and will not load",
  );
  return diagnostics;
}
