import { DESIGN_MAX_DOCUMENT_BYTES, type DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type {
  DesignCapabilities,
  DesignLibraryPage,
  DesignLibraryQuery,
  DesignOperationInput,
  DesignOperationStatus,
  DesignPreconditions,
  DesignReadiness,
  DesignRendererState,
} from "@orkestrator/protocol/design-operations";
import { invoke } from "@/lib/native/backend";
import {
  classifyTransportError,
  DesignClientError,
  designAction,
  designApi,
  failureOf,
  getCapabilities,
} from "./design-client";
import type { DesignPlacement } from "./design-open";

// ---------------------------------------------------------------------------
// New design inputs
// ---------------------------------------------------------------------------

export const DESIGN_NAME_MAX = 120;
export const DESIGN_BRIEF_MAX = 20_000;

export type DesignAgent = "claude" | "codex";
export const DESIGN_AGENTS: readonly DesignAgent[] = ["claude", "codex"];

/** Returns a user-facing problem with the name, or null when it is usable. */
export function validateDesignName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for the design.";
  if (trimmed.length > DESIGN_NAME_MAX) return `Use at most ${DESIGN_NAME_MAX} characters.`;
  return null;
}

export type DesignFramePresetId = "none" | "desktop" | "mobile";

export const DESIGN_FRAME_PRESETS: Record<
  DesignFramePresetId,
  { label: string; width?: number; height?: number }
> = {
  none: { label: "No initial frame" },
  desktop: { label: "Desktop 1440×900", width: 1440, height: 900 },
  mobile: { label: "Mobile 390×844", width: 390, height: 844 },
};

export const DESIGN_BRIEF_EXAMPLES = [
  "Review this repository and mock up a cleaner settings page.",
  "Design an onboarding flow for first-time users in three screens.",
  "Explore two alternative layouts for the dashboard header.",
];

export const DESIGN_CONTENT_EXPLANATION =
  "Designs are static HTML/CSS with embedded resources (inline CSS, data-URL images and fonts). Authored scripts and remote resources are blocked.";

export function buildDesignAgentPrompt(canvasId: string, brief: string): string {
  return [
    `Use the orkestrator-design MCP server for this design workspace. Canvas ID: ${canvasId}.`,
    "Start with get_canvas_summary, then get_frame for the frames you need; avoid get_canvas on large designs because it returns every frame's HTML.",
    "Review the current repository, then build HTML/CSS mockups in this canvas. Designs must be self-contained, with embedded CSS and data-URL images/fonts; authored scripts and remote resources are blocked.",
    'Pass response:"compact" on mutations so they do not echo HTML. Edit with the frame revision you last read; on a revision conflict, re-read the frame and reapply your change rather than retrying blindly.',
    "Use capture_frame to review your work visually.",
    "To save the design into the repository, use save_canvas (not export_canvas plus file tools). Never overwrite an existing file unless you pass the replaceFingerprint reported for it; otherwise choose a new file path.",
    "",
    brief.trim() || "Review this repository and propose an initial design mockup.",
  ].join("\n");
}

function initialFrameHtml(): string {
  return '<main style="min-height:100vh;margin:0;background:#ffffff"></main>';
}

// ---------------------------------------------------------------------------
// Create transaction
// ---------------------------------------------------------------------------

export type DesignLaunchStage =
  | "create-document"
  | "initial-frame"
  | "allocate-layout"
  | "create-agent"
  | "link-session"
  | "done";

export class DesignLaunchError extends Error {
  constructor(
    message: string,
    readonly stage: DesignLaunchStage,
    /** The canvas this attempt created, if it still exists. */
    readonly canvas: DesignCanvas | null,
    /**
     * True when an agent may already be working on the canvas: the canvas is
     * kept and the user is offered recovery instead of a rollback.
     */
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "DesignLaunchError";
  }
}

export interface DesignLaunchOptions {
  name: string;
  /** null creates a blank canvas without reserving a conversation. */
  agent: DesignAgent | null;
  brief: string;
  framePreset: DesignFramePresetId;
  placement: DesignPlacement;
  canvasTabId: string;
  agentTabId: string;
  createCanvas: (name: string) => Promise<DesignCanvas>;
  createFrame: (
    canvas: DesignCanvas,
    frame: { name: string; width: number; height: number; html: string },
  ) => Promise<{ canvasRevision: number }>;
  openCanvas: (canvasId: string, tabId: string, placement: DesignPlacement) => boolean;
  createAgentTab: (agent: DesignAgent, tabId: string, initialPrompt: string) => boolean;
  hasTab: (tabId: string) => boolean;
  removeTab: (tabId: string) => void;
  deleteCanvas: (canvasId: string, revision: number) => Promise<unknown>;
  /** Best-effort v2 association; omitted on old backends. */
  linkSession?: (canvasId: string, agentTabId: string, platform: DesignAgent) => Promise<unknown>;
  onStage?: (stage: DesignLaunchStage) => void;
}

export interface DesignLaunchResult {
  canvas: DesignCanvas;
  /** Set when the best-effort session link failed; the workspace still works. */
  linkWarning?: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Create → allocate layout → create agent tab → link session. The agent tab
 * dispatches the initial prompt itself once mounted, so no prompt is sent
 * before the canvas and its tab exist.
 *
 * Before the agent tab exists, a failure removes exactly what this attempt
 * created (its canvas tab and canvas). Once the agent tab exists the prompt
 * may already be running, so the canvas is kept and the error is recoverable.
 */
export async function launchDesignWorkspace(
  options: DesignLaunchOptions,
): Promise<DesignLaunchResult> {
  let stage: DesignLaunchStage = "create-document";
  const enter = (next: DesignLaunchStage) => {
    stage = next;
    options.onStage?.(next);
  };
  enter("create-document");
  let canvas: DesignCanvas;
  try {
    canvas = await options.createCanvas(options.name.trim());
  } catch (error) {
    throw new DesignLaunchError(message(error), stage, null, false);
  }
  let revision = canvas.revision;
  let agentTabCreated = false;
  try {
    const preset = DESIGN_FRAME_PRESETS[options.framePreset];
    if (preset.width && preset.height) {
      enter("initial-frame");
      const created = await options.createFrame(canvas, {
        name: options.framePreset === "mobile" ? "Mobile" : "Desktop",
        width: preset.width,
        height: preset.height,
        html: initialFrameHtml(),
      });
      revision = created.canvasRevision;
    }
    enter("allocate-layout");
    if (!options.openCanvas(canvas.id, options.canvasTabId, options.placement))
      throw new Error("Could not open a tab for the design canvas.");
    if (options.agent) {
      enter("create-agent");
      let created = false;
      try {
        created = options.createAgentTab(
          options.agent,
          options.agentTabId,
          buildDesignAgentPrompt(canvas.id, options.brief),
        );
      } finally {
        agentTabCreated = created || options.hasTab(options.agentTabId);
      }
      if (!agentTabCreated) throw new Error("Could not open the design agent tab.");
    }
  } catch (error) {
    if (agentTabCreated)
      throw new DesignLaunchError(
        `Your design was created, but the workspace did not finish opening: ${message(error)}`,
        stage,
        canvas,
        true,
      );
    // Roll back only what this attempt created.
    if (options.hasTab(options.canvasTabId)) options.removeTab(options.canvasTabId);
    const deleted = await options.deleteCanvas(canvas.id, revision).then(
      () => true,
      () => false,
    );
    throw new DesignLaunchError(
      deleted
        ? message(error)
        : `${message(error)} The new design could not be removed and remains in Open.`,
      stage,
      deleted ? null : canvas,
      false,
    );
  }
  let linkWarning: string | undefined;
  if (options.agent && options.linkSession) {
    enter("link-session");
    try {
      await options.linkSession(canvas.id, options.agentTabId, options.agent);
    } catch (error) {
      linkWarning = `The agent conversation could not be linked to the design: ${message(error)}`;
    }
  }
  enter("done");
  return { canvas, ...(linkWarning ? { linkWarning } : {}) };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface DesignImportFile {
  name: string;
  size: number;
  type: string;
  text: () => Promise<string>;
}

/** Validates type, size and header before anything is sent to the backend. */
export async function readDesignImport(file: DesignImportFile): Promise<string> {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".orkdes") && !lower.endsWith(".json"))
    throw new Error("Choose an .orkdes design file.");
  if (file.type && !/json|octet-stream/i.test(file.type))
    throw new Error("Choose an .orkdes design file.");
  if (file.size > DESIGN_MAX_DOCUMENT_BYTES) throw new Error("Design file exceeds 4 MiB.");
  const text = await file.text();
  if (new TextEncoder().encode(text).byteLength > DESIGN_MAX_DOCUMENT_BYTES)
    throw new Error("Design file exceeds 4 MiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This is not a valid .orkdes design file.");
  }
  const header = parsed as { format?: unknown; version?: unknown } | null;
  if (!header || typeof header !== "object" || header.format !== "orkdes")
    throw new Error("This is not an .orkdes design file.");
  if (header.version !== 1)
    throw new Error(`Design file version ${String(header.version)} is not supported.`);
  return text;
}

export interface DesignImportResult {
  canvas: DesignCanvas;
  opened: boolean;
  openError?: string;
}

/**
 * Imports a document (the backend assigns fresh identities and never copies
 * session/export links) and opens it. An open failure keeps the import: the
 * design is listed in Open and can be reopened once there is room.
 */
export async function importAndOpenDesign(options: {
  document: string;
  importCanvas: (document: string) => Promise<DesignCanvas>;
  openCanvas: (canvasId: string) => string | null;
}): Promise<DesignImportResult> {
  const canvas = await options.importCanvas(options.document);
  const openError = options.openCanvas(canvas.id);
  return openError ? { canvas, opened: false, openError } : { canvas, opened: true };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type DesignRendererViewState = DesignRendererState;

export interface DesignReadinessView {
  backend: { state: "connected" | "disconnected" | "unauthorized" | "failed"; message?: string };
  /** null capabilities with protocol "v1" means an old backend. */
  protocol: "v2" | "v1" | "unknown";
  capabilities: DesignCapabilities | null;
  storage: {
    state: "available" | "unavailable" | "unknown";
    canvases?: number;
    limit?: number;
    message?: string;
  };
  renderer: {
    state: DesignRendererViewState;
    ready: boolean;
    message: string;
    queued?: number;
    running?: number;
    executableConfigured?: boolean;
  };
}

export interface DesignReadinessDeps {
  capabilities: () => Promise<DesignCapabilities | null>;
  readiness: (probe: boolean) => Promise<DesignReadiness>;
  legacyStatus: () => Promise<{ ready: boolean; error?: string }>;
}

const defaultReadinessDeps: DesignReadinessDeps = {
  capabilities: () => getCapabilities(),
  readiness: (probe) => designApi.readiness(probe),
  legacyStatus: () => invoke<{ ready: boolean; error?: string }>("design_status"),
};

const UNKNOWN_RENDERER = {
  state: "unknown",
  ready: false,
  message: "Renderer not checked.",
} as const;

function legacyRendererState(error: string | undefined): DesignRendererState {
  return error && /requires? chromium|needs chromium|not found|no such file/i.test(error)
    ? "missing-executable"
    : "launch-failed";
}

/**
 * Loads separate backend, storage and renderer facts. `probe` asks a v2
 * backend to actually check the renderer (it caches health for 60s); call it
 * when the dialog opens and on explicit Retry only.
 */
export async function loadDesignReadiness(
  probe: boolean,
  deps: DesignReadinessDeps = defaultReadinessDeps,
): Promise<DesignReadinessView> {
  let capabilities: DesignCapabilities | null;
  try {
    capabilities = await deps.capabilities();
  } catch (error) {
    const kind = classifyTransportError(error);
    return {
      backend: {
        state: kind === "unsupported" ? "failed" : kind,
        message: failureOf(error).message,
      },
      protocol: "unknown",
      capabilities: null,
      storage: { state: "unknown" },
      renderer: { ...UNKNOWN_RENDERER },
    };
  }
  if (capabilities === null) {
    try {
      const status = await deps.legacyStatus();
      return {
        backend: { state: "connected" },
        protocol: "v1",
        capabilities: null,
        storage: { state: "unknown", message: "This backend does not report storage health." },
        renderer: status.ready
          ? { state: "ready", ready: true, message: "Renderer ready." }
          : {
              state: legacyRendererState(status.error),
              ready: false,
              message: status.error ?? "Renderer unavailable.",
            },
      };
    } catch (error) {
      const kind = classifyTransportError(error);
      return {
        backend: {
          state: kind === "unsupported" ? "failed" : kind,
          message: failureOf(error).message,
        },
        protocol: "v1",
        capabilities: null,
        storage: { state: "unknown" },
        renderer: { ...UNKNOWN_RENDERER },
      };
    }
  }
  try {
    const readiness = await deps.readiness(probe);
    return {
      backend: { state: "connected" },
      protocol: "v2",
      capabilities: readiness.capabilities ?? capabilities,
      storage: {
        state: readiness.storage.available ? "available" : "unavailable",
        canvases: readiness.storage.canvases,
        limit: readiness.storage.limit,
        ...(readiness.storage.message ? { message: readiness.storage.message } : {}),
      },
      renderer: {
        state: readiness.renderer.state,
        ready: readiness.renderer.ready,
        message: readiness.renderer.message,
        queued: readiness.renderer.queued,
        running: readiness.renderer.running,
        executableConfigured: readiness.renderer.executableConfigured,
      },
    };
  } catch (error) {
    const failure = failureOf(error);
    if (failure.code === "disconnected" || failure.code === "forbidden")
      return {
        backend: {
          state: failure.code === "forbidden" ? "unauthorized" : "disconnected",
          message: failure.message,
        },
        protocol: "v2",
        capabilities,
        storage: { state: "unknown" },
        renderer: { ...UNKNOWN_RENDERER },
      };
    return {
      backend: { state: "connected" },
      protocol: "v2",
      capabilities,
      storage: { state: "unavailable", message: failure.message },
      renderer: { ...UNKNOWN_RENDERER },
    };
  }
}

/** The renderer is known to be unusable (not merely busy or unchecked). */
export function rendererUnavailable(view: DesignReadinessView | null): boolean {
  return (
    view !== null &&
    (view.renderer.state === "missing-executable" || view.renderer.state === "launch-failed")
  );
}

// ---------------------------------------------------------------------------
// Library data
// ---------------------------------------------------------------------------

/** Library entry; `legacy` entries come from an old backend with names only. */
export type DesignLibraryItem = DesignLibraryPage["entries"][number] & { legacy?: true };

export interface DesignLibraryResult extends Omit<DesignLibraryPage, "entries"> {
  entries: DesignLibraryItem[];
}

/** Builds a library page from an old backend's `list_canvases`. */
export async function legacyLibraryPage(
  environmentId: string,
  query: DesignLibraryQuery,
  list: () => Promise<Array<{ id: string; name: string; revision?: number }>> = () =>
    designAction(environmentId, "list_canvases"),
): Promise<DesignLibraryResult> {
  const all = await list();
  const search = query.search?.trim().toLowerCase();
  const matching = (query.filter === "deleted" ? [] : all).filter(
    (entry) => !search || entry.name.toLowerCase().includes(search),
  );
  if (query.sort === "name") matching.sort((a, b) => a.name.localeCompare(b.name));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  const page = matching.slice(offset, offset + limit);
  return {
    entries: page.map((entry) => ({
      id: entry.id,
      name: entry.name,
      revision: entry.revision ?? 0,
      modifiedAt: "",
      createdAt: "",
      frameCount: 0,
      state: "live",
      validation: { invalid: 0, unvalidated: 0 },
      legacy: true,
    })),
    total: matching.length,
    ...(offset + limit < matching.length ? { nextOffset: offset + limit } : {}),
    quota: {
      live: all.length,
      liveLimit: 256,
      deleted: 0,
      deletedLimit: 0,
      deletedBytes: 0,
      deletedBytesLimit: 0,
    },
  };
}

/**
 * Runs one lifecycle operation through prepare + execute and resolves only
 * when it committed (or was a no-op). Anything else is a typed failure.
 */
export async function runDesignLifecycle(
  environmentId: string,
  canvasId: string,
  input: DesignOperationInput,
  preconditions: DesignPreconditions,
  api: Pick<typeof designApi, "prepare" | "execute"> = designApi,
): Promise<DesignOperationStatus> {
  const prepared = await api.prepare(environmentId, {
    canvasId,
    input,
    preconditions,
    correlationId: crypto.randomUUID(),
  });
  const status = await api.execute(environmentId, prepared.canvasId, prepared.token, 10_000);
  if (status.state === "committed" || status.state === "no-op") return status;
  if (status.failure) throw new DesignClientError(status.failure);
  throw new DesignClientError({
    code: "unknown-outcome",
    message:
      status.state === "executing" || status.state === "prepared"
        ? "The action is still running. Refresh the list to see its result."
        : `The action did not complete (${status.state}).`,
    retry: "review",
  });
}
