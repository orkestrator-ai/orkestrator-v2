/**
 * Wire format between the backend supervisor and a preview worker process
 * (local process or container). One JSON job package goes in on stdin; NDJSON
 * events come out on stdout, the last being the result. Both directions are
 * byte-bounded by the supervisor. Nothing here is selected by artifact
 * content: launch configuration comes from backend configuration only.
 */
import type {
  ArtifactDiagnostic,
  ArtifactErrorCode,
  ArtifactPreviewProfile,
  ArtifactProbeResultV1,
  ArtifactProbeV1,
} from "@orkestrator/protocol/transcript-artifacts";

import type { ArtifactPrintProfile } from "./print-profile.js";

export const PREVIEW_WORKER_PROTOCOL = 1;

export interface WorkerLimits {
  readinessMs: number;
  mermaidRenderMs: number;
  probeStepMs: number;
  /** Total worker budget; the worker uses it only to bound its own waits. */
  workerWallMs: number;
}

export type WorkerJob =
  | { kind: "probe" }
  | { kind: "html-static"; html: string; profile: ArtifactPreviewProfile }
  | {
      kind: "html-interactive";
      preparedDocument: string;
      contentSecurityPolicy: string;
      readinessNonce?: string;
      identity?: { artifactId: string; revision: number };
      profile: ArtifactPreviewProfile;
      probes: ArtifactProbeV1[];
    }
  | { kind: "mermaid"; source: string; theme: "light" | "dark" }
  | {
      /** PDF of one verified HTML revision under the fixed print profile. */
      kind: "html-print";
      print: ArtifactPrintProfile;
      profile: ArtifactPreviewProfile;
      document:
        | { type: "static"; html: string }
        | {
            type: "interactive";
            preparedDocument: string;
            contentSecurityPolicy: string;
            readinessNonce?: string;
            identity?: { artifactId: string; revision: number };
          };
    }
  | {
      /** First page of a PDF attachment as a bounded PNG, rendered by the pinned pdf.js. */
      kind: "pdf-thumbnail";
      pdfBase64: string;
      maxDimension: number;
      maxPages: number;
    };

export interface WorkerJobPackage {
  v: typeof PREVIEW_WORKER_PROTOCOL;
  job: WorkerJob;
  limits: WorkerLimits;
  /** Process mode: the backend-resolved Chromium executable. Container mode: undefined. */
  executablePath?: string;
  /** Test-only fault injection; set by backend code, never by artifacts. */
  testing?: { blockMermaidRender?: boolean };
}

export interface WorkerCapture {
  pngBase64: string;
  width: number;
  height: number;
  label: "initial" | "final" | "diagnostic";
}

export interface WorkerFailure {
  code: ArtifactErrorCode;
  message: string;
  resource?: string;
}

export interface WorkerResult {
  ok: boolean;
  kind: WorkerJob["kind"];
  failure?: WorkerFailure;
  browserBuild: string;
  diagnostics: ArtifactDiagnostic[];
  blockedRequests: Record<string, number>;
  captures: WorkerCapture[];
  // html-static
  effectiveHtml?: string;
  sanitizer?: {
    scripts: number;
    handlers: number;
    externalReferences: number;
    forbiddenElements: number;
    executableUrls: number;
  };
  elementCount?: number;
  // html-interactive
  probeResults?: ArtifactProbeResultV1[];
  runtimeErrors?: number;
  // mermaid
  svg?: string;
  diagramType?: string;
  svgElements?: number;
  preSanitize?: { bytes: number; elements: number };
  edges?: number;
  // html-print
  pdfBase64?: string;
  /** html-print and pdf-thumbnail: pages in the document. */
  pageCount?: number;
  /** html-print of html-static: SHA-256 of the sanitized document actually printed. */
  effectiveHtmlSha256?: string;
  // pdf-thumbnail: a refusal that still carries metadata (no thumbnail).
  pdfRefusal?: "page-limit" | "encrypted" | "invalid-pdf";
}

export type WorkerEvent =
  | { t: "launched"; browserPid: number | null; browserBuild: string }
  | { t: "phase"; phase: "navigating" | "ready" | "render-start" | "render-done" | "capturing" }
  | { t: "result"; result: WorkerResult };
