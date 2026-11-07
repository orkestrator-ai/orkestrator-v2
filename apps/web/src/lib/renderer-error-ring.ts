import {
  isRendererErrorBoundary,
  isRendererErrorClass,
  MAX_RENDERER_ERROR_BATCH,
  MAX_RENDERER_ERROR_COUNT,
  RENDERER_ERROR_RING_SIZE,
  type RendererErrorBoundary,
  type RendererErrorEntry,
  type RendererErrorRoute,
} from "@orkestrator/protocol/renderer-errors";
import { createLazyLoadFailureDiagnostic } from "./failure-diagnostic";

/**
 * The renderer's content-free error ring (docs/architecture/logging.md,
 * "Renderer failures in the essential log").
 *
 * An entry is an error class, where it was caught, which surface this is, a
 * one-way fingerprint and a count. The error itself is used only to compute
 * the class and fingerprint and is never kept: no message, no stack. A desktop
 * window sends new counts to the backend's essential log
 * (`renderer-error-upload.ts`); this module has no dependencies so the startup
 * handlers can record before the application loads.
 */

interface Slot {
  entry: Omit<RendererErrorEntry, "count">;
  total: number;
  unsent: number;
}

function cap(count: number): number {
  return Math.min(count, MAX_RENDERER_ERROR_COUNT);
}

export class RendererErrorRing {
  /** In order of last occurrence, oldest first, so eviction drops the least recent. */
  private readonly slots = new Map<string, Slot>();

  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pendingEntries(): RendererErrorEntry[] {
    return Array.from(this.slots.values(), (slot) => ({
      ...slot.entry,
      count: slot.unsent,
    })).filter((entry) => entry.count > 0);
  }

  /** Rehydrate strictly validated metadata, never raw errors. */
  recover(entries: readonly RendererErrorEntry[]): void {
    for (const entry of entries) {
      const key = `${entry.errorClass}|${entry.boundary}|${entry.route}|${entry.fingerprint}`;
      const slot = this.slots.get(key);
      this.slots.set(key, {
        entry,
        total: cap((slot?.total ?? 0) + entry.count),
        unsent: cap((slot?.unsent ?? 0) + entry.count),
      });
      while (this.slots.size > this.capacity) this.slots.delete(this.slots.keys().next().value!);
    }
  }

  constructor(private readonly capacity = RENDERER_ERROR_RING_SIZE) {}

  record(
    error: unknown,
    boundary: RendererErrorBoundary,
    route: RendererErrorRoute,
    componentStack?: string | null,
  ): void {
    const diagnostic = createLazyLoadFailureDiagnostic(error, {
      componentStack: componentStack ?? undefined,
    });
    const errorClass = isRendererErrorClass(diagnostic.errorType) ? diagnostic.errorType : "Error";
    const entry = { errorClass, boundary, route, fingerprint: diagnostic.fingerprint };
    const key = `${errorClass}|${boundary}|${route}|${diagnostic.fingerprint}`;
    const slot = this.slots.get(key);
    this.slots.delete(key);
    this.slots.set(key, {
      entry,
      total: cap((slot?.total ?? 0) + 1),
      unsent: cap((slot?.unsent ?? 0) + 1),
    });
    while (this.slots.size > this.capacity) {
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) break;
      this.slots.delete(oldest);
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Diagnostics never interrupt error handling. */
      }
    }
  }

  /** Every entry with its total count, oldest first. */
  entries(): RendererErrorEntry[] {
    return Array.from(this.slots.values(), (slot) => ({ ...slot.entry, count: slot.total }));
  }

  /** New counts to send, oldest first, at most one batch; they count as sent. */
  takeUnsent(max = MAX_RENDERER_ERROR_BATCH): RendererErrorEntry[] {
    const batch: RendererErrorEntry[] = [];
    for (const slot of this.slots.values()) {
      if (batch.length >= max) break;
      if (slot.unsent === 0) continue;
      batch.push({ ...slot.entry, count: slot.unsent });
      slot.unsent = 0;
    }
    return batch;
  }

  /** Puts back counts a send did not deliver. An entry evicted meanwhile stays lost. */
  restore(batch: readonly RendererErrorEntry[]): void {
    for (const sent of batch) {
      const key = `${sent.errorClass}|${sent.boundary}|${sent.route}|${sent.fingerprint}`;
      const slot = this.slots.get(key);
      if (slot) slot.unsent = cap(slot.unsent + sent.count);
    }
  }

  hasUnsent(): boolean {
    for (const slot of this.slots.values()) if (slot.unsent > 0) return true;
    return false;
  }
}

/** This renderer's ring. */
export const rendererErrorRing = new RendererErrorRing();

/**
 * Which renderer this is. The app has no URL router, so the surface stands in
 * for a route pattern: a browser tab on the web client, or the desktop
 * window's renderer. (The protocol's third route names the separate
 * workspace documents of earlier releases; this client no longer has any.)
 */
export function rendererErrorRoute(
  scope: {
    orkestratorGateway?: { enabled?: boolean; desktop?: boolean };
  } = globalThis as never,
): RendererErrorRoute {
  if (scope.orkestratorGateway?.enabled && !scope.orkestratorGateway.desktop) return "browser";
  return "window";
}

/** The boundary a React error was caught by: its declared name, or `boundary`. */
export function boundaryOf(errorBoundary: unknown): RendererErrorBoundary {
  const declared =
    typeof errorBoundary === "object" && errorBoundary !== null
      ? (errorBoundary.constructor as { diagnosticBoundary?: unknown } | undefined)
          ?.diagnosticBoundary
      : undefined;
  return isRendererErrorBoundary(declared) ? declared : "boundary";
}

/** Records a failure in this renderer's ring. Never throws: it runs inside error handlers. */
export function recordRendererFailure(
  error: unknown,
  boundary: RendererErrorBoundary,
  componentStack?: string | null,
): void {
  try {
    rendererErrorRing.record(error, boundary, rendererErrorRoute(), componentStack);
  } catch {
    // Recording must never turn one failure into two.
  }
}
