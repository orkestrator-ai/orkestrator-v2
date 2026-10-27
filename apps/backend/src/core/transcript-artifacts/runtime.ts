/**
 * Builds the transcript-artifact preview infrastructure from configuration.
 *
 * Configuration (environment, read once at startup; never from artifacts):
 * - ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: `auto` (default) uses `container`
 *   when Docker answers and the worker image is present, else `process`.
 *   `container` runs the pinned worker image with `--network none` and
 *   resource limits (the OS-level boundary). `process` runs each job in a
 *   fresh, owned, killable local process tree with Chromium's sandbox, a
 *   scrubbed environment and a private HOME/TMPDIR, and browser-level
 *   network denial only (no OS network boundary), so it refuses
 *   `html-interactive` (authored JavaScript) unless
 *   ORKESTRATOR_ARTIFACT_PREVIEW_ALLOW_PROCESS_INTERACTIVE=1. `disabled`
 *   reports previews as unavailable.
 * - ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE: worker image for container mode. A
 *   content-addressed reference (`sha256:<id>` or `name@sha256:<digest>`) is
 *   used as-is; otherwise a local pin written by build.sh
 *   (`image-pin.json`) maps the tag to its image id, and without a pin the
 *   tag is used with a warning.
 * - ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker CLI (default `docker`).
 * - ORKESTRATOR_ARTIFACT_PREVIEW_SECCOMP: seccomp profile permitting
 *   Chromium's user-namespace sandbox (default: the bundled profile).
 * - ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: hosted deployments' artifact-content
 *   origin, which must be a different site from the application.
 * - ORKESTRATOR_ARTIFACT_CONTENT_PORT: content listener port (default random).
 * - ORKESTRATOR_ARTIFACT_CONTENT_BIND: interface the content listener binds,
 *   honoured only together with ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN and only
 *   for a loopback or Tailscale address (default loopback); see
 *   `resolveContentListenerConfig`.
 * - ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS: space/comma separated trusted viewer
 *   origins for `frame-ancestors`. Default: the desktop shell plus the
 *   application's actual gateway origin(s) and, in development, the Vite dev
 *   origin, supplied through `setApplicationOrigins` once the gateway binds.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ArtifactPrepareWorkerResponse,
  ArtifactWorkerPreparationStatus,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { ArtifactFailure, artifactError } from "@orkestrator/protocol/transcript-artifacts";

import type { ArtifactContentServer, InteractivePreparer, PreviewRunner } from "./contracts.js";
import { LoopbackArtifactContentServer } from "./content-server.js";
import { normalizeApplicationOrigins } from "./content-server.js";
import { DESKTOP_ARTIFACT_SHELL_ORIGIN, normalizeFrameAncestors } from "./interactive-csp.js";
import { TranscriptInteractivePreparer } from "./interactive-prepare.js";
import { TranscriptPreviewRunner, type PreviewRunnerOptions } from "./preview-runner.js";
import {
  previewContainerOwner,
  reapOrphanPreviewContainers,
  runDocker,
} from "./preview-supervisor.js";
import {
  canPrepareWorker,
  localWorkerPinFile,
  prepareWorkerImage,
  publishedMatchesContext,
  readPublishedWorkerImage,
  resolvePublishedPinFile,
  resolveWorkerBuildContext,
  type PublishedWorkerImage,
} from "./preview-worker-prepare.js";
import type {
  PreviewJob,
  PreviewJobResult,
  PreviewJobScope,
  PreviewRunnerStatus,
} from "./contracts.js";

export const DEFAULT_PREVIEW_WORKER_IMAGE = "orkestrator-artifact-preview-worker:1";
/** The Playwright base image's unprivileged user. */
export const PREVIEW_WORKER_USER = "pwuser";
/** Bound on the startup Docker check `auto` isolation makes. */
const AUTO_DETECT_TIMEOUT_MS = 5_000;
/** How long a replaced runner may finish admitted work before it is closed. */
const PREVIEW_DRAIN_MS = 60_000;
const CONTENT_ADDRESSED_IMAGE = /^(sha256:[0-9a-f]{64}|[^\s@]+@sha256:[0-9a-f]{64})$/;

export interface TranscriptArtifactRuntimeOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Trusted viewer origins; overrides ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS. */
  frameAncestors?: readonly string[];
  /**
   * Host name the application itself is served on locally. The content
   * listener uses the other loopback name so application cookies never reach it.
   */
  applicationHost?: "127.0.0.1" | "localhost";
  /**
   * The application's real page origins (gateway browser listener, Tailscale
   * Serve URL, allowed web origins). Usually supplied later through
   * `setApplicationOrigins`, once the gateway has bound.
   */
  applicationOrigins?: readonly string[];
  /** Development-only page origins (the Vite dev server). */
  developmentOrigins?: readonly string[];
  /** Image pin file candidates (tests); defaults to `resolveImagePinFile`. */
  imagePinFile?: string | null;
  /** Published (registry digest) pin file (tests); defaults to `resolvePublishedPinFile`. */
  publishedPinFile?: string | null;
  /** Worker build context (tests); defaults to `resolveWorkerBuildContext`. */
  workerBuildContext?: { context: string | null; stageScript: string | null };
  /** Test seam for worker preparation's Docker commands. */
  prepareDocker?: typeof runDocker;
  logger?: Pick<Console, "info" | "warn">;
  /** Test seams. */
  runner?: Partial<PreviewRunnerOptions>;
}

export interface TranscriptArtifactRuntime {
  /** The current runner; replaced when worker preparation switches isolation. */
  readonly runner: PreviewRunner;
  preparer: InteractivePreparer;
  contentServer: ArtifactContentServer;
  /** Effective configuration (no secrets). */
  config: {
    isolation: "process" | "container" | "disabled";
    isolationSelection: "auto" | "configured";
    /** Where authored JavaScript runs; `unavailable` when interactive previews are refused. */
    interactiveIsolation: "process" | "container" | "unavailable";
    workerImage: { reference: string; pinned: boolean } | null;
    contentOrigin: string | null;
    frameAncestors: string[];
  };
  /**
   * Supplies the application's real page origins once the gateway has bound:
   * they become the default `frame-ancestors` (with the desktop shell) and the
   * content origin is re-chosen so it never shares a site with them.
   */
  setApplicationOrigins(input: {
    application: readonly string[];
    development?: readonly string[];
  }): { available: boolean; origin: string | null; reason?: string };
  /** State of on-demand container worker preparation (for capabilities). */
  workerPreparation(): ArtifactWorkerPreparationStatus;
  /**
   * Build (or pull) the container worker image with fixed arguments, then
   * re-run isolation auto-selection: under `auto` a successful preparation
   * switches previews to container isolation without a restart. One
   * preparation runs at a time; concurrent callers share it.
   */
  prepareWorker(): Promise<ArtifactPrepareWorkerResponse>;
  /** Observes runner replacement (the service attaches the new runner). */
  onRunnerChange(listener: (runner: PreviewRunner) => void): () => void;
  close(): Promise<void>;
}

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function resolveSeccompProfile(baseDir = moduleDirectory()): string | undefined {
  return [
    path.join(baseDir, "artifact-runtime", "seccomp_profile.json"),
    path.join(baseDir, "seccomp_profile.json"),
    path.resolve(baseDir, "../../../../../docker/artifact-preview-worker/seccomp_profile.json"),
  ].find((candidate) => existsSync(candidate));
}

/**
 * Local image pin: written by worker preparation under the data directory,
 * or by docker/artifact-preview-worker/build.sh in a source checkout.
 */
export function resolveImagePinFile(
  baseDir = moduleDirectory(),
  dataDir?: string,
): string | undefined {
  return [
    ...(dataDir ? [localWorkerPinFile(dataDir)] : []),
    path.join(baseDir, "artifact-runtime", "preview-worker-image-pin.json"),
    path.resolve(baseDir, "../../../../../docker/artifact-preview-worker/image-pin.json"),
  ].find((candidate) => existsSync(candidate));
}

/**
 * The image reference container jobs run. A content-addressed reference is
 * used as-is. A tag is replaced by the image id recorded by build.sh when
 * that exact id is present locally; otherwise the tag is used and a warning
 * explains that the image is not pinned.
 */
export async function resolveWorkerImage(
  configured: string,
  docker: string,
  pinFile: string | null | undefined,
): Promise<{ reference: string; pinned: boolean; warning?: string }> {
  if (CONTENT_ADDRESSED_IMAGE.test(configured)) return { reference: configured, pinned: true };
  let pin: { tag?: unknown; id?: unknown } | null = null;
  if (pinFile) {
    try {
      pin = JSON.parse(readFileSync(pinFile, "utf8")) as { tag?: unknown; id?: unknown };
    } catch {
      pin = null;
    }
  }
  if (
    pin &&
    pin.tag === configured &&
    typeof pin.id === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(pin.id)
  ) {
    const inspect = await runDocker(
      docker,
      ["image", "inspect", "--format", "{{.Id}}", pin.id],
      AUTO_DETECT_TIMEOUT_MS,
    );
    if (inspect.code === 0 && inspect.stdout.trim() === pin.id)
      return { reference: pin.id, pinned: true };
    return {
      reference: configured,
      pinned: false,
      warning: `pinned preview worker image id for ${configured} is not present; using the tag unpinned (rebuild with docker/artifact-preview-worker/build.sh)`,
    };
  }
  return {
    reference: configured,
    pinned: false,
    warning: `preview worker image ${configured} has no digest pin; using the tag (set ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE to name@sha256:<digest> or rebuild with build.sh to pin it)`,
  };
}

/** Loopback or Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) interface literal. */
function isPermittedContentBind(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "127.0.0.1" || value === "::1" || value === "localhost") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    return octets[0] === 127 || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127);
  }
  return /^fd7a:115c:a1e0:[0-9a-f:]*$/.test(value);
}

export interface ContentListenerConfig {
  /** Interface the listener binds. */
  bindHost: string;
  /** 0 = an ephemeral port. */
  port: number;
  publicOrigin?: string;
  /** Content-free configuration warnings (ignored or refused settings). */
  warnings: string[];
}

/**
 * Validates the content listener configuration. The listener stays on
 * loopback unless a hosted content origin is configured
 * (`ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN`, a different site from the
 * application, typically a TLS terminator such as a reverse proxy on the
 * tailnet forwarding to `ORKESTRATOR_ARTIFACT_CONTENT_PORT`); only then may
 * `ORKESTRATOR_ARTIFACT_CONTENT_BIND` move it to a Tailscale (or another
 * loopback) address. Wildcard and public interfaces are refused and the
 * listener stays on loopback. An origin that is not a bare http(s) origin
 * throws, refusing the configuration before anything binds.
 */
export function resolveContentListenerConfig(env: NodeJS.ProcessEnv): ContentListenerConfig {
  const warnings: string[] = [];
  const portSetting = env.ORKESTRATOR_ARTIFACT_CONTENT_PORT?.trim();
  let port = 0;
  if (portSetting) {
    const value = /^\d{1,5}$/.test(portSetting) ? Number(portSetting) : NaN;
    if (Number.isInteger(value) && value >= 1 && value <= 65_535) port = value;
    else
      warnings.push("ORKESTRATOR_ARTIFACT_CONTENT_PORT is not a port number; using a random port");
  }
  const originSetting = env.ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN?.trim() || undefined;
  let publicOrigin: string | undefined;
  if (originSetting) {
    const url = new URL(originSetting);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN must be an http(s) origin");
    if (
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      /\/./.test(originSetting.replace(/^[a-z]+:\/\//i, ""))
    )
      throw new Error("ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN must be a bare origin (no path)");
    publicOrigin = originSetting.replace(/\/$/, "");
    if (port === 0)
      warnings.push(
        "ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN is set without ORKESTRATOR_ARTIFACT_CONTENT_PORT; the listener port changes on every start",
      );
  }
  const bindSetting = env.ORKESTRATOR_ARTIFACT_CONTENT_BIND?.trim();
  let bindHost = "127.0.0.1";
  if (bindSetting) {
    const literal = bindSetting.replace(/^\[|\]$/g, "");
    if (!publicOrigin)
      warnings.push(
        "ORKESTRATOR_ARTIFACT_CONTENT_BIND is ignored without ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN; the content listener stays on loopback",
      );
    else if (!isPermittedContentBind(literal))
      warnings.push(
        "ORKESTRATOR_ARTIFACT_CONTENT_BIND must be a loopback or Tailscale address; the content listener stays on loopback",
      );
    else bindHost = literal === "localhost" ? "127.0.0.1" : literal;
  }
  return { bindHost, port, ...(publicOrigin ? { publicOrigin } : {}), warnings };
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** A runner that reports the capability as unavailable without ever starting work. */
class DisabledPreviewRunner implements PreviewRunner {
  constructor(private readonly reason: string) {}
  status(): PreviewRunnerStatus {
    return {
      available: false,
      isolation: "unavailable",
      browserBuild: "unknown",
      reason: this.reason,
      interactiveIsolation: "unavailable",
      interactiveReason: this.reason,
      isolationSelection: "configured",
    };
  }
  probe(): Promise<PreviewRunnerStatus> {
    return Promise.resolve(this.status());
  }
  run(_job: PreviewJob, _scope: PreviewJobScope, _signal: AbortSignal): Promise<PreviewJobResult> {
    return Promise.reject(new ArtifactFailure(artifactError("renderer_unavailable", this.reason)));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export async function createTranscriptArtifactRuntime(
  options: TranscriptArtifactRuntimeOptions,
): Promise<TranscriptArtifactRuntime> {
  const env = options.env ?? process.env;
  const explicitAncestors =
    options.frameAncestors ??
    (parseList(env.ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS).length
      ? parseList(env.ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS)
      : null);
  // The desktop trusted viewer shell is always a permitted ancestor; `'none'` would keep artifacts from going live.
  const ancestorsFor = (application: readonly string[], development: readonly string[]) => {
    // Gateway rules are broader than concrete CSP origins (wildcards, for
    // example). An unsupported inferred ancestor must not break startup.
    const inferred = [
      ...normalizeApplicationOrigins(application),
      ...normalizeApplicationOrigins(development),
    ];
    const accepted = inferred.filter((origin) => {
      try {
        normalizeFrameAncestors([origin]);
        return true;
      } catch {
        options.logger?.warn(
          "[transcript-artifacts] ignored unsupported application frame ancestor",
        );
        return false;
      }
    });
    return normalizeFrameAncestors([
      DESKTOP_ARTIFACT_SHELL_ORIGIN,
      ...(explicitAncestors ?? accepted),
    ]);
  };
  let frameAncestors = ancestorsFor(
    options.applicationOrigins ?? [],
    options.developmentOrigins ?? [],
  );
  const isolationSetting = (env.ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION ?? "auto")
    .trim()
    .toLowerCase();
  const isolationSelection: "auto" | "configured" =
    isolationSetting === "container" ||
    isolationSetting === "process" ||
    isolationSetting === "disabled"
      ? "configured"
      : "auto";
  const allowProcessInteractive = /^(1|true|yes)$/i.test(
    env.ORKESTRATOR_ARTIFACT_PREVIEW_ALLOW_PROCESS_INTERACTIVE?.trim() ?? "",
  );
  const docker = env.ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER?.trim() || "docker";
  const explicitImage = env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE?.trim() || undefined;
  const published: PublishedWorkerImage | null = readPublishedWorkerImage(
    options.publishedPinFile === undefined ? resolvePublishedPinFile() : options.publishedPinFile,
  );
  const buildContext = options.workerBuildContext ?? resolveWorkerBuildContext();
  const pinFile = () =>
    options.imagePinFile === undefined
      ? resolveImagePinFile(undefined, options.dataDir)
      : options.imagePinFile;
  const inspectImage = (reference: string) =>
    runDocker(
      docker,
      ["image", "inspect", "--format", "{{.Id}}", reference],
      AUTO_DETECT_TIMEOUT_MS,
    ).catch(() => ({ code: null, stdout: "" }));

  // A published, digest-pinned worker that is present locally is preferred
  // over the local tag when it was built from the context this backend ships
  // (a pin left over from another context is ignored); an explicit
  // ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE wins.
  let configuredImage = explicitImage ?? DEFAULT_PREVIEW_WORKER_IMAGE;
  let dockerAnswered: boolean | null = null;
  if (
    !explicitImage &&
    published &&
    isolationSetting !== "process" &&
    isolationSetting !== "disabled"
  ) {
    const present = await inspectImage(published.reference);
    dockerAnswered = present.code !== null;
    if (
      present.code === 0 &&
      buildContext.context &&
      (await publishedMatchesContext(published, buildContext.context))
    )
      configuredImage = published.reference;
  }

  let isolation: "process" | "container" | "disabled";
  if (isolationSelection === "configured") {
    isolation = isolationSetting as "process" | "container" | "disabled";
  } else {
    // auto: the container worker when Docker answers and the image is present.
    const inspect = await inspectImage(configuredImage);
    dockerAnswered = inspect.code !== null;
    isolation = inspect.code === 0 ? "container" : "process";
    options.logger?.info?.(`[transcript-artifacts] preview isolation auto-selected: ${isolation}`);
  }

  // The prepared policy carries only the stable configured ancestors, so
  // preparation stays deterministic across restarts; the content server
  // re-applies the current ancestors to every document it serves.
  const preparer = new TranscriptInteractivePreparer({
    frameAncestors: normalizeFrameAncestors([
      DESKTOP_ARTIFACT_SHELL_ORIGIN,
      ...(explicitAncestors ?? []),
    ]),
  });

  const listener = resolveContentListenerConfig(env);
  for (const warning of listener.warnings)
    options.logger?.warn(`[transcript-artifacts] ${warning}`);
  const contentServer = await LoopbackArtifactContentServer.start({
    frameAncestors,
    port: listener.port,
    bindHost: listener.bindHost,
    loopbackHostname: options.applicationHost === "localhost" ? "127.0.0.1" : "localhost",
    applicationOrigins: [
      ...(options.applicationOrigins ?? []),
      ...(options.developmentOrigins ?? []),
    ],
    ...(listener.publicOrigin ? { publicOrigin: listener.publicOrigin } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  const owner = previewContainerOwner(options.dataDir);
  const containerRunner = (image: { reference: string; pinned: boolean }) => {
    const seccompProfile =
      env.ORKESTRATOR_ARTIFACT_PREVIEW_SECCOMP?.trim() || resolveSeccompProfile();
    return new TranscriptPreviewRunner({
      isolation: "container",
      isolationSelection,
      container: {
        docker,
        owner,
        image: image.reference,
        pinned: image.pinned,
        ...(seccompProfile ? { seccompProfile } : {}),
        user: PREVIEW_WORKER_USER,
      },
      ...(options.logger ? { logger: options.logger } : {}),
      ...options.runner,
    });
  };

  let runner: PreviewRunner;
  let workerImage: { reference: string; pinned: boolean } | null = null;
  if (isolation === "disabled") {
    runner = new DisabledPreviewRunner(
      "HTML previews are disabled on this host (ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION=disabled)",
    );
  } else if (isolation === "container") {
    // Startup recovery: a crash can leave this backend's workers behind.
    const reaped = await reapOrphanPreviewContainers(docker, owner).catch(() => 0);
    if (reaped > 0)
      options.logger?.warn(`[transcript-artifacts] removed ${reaped} orphaned preview worker(s)`);
    const image = await resolveWorkerImage(configuredImage, docker, pinFile());
    if (image.warning) options.logger?.warn(`[transcript-artifacts] ${image.warning}`);
    workerImage = { reference: image.reference, pinned: image.pinned };
    runner = containerRunner(workerImage);
  } else {
    runner = new TranscriptPreviewRunner({
      isolation: "process",
      isolationSelection,
      allowProcessInteractive,
      ...(options.logger ? { logger: options.logger } : {}),
      ...options.runner,
    });
  }

  const interactiveIsolationOf = (
    mode: "process" | "container" | "disabled",
  ): "process" | "container" | "unavailable" =>
    mode === "container"
      ? "container"
      : mode === "process" && allowProcessInteractive
        ? "process"
        : "unavailable";
  if (isolation === "process" && !allowProcessInteractive)
    options.logger?.warn(
      "[transcript-artifacts] interactive HTML previews are off: process isolation has no OS network boundary",
    );

  const config: TranscriptArtifactRuntime["config"] = {
    isolation,
    isolationSelection,
    interactiveIsolation: interactiveIsolationOf(isolation),
    workerImage,
    contentOrigin: contentServer.origin(),
    frameAncestors,
  };

  // --- On-demand worker preparation --------------------------------------
  const runnerListeners = new Set<(runner: PreviewRunner) => void>();
  const retiring = new Set<Promise<void>>();
  let preparation: Promise<ArtifactPrepareWorkerResponse> | null = null;
  let preparationState: ArtifactWorkerPreparationStatus = {
    available: false,
    state: "idle",
    method: null,
  };
  const preparationAvailability = (): { available: boolean; reason?: string } => {
    if (isolationSetting === "disabled")
      return { available: false, reason: "Previews are disabled on this host" };
    if (explicitImage)
      return {
        available: false,
        reason:
          "ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE names the worker image; prepare it with Docker directly",
      };
    if (!canPrepareWorker({ buildContext }))
      return {
        available: false,
        reason: "No preview worker build context ships with this installation",
      };
    if (dockerAnswered === false)
      return { available: false, reason: "Docker is not installed or could not be started" };
    return { available: true };
  };

  /** Retire a replaced runner once its in-flight work has drained (bounded). */
  const retire = (old: PreviewRunner) => {
    const drained = (async () => {
      const stats = (old as Partial<TranscriptPreviewRunner>).stats?.bind(old);
      const until = Date.now() + PREVIEW_DRAIN_MS;
      while (stats && Date.now() < until) {
        const { queued, running } = stats();
        if (queued === 0 && running === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await old.close().catch(() => undefined);
    })();
    retiring.add(drained);
    void drained.finally(() => retiring.delete(drained));
  };

  const replaceRunner = (next: PreviewRunner) => {
    const old = runner;
    runner = next;
    for (const listener of runnerListeners) {
      try {
        listener(next);
      } catch {
        // Observers never block the switch.
      }
    }
    retire(old);
    void next.probe(true).catch(() => undefined);
  };

  const prepareWorker = async (): Promise<ArtifactPrepareWorkerResponse> => {
    const availability = preparationAvailability();
    const respond = (): ArtifactPrepareWorkerResponse => {
      const status = runner.status();
      return {
        ...workerPreparationStatus(),
        isolation: status.isolation,
        interactiveIsolation: status.interactiveIsolation ?? "unavailable",
      };
    };
    if (!availability.available) {
      preparationState = {
        ...preparationState,
        state: "failed",
        reason: availability.reason ?? "unavailable",
        finishedAt: new Date().toISOString(),
      };
      return respond();
    }
    preparationState = {
      available: true,
      state: "preparing",
      method: null,
      startedAt: new Date().toISOString(),
    };
    options.logger?.info?.("[transcript-artifacts] preparing the container preview worker");
    const outcome = await prepareWorkerImage({
      docker,
      tag: DEFAULT_PREVIEW_WORKER_IMAGE,
      dataDir: options.dataDir,
      published,
      buildContext,
      ...(options.prepareDocker ? { runDocker: options.prepareDocker } : {}),
    });
    const finishedAt = new Date().toISOString();
    if (outcome.publishedSkipped)
      options.logger?.info?.(
        `[transcript-artifacts] published preview worker image not used (${outcome.publishedSkipped}); building locally`,
      );
    if (!outcome.ok) {
      preparationState = {
        available: true,
        state: "failed",
        method: outcome.method,
        reason: outcome.reason,
        startedAt: preparationState.startedAt,
        finishedAt,
      };
      options.logger?.warn(
        `[transcript-artifacts] preview worker preparation failed: ${outcome.reason}`,
      );
      return respond();
    }
    dockerAnswered = true;
    preparationState = {
      available: true,
      state: "ready",
      method: outcome.method,
      image: outcome.reference,
      startedAt: preparationState.startedAt,
      finishedAt,
    };
    options.logger?.info?.(
      `[transcript-artifacts] preview worker prepared (${outcome.method}); re-selecting isolation`,
    );
    // Re-run selection: `auto` (and an explicit `container` whose image was
    // missing) now runs the prepared, content-addressed image. An explicit
    // `process` configuration is left alone.
    if (isolationSetting !== "process") {
      const image = { reference: outcome.reference, pinned: true };
      replaceRunner(containerRunner(image));
      config.isolation = "container";
      config.interactiveIsolation = "container";
      config.workerImage = image;
    }
    return respond();
  };

  const workerPreparationStatus = (): ArtifactWorkerPreparationStatus => {
    const availability = preparationAvailability();
    return {
      ...preparationState,
      available: availability.available,
      ...(preparationState.state === "idle" && availability.reason
        ? { reason: availability.reason }
        : {}),
    };
  };

  return {
    get runner() {
      return runner;
    },
    preparer,
    contentServer,
    config,
    setApplicationOrigins(input) {
      const development = input.development ?? [];
      frameAncestors = ancestorsFor(input.application, development);
      contentServer.setFrameAncestors(frameAncestors);
      const status = contentServer.configureApplicationOrigins([
        ...input.application,
        ...development,
      ]);
      config.frameAncestors = frameAncestors;
      config.contentOrigin = contentServer.origin();
      return status;
    },
    workerPreparation: workerPreparationStatus,
    prepareWorker() {
      preparation ??= prepareWorker().finally(() => {
        preparation = null;
      });
      return preparation;
    },
    onRunnerChange(listener) {
      runnerListeners.add(listener);
      return () => runnerListeners.delete(listener);
    },
    async close() {
      await Promise.allSettled([runner.close(), contentServer.close(), ...retiring]);
    },
  };
}
