/**
 * Mermaid rendering for transcript fences.
 *
 * Layout runs in the backend's supervised renderer (a separate, killable
 * process with its own deadline), never in this renderer thread. This module
 * adds the client-side guarantees around it:
 *
 *  - the 32 KiB source limit is checked before any request is made;
 *  - requests go through the shared scheduler's single "diagram" lane, so at
 *    most one render is in flight and the queue is bounded;
 *  - results are cached by conversation scope (backend, environment,
 *    session), source hash, theme and renderer version — identical source in
 *    two environments or backends never shares an entry; a
 *    deterministic failure (syntax error, limit, timeout) is cached too, so the
 *    same source is never retried automatically;
 *  - the returned SVG is sanitized again here, with element and byte limits
 *    counted before and after, before it can reach the DOM or an export.
 */
import { MERMAID_POLICY, utf8ByteLength } from "@orkestrator/protocol/rich-content-policy";
import type {
  MermaidRenderRequest,
  MermaidRenderResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { renderMermaidDiagram } from "@/lib/backend/transcript-artifacts";
import {
  contentFingerprint,
  richCacheKey,
  useRichTranscriptScope,
  type RichTranscriptScope,
} from "@/lib/chat/rich-identity";
import {
  RichRenderDeterministicError,
  richRenderScheduler,
  useRichRenderEpoch,
  type RichRenderPriority,
} from "@/lib/chat/rich-render-cache";
import { useRichRenderPriority } from "@/lib/chat/rich-render-priority";
import { sanitizeSvg, SvgSanitizeError, SVG_SANITIZER_VERSION } from "@/lib/chat/svg-sanitize";
import { artifactErrorInfo } from "@/lib/chat/artifact-requests";

export const MERMAID_CLIENT_VERSION = `mermaid-client:v1:${SVG_SANITIZER_VERSION}`;
const CLIENT_TIMEOUT_MS = 20_000;

export interface MermaidPreview {
  svg: string;
  diagramType: string;
  rendererVersion: string;
  width: number | null;
  height: number | null;
}

export interface MermaidFailure {
  kind: "syntax" | "limit" | "timeout" | "unavailable";
  message: string;
  line?: number;
  column?: number;
}

/** A deterministic failure for this exact source; cached and never auto-retried. */
export class MermaidDeterministicError extends RichRenderDeterministicError {
  constructor(readonly failure: MermaidFailure) {
    super(failure.message, failure);
    this.name = "MermaidDeterministicError";
  }
}

export class MermaidUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MermaidUnavailableError";
  }
}

type MermaidRenderer = (input: MermaidRenderRequest) => Promise<MermaidRenderResponse>;
let renderer: MermaidRenderer = renderMermaidDiagram;

/** Replace the backend renderer (tests). */
export function setMermaidRenderer(next: MermaidRenderer | null): void {
  renderer = next ?? renderMermaidDiagram;
}

type SvgSanitizer = (markup: string) => { svg: string };
let sanitizer: SvgSanitizer = sanitizeSvg;

/** Replace the SVG sanitizer (tests: happy-dom cannot run DOMPurify's SVG path). */
export function setMermaidSvgSanitizer(next: SvgSanitizer | null): void {
  sanitizer = next ?? sanitizeSvg;
}

export function mermaidSourceTooLarge(source: string): boolean {
  return utf8ByteLength(source) > MERMAID_POLICY.maxSourceBytes;
}

/**
 * Where a diagram renders. `scope` is the transcript's conversation scope
 * (`useRichTranscriptScope()`; null outside a transcript), `priority` the
 * row's render priority. `useMermaidRenderOptions()` provides both.
 */
export interface MermaidRenderOptions {
  scope?: RichTranscriptScope | null;
  priority?: RichRenderPriority;
}

export function mermaidCacheKey(
  source: string,
  theme: "light" | "dark",
  scope: RichTranscriptScope | null = null,
): string {
  return richCacheKey({
    kind: "mermaid",
    scope,
    contentHash: contentFingerprint(source),
    rendererVersion: MERMAID_CLIENT_VERSION,
    theme,
  });
}

/**
 * Scope, row priority and clear epoch for a diagram block: pass `options` to
 * `peekMermaidPreview`/`requestMermaidPreview`, include `epoch` in the render
 * effect's dependencies (work cancelled by a clear is requested again) and
 * call `promote` when `options.priority` becomes visible.
 */
export function useMermaidRenderOptions(): {
  options: MermaidRenderOptions;
  epoch: number;
  currentPriority: () => RichRenderPriority;
} {
  const scope = useRichTranscriptScope();
  const { priority, current } = useRichRenderPriority();
  const epoch = useRichRenderEpoch();
  return { options: { scope, priority }, epoch, currentPriority: current };
}

/** Raise a queued diagram prefetch to visible priority. */
export function promoteMermaidPreview(
  source: string,
  theme: "light" | "dark",
  options: MermaidRenderOptions = {},
): void {
  richRenderScheduler.promote(mermaidCacheKey(source, theme, options.scope ?? null));
}

/** Natural size from the SVG's viewBox (Mermaid sizes its output with it). */
export function svgViewBoxSize(svg: string): { width: number | null; height: number | null } {
  const match =
    /<svg\b[^>]*\bviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/i.exec(
      svg,
    );
  const width = match ? Number(match[1]) : NaN;
  const height = match ? Number(match[2]) : NaN;
  return {
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
  };
}

const DETERMINISTIC_CODES = new Set([
  "invalid_input",
  "validation_failed",
  "policy_denied",
  "render_timeout",
  "package_size_exceeded",
]);

function failureFromResponse(error: {
  code: string;
  message: string;
  line?: number;
  column?: number;
}): Error {
  if (DETERMINISTIC_CODES.has(error.code)) {
    const kind: MermaidFailure["kind"] =
      error.code === "render_timeout"
        ? "timeout"
        : error.code === "package_size_exceeded" || error.code === "policy_denied"
          ? "limit"
          : "syntax";
    return new MermaidDeterministicError({
      kind,
      message: error.message.slice(0, 500),
      ...(error.line !== undefined ? { line: error.line } : {}),
      ...(error.column !== undefined ? { column: error.column } : {}),
    });
  }
  return new MermaidUnavailableError(
    error.message.slice(0, 500) || "The diagram renderer is unavailable",
  );
}

async function renderOnce(
  source: string,
  theme: "light" | "dark",
  signal: AbortSignal,
): Promise<MermaidPreview> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const response = await Promise.race([
    // Backend command failures arrive as a thrown Error carrying the JSON
    // `ArtifactError`; classify them like a resolved failure so validation
    // errors are cached and nothing is retried automatically.
    renderer({ source, theme }).catch((error: unknown): never => {
      const info = artifactErrorInfo(error);
      throw failureFromResponse({
        code: info.code ?? "renderer_unavailable",
        message: info.message,
      });
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new MermaidUnavailableError("The diagram renderer did not respond")),
        CLIENT_TIMEOUT_MS,
      );
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (!response.ok) throw failureFromResponse(response.error);
  let clean: string;
  try {
    clean = sanitizer(response.svg).svg;
  } catch (error) {
    if (error instanceof SvgSanitizeError) {
      throw new MermaidDeterministicError({
        kind: "limit",
        message:
          error.code === "too_large"
            ? `The rendered diagram exceeds ${MERMAID_POLICY.maxSvgBytes / 1024 / 1024} MiB`
            : error.code === "too_many_elements"
              ? `The rendered diagram exceeds ${MERMAID_POLICY.maxSvgElements} elements`
              : "The renderer returned an invalid diagram",
      });
    }
    throw error;
  }
  return {
    svg: clean,
    diagramType: response.diagramType,
    rendererVersion: response.rendererVersion,
    ...svgViewBoxSize(clean),
  };
}

/** Request a preview through the diagram lane. Over-limit source never reaches the backend. */
export function requestMermaidPreview(
  source: string,
  theme: "light" | "dark",
  options: MermaidRenderOptions = {},
): { promise: Promise<MermaidPreview>; cancel: () => void } {
  if (mermaidSourceTooLarge(source)) {
    return {
      promise: Promise.reject(
        new MermaidDeterministicError({
          kind: "limit",
          message: `Diagram source exceeds ${MERMAID_POLICY.maxSourceBytes / 1024} KiB`,
        }),
      ),
      cancel: () => {},
    };
  }
  return richRenderScheduler.request<MermaidPreview>({
    key: mermaidCacheKey(source, theme, options.scope ?? null),
    lane: "diagram",
    priority: options.priority ?? "visible",
    sourceBytes: utf8ByteLength(source),
    run: async (signal) => {
      const preview = await renderOnce(source, theme, signal);
      return { value: preview, bytes: preview.svg.length * 2 };
    },
  });
}

export function peekMermaidPreview(
  source: string,
  theme: "light" | "dark",
  options: MermaidRenderOptions = {},
): { ok: true; value: MermaidPreview } | { ok: false; error: unknown } | null {
  return richRenderScheduler.peek<MermaidPreview>(
    mermaidCacheKey(source, theme, options.scope ?? null),
  );
}

export function describeMermaidFailure(error: unknown): MermaidFailure {
  if (error instanceof MermaidDeterministicError) return error.failure;
  return {
    kind: "unavailable",
    message:
      error instanceof Error && error.message
        ? error.message
        : "The diagram renderer is unavailable",
  };
}
