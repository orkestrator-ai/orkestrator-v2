/**
 * Admission, fair scheduling and deadlines for supervised preview jobs.
 *
 * Every job runs in a fresh owned worker boundary (see preview-supervisor.ts)
 * so authored JavaScript never shares a browser with another job or with the
 * backend. Admission is bounded by `PREVIEW_ADMISSION_POLICY` (queued per
 * environment/global, nonterminal per conversation, queued metadata bytes),
 * and over-capacity requests are rejected immediately with a typed,
 * retryable `capacity_exceeded` naming the exhausted resource — there is no
 * hidden unbounded promise queue. Dequeue is fair across environments
 * (least-recently-served first) with aging so no job starves. Each job
 * resolves exactly once; late worker output after a timeout or cancellation
 * is discarded; a running slot is released only after the boundary's exit
 * has been verified. A boundary whose exit cannot be verified is quarantined:
 * it keeps holding its slot while a bounded reaper retries termination, and
 * the status reports it.
 *
 * Authored JavaScript (`html-interactive`) needs an OS boundary: process
 * isolation refuses it unless explicitly allowed (`allowProcessInteractive`).
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { installArtifactFrameRuntime } from "@orkestrator/protocol/artifact-frame-channel";
import { installDesignRuntime } from "@orkestrator/protocol/design-runtime";
import {
  INTERACTIVE_HTML_POLICY,
  MERMAID_POLICY,
  PDF_POLICY,
  PREVIEW_ADMISSION_POLICY,
  PREVIEW_CAPTURE_POLICY,
  STATIC_HTML_POLICY,
  utf8ByteLength,
} from "@orkestrator/protocol/rich-content-policy";
import {
  ArtifactFailure,
  artifactError,
  type ArtifactDiagnostic,
  type ArtifactError,
} from "@orkestrator/protocol/transcript-artifacts";

import { resolveDesignChromiumPath } from "../design/index.js";
import type {
  PreviewCapture,
  PreviewJob,
  PreviewJobResult,
  PreviewJobScope,
  PreviewJobSuccessBase,
  PreviewRunner,
  PreviewRunnerStatus,
} from "./contracts.js";
import {
  mermaidRendererBundleHash,
  pdfRendererBundleHash,
  sha256Hex,
} from "./dependency-manifest.js";
import {
  MERMAID_MATH_LABELS_UNSUPPORTED,
  detectMermaidMathLabels,
  verifyMermaidSvg,
} from "./mermaid-svg.js";
import { countPrintedPdfPages, looksLikePdf } from "./print-profile.js";
import {
  runDocker,
  superviseWorker,
  type SupervisedJob,
  type SupervisedOutcome,
  type WorkerLaunch,
} from "./preview-supervisor.js";
import {
  PREVIEW_WORKER_PROTOCOL,
  type WorkerJob,
  type WorkerJobPackage,
  type WorkerResult,
} from "./preview-worker-protocol.js";

export interface PreviewBudgets {
  queueWaitMs: number;
  workerWallMs: number;
  readinessMs: number;
  /** Extra time the external supervisor allows past readinessMs before killing. */
  readinessHardSlackMs: number;
  operationDeadlineMs: number;
  cleanupGraceMs: number;
  mermaidRenderMs: number;
  probeStepMs: number;
}

export const DEFAULT_PREVIEW_BUDGETS: PreviewBudgets = {
  queueWaitMs: PREVIEW_ADMISSION_POLICY.queueWaitMs,
  workerWallMs: PREVIEW_ADMISSION_POLICY.workerWallMs,
  readinessMs: PREVIEW_ADMISSION_POLICY.readinessMs,
  readinessHardSlackMs: 1_000,
  operationDeadlineMs: PREVIEW_ADMISSION_POLICY.operationDeadlineMs,
  cleanupGraceMs: PREVIEW_ADMISSION_POLICY.cleanupGraceMs,
  mermaidRenderMs: MERMAID_POLICY.renderTimeoutMs,
  probeStepMs: INTERACTIVE_HTML_POLICY.maxProbeStepMs,
};

export type PreviewAdmissionLimits = {
  [
    K in
      | "runningPerEnvironment"
      | "runningGlobal"
      | "queuedPerEnvironment"
      | "queuedGlobal"
      | "nonterminalPerConversation"
      | "queuedMetadataBytesGlobal"
  ]: number;
};

export const PREVIEW_AGING_MS = 5_000;
const HEALTH_CACHE_MS = 60_000;

/** Bounded reaper for unverified worker exits: delays between kill-and-verify attempts. */
export const DEFAULT_REAPER_DELAYS_MS: readonly number[] = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000,
];

export const PROCESS_INTERACTIVE_REFUSAL =
  "interactive previews need the container worker; set ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION=container or explicitly allow process isolation with ORKESTRATOR_ARTIFACT_PREVIEW_ALLOW_PROCESS_INTERACTIVE=1";

export interface ContainerIsolationConfig {
  docker: string;
  image: string;
  seccompProfile?: string;
  user: string;
  /** Owner label value: lets startup recovery remove only this backend's orphans. */
  owner?: string;
  /** True when `image` is content-addressed (an image id or `name@sha256:` digest). */
  pinned?: boolean;
}

export interface PreviewRunnerOptions {
  isolation: "process" | "container";
  /**
   * Process mode only: run `html-interactive` (authored JavaScript) without an
   * OS boundary. Off by default; interactive jobs are then refused with
   * `renderer_unavailable`. Static HTML and Mermaid execute no authored code.
   */
  allowProcessInteractive?: boolean;
  /** Reported in status: whether `isolation` came from auto-detection. */
  isolationSelection?: "auto" | "configured";
  /** Delays of the bounded reaper for unverified exits (tests shorten it). */
  reaperDelaysMs?: readonly number[];
  reaperPollMs?: number;
  /** Test seam: replaces the external supervisor. Never configured from content. */
  supervise?: typeof superviseWorker;
  /** Process mode: Chromium discovery (defaults to the design renderer's resolver). */
  executablePath?: () => string | undefined;
  /** Process mode: the worker command (defaults to this runtime + the worker entry). */
  workerCommand?: () => { command: string; args: string[] } | null;
  container?: ContainerIsolationConfig;
  budgets?: Partial<PreviewBudgets>;
  admission?: Partial<PreviewAdmissionLimits>;
  agingMs?: number;
  memoryLimitBytes?: number;
  /** Test-only fault injection. Never derived from artifact content. */
  testing?: WorkerJobPackage["testing"];
  logger?: Pick<Console, "warn">;
  /** Observes each worker boundary after its exit was checked (tests, metrics). Content-free. */
  onWorkerExit?: (report: {
    operationId: string;
    verified: boolean;
    pids: number[];
    browserPid: number | null;
    workerPid: number | null;
    /** Process mode: path of the job's private scratch directory (removed once the exit is verified). */
    scratchDir?: string | null;
  }) => void;
}

interface Ticket {
  job: PreviewJob;
  scope: PreviewJobScope;
  enqueuedAt: number;
  deadline: number;
  queuedBytes: number;
  settled: boolean;
  started: boolean;
  resolve: (result: PreviewJobResult) => void;
  timers: Set<ReturnType<typeof setTimeout>>;
  supervised?: SupervisedJob;
  detachSignal?: () => void;
  /** Exit unverified: the slot stays held until the reaper confirms the boundary is gone. */
  quarantined?: boolean;
}

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Default worker command: the packaged worker bundle, else the TypeScript entry (development). */
export function defaultWorkerCommand(
  baseDir = moduleDirectory(),
): { command: string; args: string[] } | null {
  const candidates = [
    path.join(baseDir, "artifact-runtime", "preview-worker.js"),
    path.join(baseDir, "preview-worker.js"),
    path.join(baseDir, "preview-worker-entry.ts"),
  ];
  const entry = candidates.find((candidate) => existsSync(candidate));
  return entry ? { command: process.execPath, args: [entry] } : null;
}

const STATIC_RENDERER_HASH = sha256Hex(`static:${installDesignRuntime.toString()}`);
const INTERACTIVE_RENDERER_HASH = sha256Hex(
  `interactive:${installArtifactFrameRuntime.toString()}`,
);

/** Printing reuses the static and interactive paths; its identity names both. */
const PRINT_RENDERER_HASH = sha256Hex(`print:${STATIC_RENDERER_HASH}:${INTERACTIVE_RENDERER_HASH}`);

function rendererBundleHash(kind: PreviewJob["kind"]): string {
  switch (kind) {
    case "mermaid":
      return mermaidRendererBundleHash();
    case "html-static":
      return STATIC_RENDERER_HASH;
    case "html-interactive":
      return INTERACTIVE_RENDERER_HASH;
    case "html-print":
      return PRINT_RENDERER_HASH;
    case "pdf-thumbnail":
      return pdfRendererBundleHash();
  }
}

/** Whether a job runs authored JavaScript (and so needs an OS boundary). */
function runsAuthoredScript(job: PreviewJob): boolean {
  return (
    job.kind === "html-interactive" ||
    (job.kind === "html-print" && job.document.type === "interactive")
  );
}

/**
 * Queue accounting for a PDF attachment: its bytes are read through an
 * authorized path like a persisted asset, so only a bounded share counts as
 * queued metadata. Callers bound how many thumbnail jobs hold bytes at once.
 */
const PDF_QUEUED_METADATA_BYTES = 64 * 1024;

function currentRendererBundleHashes(): NonNullable<PreviewRunnerStatus["rendererBundleHashes"]> {
  return {
    "html-static": STATIC_RENDERER_HASH,
    "html-interactive": INTERACTIVE_RENDERER_HASH,
    mermaid: mermaidRendererBundleHash(),
  };
}

function queuedBytesOf(job: PreviewJob): number {
  switch (job.kind) {
    case "html-static":
      return utf8ByteLength(job.html);
    case "mermaid":
      return utf8ByteLength(job.source);
    case "html-interactive": {
      // Queue accounting covers authored/package metadata. Pinned dependency
      // and persisted asset bodies are excluded by policy, so a document's
      // contribution is bounded by the authored-source ceiling.
      const probes = utf8ByteLength(JSON.stringify(job.probes ?? []));
      const document =
        job.queuedMetadataBytes ??
        Math.min(job.preparedDocument.length, INTERACTIVE_HTML_POLICY.maxAuthoredBytes);
      return document + probes;
    }
    case "html-print":
      return job.document.type === "static"
        ? utf8ByteLength(job.document.html)
        : Math.min(job.document.preparedDocument.length, INTERACTIVE_HTML_POLICY.maxAuthoredBytes);
    case "pdf-thumbnail":
      return PDF_QUEUED_METADATA_BYTES;
  }
}

function failed(
  kind: PreviewJob["kind"],
  error: ArtifactError,
  browserBuild: string,
  extra: Partial<Extract<PreviewJobResult, { ok: false }>> = {},
): PreviewJobResult {
  return {
    kind,
    ok: false,
    error,
    diagnostics: [],
    omittedDiagnostics: 0,
    captures: [],
    blockedRequests: {},
    browserBuild,
    ...extra,
  };
}

function decodeCaptures(result: WorkerResult): PreviewCapture[] | null {
  const captures: PreviewCapture[] = [];
  for (const capture of result.captures.slice(0, PREVIEW_CAPTURE_POLICY.maxCapturesPerReceipt)) {
    const png = new Uint8Array(Buffer.from(capture.pngBase64, "base64"));
    if (
      png.byteLength === 0 ||
      png.byteLength > PREVIEW_CAPTURE_POLICY.maxPngBytes ||
      capture.width > PREVIEW_CAPTURE_POLICY.maxDimension ||
      capture.height > PREVIEW_CAPTURE_POLICY.maxDimension ||
      capture.width * capture.height > PREVIEW_CAPTURE_POLICY.maxPixels ||
      png[0] !== 0x89 ||
      png[1] !== 0x50
    ) {
      return null;
    }
    captures.push({
      png,
      width: capture.width,
      height: capture.height,
      label: capture.label,
    });
  }
  return captures;
}

function boundDiagnostics(diagnostics: ArtifactDiagnostic[]): {
  diagnostics: ArtifactDiagnostic[];
  omitted: number;
} {
  const kept: ArtifactDiagnostic[] = [];
  let bytes = 0;
  let omitted = 0;
  for (const diagnostic of diagnostics) {
    const bounded = {
      ...diagnostic,
      message: diagnostic.message.slice(0, 1_500),
    };
    const size = utf8ByteLength(JSON.stringify(bounded));
    if (kept.length >= 50 || size > 2_048 || bytes + size > 32 * 1024) {
      omitted++;
      continue;
    }
    bytes += size;
    kept.push(bounded);
  }
  return { diagnostics: kept, omitted };
}

export class TranscriptPreviewRunner implements PreviewRunner {
  private readonly budgets: PreviewBudgets;
  private readonly limits: PreviewAdmissionLimits;
  private readonly agingMs: number;
  private readonly executablePath: () => string | undefined;
  private readonly workerCommand: () => {
    command: string;
    args: string[];
  } | null;
  private readonly queue: Ticket[] = [];
  private readonly running = new Set<Ticket>();
  private readonly served = new Map<string, number>();
  private serveCounter = 0;
  private queuedBytes = 0;
  private stopping = false;
  private closing: Promise<void> | undefined;
  private probeRecord: { at: number; status: PreviewRunnerStatus } | undefined;
  private probing: Promise<PreviewRunnerStatus> | undefined;
  /** The probe's worker while it runs; `close()` stops it with the job workers. */
  private probeJob: SupervisedJob | undefined;
  private lastBrowserBuild = "unknown";
  private unverifiedExits = 0;
  private readonly reaperTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly supervise: typeof superviseWorker;

  constructor(private readonly options: PreviewRunnerOptions) {
    this.budgets = { ...DEFAULT_PREVIEW_BUDGETS, ...options.budgets };
    this.limits = { ...PREVIEW_ADMISSION_POLICY, ...options.admission };
    this.agingMs = options.agingMs ?? PREVIEW_AGING_MS;
    this.executablePath = options.executablePath ?? (() => resolveDesignChromiumPath());
    this.workerCommand = options.workerCommand ?? (() => defaultWorkerCommand());
    this.supervise = options.supervise ?? superviseWorker;
  }

  /**
   * Counts for tests and health surfaces. `running` counts held slots,
   * including quarantined boundaries; `quarantined` is that subset.
   */
  stats(): {
    queued: number;
    running: number;
    queuedBytes: number;
    unverifiedExits: number;
    quarantined: number;
  } {
    return {
      queued: this.queue.length,
      running: this.running.size,
      queuedBytes: this.queuedBytes,
      unverifiedExits: this.unverifiedExits,
      quarantined: this.quarantinedCount(),
    };
  }

  private quarantinedCount(): number {
    let count = 0;
    for (const ticket of this.running) if (ticket.quarantined) count++;
    return count;
  }

  private interactiveRefused(): boolean {
    return this.options.isolation === "process" && this.options.allowProcessInteractive !== true;
  }

  /** Honest isolation detail shared by every status answer. */
  private isolationDetail(): Partial<PreviewRunnerStatus> {
    const container = this.options.container;
    const quarantined = this.quarantinedCount();
    return {
      isolationSelection: this.options.isolationSelection ?? "configured",
      ...(this.interactiveRefused()
        ? {
            interactiveIsolation: "unavailable" as const,
            interactiveReason: PROCESS_INTERACTIVE_REFUSAL,
          }
        : { interactiveIsolation: this.options.isolation }),
      ...(quarantined > 0 ? { quarantinedWorkers: quarantined } : {}),
      ...(this.options.isolation === "container" && container
        ? {
            workerImage: {
              reference: container.image,
              pinned: container.pinned === true,
            },
          }
        : {}),
    };
  }

  status(): PreviewRunnerStatus {
    return {
      ...this.baseStatus(),
      rendererBundleHashes: currentRendererBundleHashes(),
    };
  }

  /** Advisory admission probe for the service's synchronous `preview_artifact` answer. */
  admissionRefusal(
    scope: Pick<PreviewJobScope, "environmentId" | "conversationKey">,
  ): string | null {
    if (this.stopping) return null;
    return this.exhaustedResource({ ...scope, operationId: "" }, 0);
  }

  private baseStatus(): PreviewRunnerStatus {
    const isolation = this.options.isolation;
    const detail = this.isolationDetail();
    if (this.stopping)
      return {
        available: false,
        isolation: "unavailable",
        browserBuild: this.lastBrowserBuild,
        reason: "Preview runner is stopping",
        ...detail,
        interactiveIsolation: "unavailable",
      };
    const missing = this.missingCapability();
    if (missing)
      return {
        available: false,
        isolation: "unavailable",
        browserBuild: this.lastBrowserBuild,
        reason: missing,
        ...detail,
        interactiveIsolation: "unavailable",
      };
    if (this.quarantinedCount() >= this.limits.runningGlobal)
      return {
        available: false,
        isolation: "unavailable",
        browserBuild: this.lastBrowserBuild,
        reason:
          "Every preview slot is held by a worker whose exit could not be verified; it is released once the worker is confirmed gone",
        ...detail,
      };
    const probe = this.probeRecord;
    if (probe && Date.now() - probe.at < HEALTH_CACHE_MS)
      return probe.status.available
        ? { ...probe.status, ...detail }
        : { ...probe.status, ...detail, interactiveIsolation: "unavailable" };
    return {
      available: true,
      isolation,
      browserBuild: this.lastBrowserBuild,
      ...(probe && !probe.status.available ? { reason: probe.status.reason } : {}),
      ...detail,
    };
  }

  probe(force = false): Promise<PreviewRunnerStatus> {
    if (this.probing) return this.probing;
    const record = this.probeRecord;
    if (!force && record && Date.now() - record.at < HEALTH_CACHE_MS)
      return Promise.resolve(record.status);
    if (this.stopping || this.missingCapability()) return Promise.resolve(this.status());
    const probing = (async (): Promise<PreviewRunnerStatus> => {
      if (this.options.isolation === "container") {
        const container = this.options.container!;
        const inspect = await runDocker(container.docker, [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          container.image,
        ]);
        if (inspect.code !== 0) {
          return {
            available: false,
            isolation: "unavailable",
            browserBuild: "unknown",
            reason: "The artifact preview worker image is not available to Docker",
          };
        }
      }
      const launch = this.launch();
      if (!launch)
        return {
          available: false,
          isolation: "unavailable",
          browserBuild: "unknown",
          reason: "The preview worker entry is missing",
        };
      if (this.stopping) return this.status();
      const supervised = this.supervise(
        launch,
        this.workerPackage({ kind: "probe" }, this.budgets.workerWallMs),
        this.deadlines(this.budgets.workerWallMs),
      );
      this.probeJob = supervised;
      const outcome = await supervised.outcome;
      const exit = await supervised.exited;
      if (this.probeJob === supervised) this.probeJob = undefined;
      if (!exit.verified && !(await supervised.reap())) {
        this.unverifiedExits++;
        return {
          available: false,
          isolation: "unavailable",
          browserBuild: "unknown",
          reason: "The preview worker's exit could not be verified",
        };
      }
      if (outcome.type === "result" && outcome.result.ok) {
        this.lastBrowserBuild = outcome.result.browserBuild;
        return {
          available: true,
          isolation: this.options.isolation,
          browserBuild: outcome.result.browserBuild,
        };
      }
      const reason =
        outcome.type === "result"
          ? (outcome.result.failure?.message ?? "The preview worker could not start Chromium")
          : `The preview worker failed its readiness check (${outcome.type})`;
      return {
        available: false,
        isolation: "unavailable",
        browserBuild: "unknown",
        reason,
      };
    })()
      .then((status) => {
        this.probeRecord = { at: Date.now(), status };
        // The full answer, including interactive isolation and quarantine detail.
        return this.status();
      })
      .finally(() => {
        if (this.probing === probing) this.probing = undefined;
      });
    this.probing = probing;
    return probing;
  }

  run(job: PreviewJob, scope: PreviewJobScope, signal: AbortSignal): Promise<PreviewJobResult> {
    if (this.stopping)
      return Promise.reject(
        new ArtifactFailure(
          artifactError("renderer_unavailable", "The preview runner is stopping"),
        ),
      );
    const missing = this.missingCapability();
    if (missing)
      return Promise.reject(new ArtifactFailure(artifactError("renderer_unavailable", missing)));
    // Authored JavaScript never runs without an OS boundary unless the operator opted in.
    if (runsAuthoredScript(job) && this.interactiveRefused())
      return Promise.reject(
        new ArtifactFailure(artifactError("renderer_unavailable", PROCESS_INTERACTIVE_REFUSAL)),
      );
    if (
      this.probeRecord &&
      !this.probeRecord.status.available &&
      Date.now() - this.probeRecord.at < HEALTH_CACHE_MS
    ) {
      return Promise.reject(
        new ArtifactFailure(
          artifactError(
            "renderer_unavailable",
            this.probeRecord.status.reason ?? "Preview isolation is unavailable",
          ),
        ),
      );
    }

    const invalid = this.validateJob(job);
    if (invalid)
      return Promise.resolve(
        failed(job.kind, invalid.error, this.lastBrowserBuild, {
          diagnostics: invalid.diagnostics ?? [],
        }),
      );

    const queuedBytes = queuedBytesOf(job);
    const exhausted = this.exhaustedResource(scope, queuedBytes);
    if (exhausted) {
      this.options.logger?.warn("[artifact-preview] admission refused", {
        resource: exhausted,
        queued: this.queue.length,
        running: this.running.size,
      });
      return Promise.reject(
        new ArtifactFailure(
          artifactError(
            "capacity_exceeded",
            `Preview capacity is full (${exhausted}); retry shortly`,
            {
              resource: exhausted,
              operationId: scope.operationId,
            },
          ),
        ),
      );
    }
    if (signal.aborted) {
      return Promise.resolve(
        failed(
          job.kind,
          artifactError("cancelled", "The preview was cancelled before it started"),
          this.lastBrowserBuild,
        ),
      );
    }

    return new Promise<PreviewJobResult>((resolve) => {
      const now = Date.now();
      const ticket: Ticket = {
        job,
        scope,
        enqueuedAt: now,
        deadline: now + this.budgets.operationDeadlineMs,
        queuedBytes,
        settled: false,
        started: false,
        resolve,
        timers: new Set(),
      };
      const onAbort = () => this.cancel(ticket);
      signal.addEventListener("abort", onAbort, { once: true });
      ticket.detachSignal = () => signal.removeEventListener("abort", onAbort);
      this.arm(ticket, Math.min(this.budgets.queueWaitMs, this.budgets.operationDeadlineMs), () => {
        if (ticket.started) return;
        this.dequeue(ticket);
        this.settle(
          ticket,
          failed(
            job.kind,
            artifactError(
              "capacity_exceeded",
              "The preview waited too long in the queue and was not started",
              {
                resource: "queue-wait",
                operationId: scope.operationId,
              },
            ),
            this.lastBrowserBuild,
          ),
        );
        this.pump();
      });
      this.arm(ticket, this.budgets.operationDeadlineMs, () => {
        this.settle(
          ticket,
          failed(
            job.kind,
            artifactError("render_timeout", "The preview exceeded its operation deadline", {
              operationId: scope.operationId,
            }),
            this.lastBrowserBuild,
          ),
        );
        ticket.supervised?.cancel();
      });
      this.queue.push(ticket);
      this.queuedBytes += queuedBytes;
      this.pump();
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopping = true;
      for (const timer of this.reaperTimers) clearTimeout(timer);
      this.reaperTimers.clear();
      for (const ticket of this.queue.splice(0)) {
        this.queuedBytes -= ticket.queuedBytes;
        this.settle(
          ticket,
          failed(
            ticket.job.kind,
            artifactError("renderer_unavailable", "The preview runner is stopping"),
            this.lastBrowserBuild,
          ),
        );
      }
      const exits: Promise<unknown>[] = [];
      for (const ticket of this.running) {
        this.settle(
          ticket,
          failed(
            ticket.job.kind,
            artifactError("renderer_unavailable", "The preview runner is stopping"),
            this.lastBrowserBuild,
          ),
        );
        ticket.supervised?.cancel();
        if (ticket.supervised) exits.push(ticket.supervised.exited);
      }
      // A probe's worker holds a scratch directory like a job's; the backend
      // must not exit before its verified exit removes it.
      if (this.probeJob) {
        this.probeJob.cancel();
        exits.push(this.probeJob.exited);
      }
      await Promise.race([
        Promise.allSettled(exits),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    })();
    return this.closing;
  }

  private missingCapability(): string | undefined {
    if (this.options.isolation === "container") {
      if (!this.options.container?.image) return "No artifact preview worker image is configured";
      return undefined;
    }
    if (!this.executablePath()) {
      return "HTML previews require Chromium. Install Chromium or set ORKESTRATOR_DESIGN_CHROMIUM_PATH to its executable.";
    }
    if (!this.workerCommand()) return "The preview worker entry is missing from this installation";
    return undefined;
  }

  private validateJob(
    job: PreviewJob,
  ): { error: ArtifactError; diagnostics?: ArtifactDiagnostic[] } | null {
    const error = this.validateJobError(job);
    if (error) return { error };
    if (job.kind === "mermaid") {
      const math = detectMermaidMathLabels(job.source);
      if (math) {
        const message =
          "Mermaid math labels ($$…$$) are not supported: they need HTML labels, which stay disabled for security. Write the expression as plain text or Unicode (for example x² + y²).";
        return {
          error: artifactError("validation_failed", message, {
            resource: "math-labels",
          }),
          diagnostics: [
            {
              severity: "error",
              code: MERMAID_MATH_LABELS_UNSUPPORTED,
              message,
              location: `line ${math.line}:${math.column}`,
            },
          ],
        };
      }
    }
    return null;
  }

  private validateJobError(job: PreviewJob): ArtifactError | null {
    switch (job.kind) {
      case "html-static": {
        const bytes = utf8ByteLength(job.html);
        if (bytes > STATIC_HTML_POLICY.maxPreparedBytes) {
          return artifactError(
            "package_size_exceeded",
            `Static HTML is ${bytes} bytes (limit ${STATIC_HTML_POLICY.maxPreparedBytes})`,
            { resource: "source-bytes" },
          );
        }
        return null;
      }
      case "html-interactive": {
        const bytes = utf8ByteLength(job.preparedDocument);
        if (bytes > INTERACTIVE_HTML_POLICY.maxPreparedBytes) {
          return artifactError(
            "package_size_exceeded",
            `Prepared document is ${bytes} bytes (limit ${INTERACTIVE_HTML_POLICY.maxPreparedBytes})`,
            { resource: "prepared-bytes" },
          );
        }
        if ((job.probes ?? []).length > INTERACTIVE_HTML_POLICY.maxProbeSteps) {
          return artifactError(
            "invalid_input",
            `At most ${INTERACTIVE_HTML_POLICY.maxProbeSteps} probe steps are allowed`,
          );
        }
        if (
          !job.contentSecurityPolicy.includes("sandbox allow-scripts") ||
          /unsafe-eval|wasm-unsafe-eval/.test(job.contentSecurityPolicy)
        ) {
          return artifactError(
            "policy_denied",
            "The document policy was not generated by the interactive preparer",
          );
        }
        return null;
      }
      case "mermaid": {
        const bytes = utf8ByteLength(job.source);
        if (bytes > MERMAID_POLICY.maxSourceBytes) {
          return artifactError(
            "package_size_exceeded",
            `Diagram source is ${bytes} bytes (limit ${MERMAID_POLICY.maxSourceBytes})`,
            { resource: "source-bytes" },
          );
        }
        return null;
      }
      case "html-print": {
        if (job.print.paper !== "a4" && job.print.paper !== "letter")
          return artifactError("invalid_input", "Unknown print paper", {
            resource: "print-profile",
          });
        if (job.document.type === "static") {
          return this.validateJobError({
            kind: "html-static",
            html: job.document.html,
            profile: job.profile,
          });
        }
        return this.validateJobError({
          kind: "html-interactive",
          preparedDocument: job.document.preparedDocument,
          contentSecurityPolicy: job.document.contentSecurityPolicy,
          profile: job.profile,
          probes: [],
        });
      }
      case "pdf-thumbnail": {
        if (job.pdf.byteLength > PDF_POLICY.maxBytes) {
          return artifactError(
            "package_size_exceeded",
            `The PDF is ${job.pdf.byteLength} bytes (preview limit ${PDF_POLICY.maxBytes})`,
            { resource: "pdf-bytes" },
          );
        }
        if (!looksLikePdf(job.pdf))
          return artifactError("invalid_input", "The bytes are not a PDF document", {
            resource: "pdf-signature",
          });
        return null;
      }
    }
  }

  private exhaustedResource(scope: PreviewJobScope, bytes: number): string | null {
    const queuedForEnv = this.queue.filter(
      (ticket) => ticket.scope.environmentId === scope.environmentId,
    ).length;
    // A quarantined boundary holds a running slot, but its operation is already terminal.
    const nonterminalForConversation = [...this.queue, ...this.running].filter(
      (ticket) =>
        !ticket.quarantined &&
        ticket.scope.environmentId === scope.environmentId &&
        ticket.scope.conversationKey === scope.conversationKey,
    ).length;
    if (nonterminalForConversation >= this.limits.nonterminalPerConversation)
      return "conversation-operations";
    if (queuedForEnv >= this.limits.queuedPerEnvironment) return "environment-queue";
    if (this.queue.length >= this.limits.queuedGlobal) return "global-queue";
    if (this.queuedBytes + bytes > this.limits.queuedMetadataBytesGlobal)
      return "queued-metadata-bytes";
    return null;
  }

  private arm(ticket: Ticket, ms: number, fire: () => void): void {
    const timer = setTimeout(
      () => {
        ticket.timers.delete(timer);
        fire();
      },
      Math.max(0, ms),
    );
    ticket.timers.add(timer);
  }

  private settle(ticket: Ticket, result: PreviewJobResult): void {
    if (ticket.settled) return;
    ticket.settled = true;
    for (const timer of ticket.timers) clearTimeout(timer);
    ticket.timers.clear();
    ticket.detachSignal?.();
    ticket.resolve(result);
  }

  private dequeue(ticket: Ticket): boolean {
    const index = this.queue.indexOf(ticket);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.queuedBytes -= ticket.queuedBytes;
    return true;
  }

  private cancel(ticket: Ticket): void {
    const cancelled = failed(
      ticket.job.kind,
      artifactError("cancelled", "The preview was cancelled", {
        operationId: ticket.scope.operationId,
      }),
      this.lastBrowserBuild,
    );
    if (this.dequeue(ticket)) {
      this.settle(ticket, cancelled);
      this.pump();
      return;
    }
    this.settle(ticket, cancelled);
    ticket.supervised?.cancel();
  }

  private runningFor(environmentId: string): number {
    let count = 0;
    for (const ticket of this.running) if (ticket.scope.environmentId === environmentId) count++;
    return count;
  }

  /** Fair choice: aged jobs first, then the least recently served environment, then FIFO. */
  private take(now: number): Ticket | undefined {
    let best: Ticket | undefined;
    let bestKey: number[] | undefined;
    for (const ticket of this.queue) {
      if (this.runningFor(ticket.scope.environmentId) >= this.limits.runningPerEnvironment)
        continue;
      const key = [
        now - ticket.enqueuedAt >= this.agingMs ? 0 : 1,
        this.served.get(ticket.scope.environmentId) ?? 0,
        ticket.enqueuedAt,
      ];
      if (!bestKey || compare(key, bestKey) < 0) {
        best = ticket;
        bestKey = key;
      }
    }
    if (!best) return undefined;
    this.dequeue(best);
    this.served.set(best.scope.environmentId, ++this.serveCounter);
    if (this.served.size > 256) {
      const live = new Set(
        [...this.queue, ...this.running].map((ticket) => ticket.scope.environmentId),
      );
      for (const key of Array.from(this.served.keys())) if (!live.has(key)) this.served.delete(key);
    }
    return best;
  }

  private pump(): void {
    while (!this.stopping && this.running.size < this.limits.runningGlobal) {
      const ticket = this.take(Date.now());
      if (!ticket) return;
      this.start(ticket);
    }
  }

  private launch(): WorkerLaunch | null {
    if (this.options.isolation === "container") {
      const container = this.options.container!;
      return {
        isolation: "container",
        docker: container.docker,
        image: container.image,
        ...(container.seccompProfile ? { seccompProfile: container.seccompProfile } : {}),
        user: container.user,
        ...(container.owner ? { owner: container.owner } : {}),
        memoryBytes: PREVIEW_ADMISSION_POLICY.workerMemoryBytes,
        cpus: PREVIEW_ADMISSION_POLICY.workerCpus,
        pids: PREVIEW_ADMISSION_POLICY.workerPids,
      };
    }
    const command = this.workerCommand();
    return command ? { isolation: "process", ...command } : null;
  }

  private deadlines(wallMs: number) {
    return {
      workerWallMs: wallMs,
      readinessHardMs: this.budgets.readinessMs + this.budgets.readinessHardSlackMs,
      mermaidRenderMs: this.budgets.mermaidRenderMs,
      cleanupGraceMs: this.budgets.cleanupGraceMs,
    };
  }

  private workerPackage(job: WorkerJob, wallMs: number): WorkerJobPackage {
    const executablePath = this.options.isolation === "process" ? this.executablePath() : undefined;
    return {
      v: PREVIEW_WORKER_PROTOCOL,
      job,
      limits: {
        readinessMs: this.budgets.readinessMs,
        mermaidRenderMs: this.budgets.mermaidRenderMs,
        probeStepMs: this.budgets.probeStepMs,
        workerWallMs: wallMs,
      },
      ...(executablePath ? { executablePath } : {}),
      ...(this.options.testing ? { testing: this.options.testing } : {}),
    };
  }

  private toWorkerJob(job: PreviewJob): WorkerJob {
    switch (job.kind) {
      case "html-static":
        return { kind: "html-static", html: job.html, profile: job.profile };
      case "mermaid":
        return { kind: "mermaid", source: job.source, theme: job.theme };
      case "html-interactive":
        return {
          kind: "html-interactive",
          preparedDocument: job.preparedDocument,
          contentSecurityPolicy: job.contentSecurityPolicy,
          profile: job.profile,
          probes: job.probes ?? [],
          ...(job.readinessNonce ? { readinessNonce: job.readinessNonce } : {}),
          ...(job.identity ? { identity: job.identity } : {}),
        };
      case "html-print":
        return {
          kind: "html-print",
          print: job.print,
          profile: job.profile,
          document: job.document,
        };
      case "pdf-thumbnail":
        return {
          kind: "pdf-thumbnail",
          pdfBase64: Buffer.from(job.pdf.buffer, job.pdf.byteOffset, job.pdf.byteLength).toString(
            "base64",
          ),
          maxDimension: job.maxDimension,
          maxPages: PDF_POLICY.maxPages,
        };
    }
  }

  private start(ticket: Ticket): void {
    ticket.started = true;
    this.running.add(ticket);
    const launch = this.launch();
    const remaining = Math.max(0, ticket.deadline - Date.now());
    if (!launch || ticket.settled) {
      if (!ticket.settled)
        this.settle(
          ticket,
          failed(
            ticket.job.kind,
            artifactError("renderer_unavailable", "The preview worker is unavailable"),
            this.lastBrowserBuild,
          ),
        );
      this.running.delete(ticket);
      queueMicrotask(() => this.pump());
      return;
    }
    const wallMs = Math.min(this.budgets.workerWallMs, remaining);
    const supervised = this.supervise(
      launch,
      this.workerPackage(this.toWorkerJob(ticket.job), wallMs),
      this.deadlines(wallMs),
      this.options.memoryLimitBytes ? { memoryLimitBytes: this.options.memoryLimitBytes } : {},
    );
    ticket.supervised = supervised;
    supervised.outcome
      .then((outcome) => this.complete(ticket, outcome))
      .catch(() =>
        this.settle(
          ticket,
          failed(
            ticket.job.kind,
            artifactError("renderer_unavailable", "The preview worker failed", {
              retryClass: "transient",
            }),
            this.lastBrowserBuild,
          ),
        ),
      );
    supervised.exited
      .then((report) => this.release(ticket, report.verified, supervised, report.pids))
      .catch(() => this.release(ticket, false, supervised, []));
  }

  /**
   * Frees the slot only on positive evidence that the boundary is gone. An
   * unverified exit is quarantined: the slot stays held (it counts against
   * global and per-environment capacity) while a bounded reaper re-runs
   * kill-and-verify. After the initial retry burst a single slow timer
   * keeps checking, so Docker recovery restores capacity without a restart.
   */
  private release(
    ticket: Ticket,
    verified: boolean,
    supervised: SupervisedJob,
    pids: number[],
  ): void {
    if (verified) {
      this.free(ticket, supervised, pids, true);
      return;
    }
    ticket.quarantined = true;
    this.unverifiedExits++;
    this.options.logger?.warn("[artifact-preview] worker exit unverified; slot quarantined", {
      operation: ticket.scope.operationId,
      isolation: this.options.isolation,
    });
    const delays = this.options.reaperDelaysMs ?? DEFAULT_REAPER_DELAYS_MS;
    const attempt = (index: number) => {
      if (this.stopping) return;
      // Keep one slow timer per quarantined slot after the initial burst.
      // Docker can recover without restarting this backend; only positive
      // evidence from reap may release capacity.
      const delay = index < delays.length ? delays[index]! : (this.options.reaperPollMs ?? 60_000);
      const timer = setTimeout(() => {
        this.reaperTimers.delete(timer);
        supervised
          .reap()
          .catch(() => false)
          .then((gone) => {
            if (gone) this.free(ticket, supervised, pids, true);
            else attempt(Math.min(index + 1, delays.length));
          });
      }, delay);
      timer.unref?.();
      this.reaperTimers.add(timer);
    };
    attempt(0);
  }

  private free(ticket: Ticket, supervised: SupervisedJob, pids: number[], verified: boolean): void {
    if (ticket.quarantined) {
      this.options.logger?.warn("[artifact-preview] quarantined worker confirmed gone", {
        operation: ticket.scope.operationId,
      });
    }
    ticket.quarantined = false;
    this.notifyExit(ticket, supervised, pids, verified);
    this.running.delete(ticket);
    this.pump();
  }

  private notifyExit(
    ticket: Ticket,
    supervised: SupervisedJob,
    pids: number[],
    verified: boolean,
  ): void {
    try {
      this.options.onWorkerExit?.({
        operationId: ticket.scope.operationId,
        verified,
        pids,
        browserPid: supervised.browserPid(),
        workerPid: supervised.workerPid(),
        scratchDir: supervised.scratchDir(),
      });
    } catch {
      // Observers never affect capacity accounting.
    }
  }

  private async complete(ticket: Ticket, outcome: SupervisedOutcome): Promise<void> {
    if (ticket.settled) return; // A timeout or cancellation already answered; late output is discarded.
    const kind = ticket.job.kind;
    const build = outcome.type === "result" ? outcome.result.browserBuild : this.lastBrowserBuild;
    if (outcome.type === "result" && outcome.result.browserBuild !== "unknown")
      this.lastBrowserBuild = outcome.result.browserBuild;
    const operationId = ticket.scope.operationId;
    switch (outcome.type) {
      case "timeout": {
        const message =
          outcome.phase === "mermaid-render"
            ? `Diagram parse/layout exceeded ${this.budgets.mermaidRenderMs} ms and the renderer was terminated`
            : outcome.phase === "readiness"
              ? `The document did not become ready within ${this.budgets.readinessMs} ms and the worker was terminated`
              : `The preview worker exceeded ${this.budgets.workerWallMs} ms and was terminated`;
        this.settle(
          ticket,
          failed(
            kind,
            artifactError("render_timeout", message, {
              operationId,
              resource: outcome.phase,
            }),
            build,
            {
              diagnostics: [{ severity: "error", code: "render_timeout", message }],
            },
          ),
        );
        return;
      }
      case "memory":
        this.settle(
          ticket,
          failed(
            kind,
            artifactError(
              "validation_failed",
              "The preview exceeded its memory limit and was terminated",
              { operationId, resource: "worker-memory" },
            ),
            build,
          ),
        );
        return;
      case "cancelled":
        this.settle(
          ticket,
          failed(
            kind,
            artifactError("cancelled", "The preview was cancelled", {
              operationId,
            }),
            build,
          ),
        );
        return;
      case "crashed":
        this.settle(
          ticket,
          failed(
            kind,
            artifactError("renderer_unavailable", "The preview worker stopped unexpectedly", {
              operationId,
              retryClass: "transient",
            }),
            build,
          ),
        );
        return;
      case "result":
        break;
    }
    const result = outcome.result;
    const blockedRequests = result.blockedRequests ?? {};
    const captures = decodeCaptures(result);
    const bounded = boundDiagnostics(result.diagnostics ?? []);
    if (!captures) {
      this.settle(
        ticket,
        failed(
          kind,
          artifactError("validation_failed", "The preview produced an out-of-bounds capture", {
            operationId,
            resource: "capture",
          }),
          build,
          { blockedRequests },
        ),
      );
      return;
    }
    if (!result.ok || result.kind !== kind) {
      const failure = result.failure ?? {
        code: "renderer_unavailable" as const,
        message: "The preview failed",
      };
      this.settle(
        ticket,
        failed(
          kind,
          artifactError(failure.code, failure.message, {
            operationId,
            ...(failure.resource ? { resource: failure.resource } : {}),
          }),
          build,
          {
            diagnostics: bounded.diagnostics,
            omittedDiagnostics: bounded.omitted,
            captures,
            blockedRequests,
            ...(result.probeResults ? { probeResults: result.probeResults } : {}),
          },
        ),
      );
      return;
    }
    const base = {
      browserBuild: build,
      rendererBundleHash: rendererBundleHash(kind),
      diagnostics: bounded.diagnostics,
      omittedDiagnostics: bounded.omitted,
      blockedRequests,
    };
    if (kind === "html-static") {
      if (captures.length === 0 || typeof result.effectiveHtml !== "string" || !result.sanitizer) {
        this.settle(
          ticket,
          failed(
            kind,
            artifactError("validation_failed", "The static preview returned incomplete evidence", {
              operationId,
            }),
            build,
          ),
        );
        return;
      }
      this.settle(ticket, {
        ...base,
        kind,
        ok: true,
        effectiveHtml: result.effectiveHtml,
        captures,
        sanitizer: result.sanitizer,
        elementCount: result.elementCount ?? 0,
      });
      return;
    }
    if (kind === "html-interactive") {
      const job = ticket.job as Extract<PreviewJob, { kind: "html-interactive" }>;
      const probeResults = result.probeResults ?? [];
      const allPassed =
        probeResults.length === (job.probes ?? []).length &&
        probeResults.every((probe) => probe.status === "passed");
      if (captures.length === 0 || !allPassed) {
        this.settle(
          ticket,
          failed(
            kind,
            artifactError(
              "validation_failed",
              "The interactive preview returned incomplete evidence",
              { operationId },
            ),
            build,
            {
              diagnostics: bounded.diagnostics,
              captures,
              probeResults,
              blockedRequests,
            },
          ),
        );
        return;
      }
      this.settle(ticket, {
        ...base,
        kind,
        ok: true,
        captures,
        probeResults,
        runtimeErrors: result.runtimeErrors ?? 0,
        elementCount: result.elementCount ?? 0,
      });
      return;
    }
    if (kind === "html-print") {
      this.settle(ticket, this.printResult(result, base, operationId, build));
      return;
    }
    if (kind === "pdf-thumbnail") {
      this.settle(ticket, {
        ...base,
        kind,
        ok: true,
        pageCount: typeof result.pageCount === "number" ? result.pageCount : null,
        thumbnail: result.pdfRefusal ? null : (captures[0] ?? null),
        ...(result.pdfRefusal ? { refusal: result.pdfRefusal } : {}),
      });
      return;
    }
    // Mermaid: independently verify the exact SVG bytes before anyone stores them.
    const svg = result.svg ?? "";
    const verification = await verifyMermaidSvg(svg);
    if (ticket.settled) return;
    if (!verification.ok) {
      const tooLarge =
        verification.bytes > MERMAID_POLICY.maxSvgBytes ||
        verification.elements > MERMAID_POLICY.maxSvgElements;
      this.settle(
        ticket,
        failed(
          kind,
          artifactError(
            tooLarge ? "package_size_exceeded" : "policy_denied",
            tooLarge
              ? "The sanitized SVG exceeds its limits"
              : "The sanitized SVG failed structural verification",
            { operationId, resource: "svg" },
          ),
          build,
          {
            diagnostics: verification.problems.map((problem) => ({
              severity: "error" as const,
              code: "mermaid_svg_policy",
              message: problem,
            })),
          },
        ),
      );
      return;
    }
    if ((result.edges ?? 0) > MERMAID_POLICY.maxEdges) {
      this.settle(
        ticket,
        failed(
          kind,
          artifactError(
            "package_size_exceeded",
            `The diagram has ${result.edges} edges (limit ${MERMAID_POLICY.maxEdges})`,
            { operationId, resource: "edges" },
          ),
          build,
        ),
      );
      return;
    }
    this.settle(ticket, {
      ...base,
      kind,
      ok: true,
      svg,
      diagramType: result.diagramType ?? "unknown",
      svgElements: verification.elements,
      edges: result.edges ?? 0,
    });
  }

  /** The PDF is re-checked here (signature, size, page count); the worker's claims are not trusted. */
  private printResult(
    result: WorkerResult,
    base: PreviewJobSuccessBase,
    operationId: string,
    build: string,
  ): PreviewJobResult {
    const pdf = new Uint8Array(Buffer.from(result.pdfBase64 ?? "", "base64"));
    const pages = pdf.byteLength > 0 ? countPrintedPdfPages(pdf) : 0;
    const problem =
      pdf.byteLength === 0 || !looksLikePdf(pdf)
        ? "The print job returned no PDF"
        : pdf.byteLength > PDF_POLICY.maxBytes
          ? `The PDF is ${pdf.byteLength} bytes (limit ${PDF_POLICY.maxBytes})`
          : pages < 1 || pages > PDF_POLICY.maxPages
            ? `The PDF has ${pages} pages (limit ${PDF_POLICY.maxPages})`
            : null;
    if (problem)
      return failed(
        "html-print",
        artifactError(
          pdf.byteLength > PDF_POLICY.maxBytes || pages > PDF_POLICY.maxPages
            ? "package_size_exceeded"
            : "validation_failed",
          problem,
          { operationId, resource: "pdf" },
        ),
        build,
      );
    return {
      ...base,
      kind: "html-print",
      ok: true,
      pdf,
      pageCount: pages,
      ...(result.effectiveHtmlSha256 ? { effectiveHtmlSha256: result.effectiveHtmlSha256 } : {}),
    };
  }
}

function compare(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
