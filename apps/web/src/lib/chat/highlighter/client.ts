/**
 * Main-thread client for the highlighting worker.
 *
 * The backend is injectable so tests (and environments without module
 * workers) can supply tokenization directly. The worker is created lazily on
 * the first request, restarted after a crash or a hung request, and given up
 * on after repeated consecutive failures until the user asks to retry; every
 * failure leaves the caller with its readable plain source.
 */
import type { HighlightLanguage } from "./languages";
import type {
  HighlightLine,
  HighlightRequest,
  HighlightResponse,
  HighlightTheme,
} from "./protocol";

export interface HighlightInput {
  lang: HighlightLanguage;
  theme: HighlightTheme;
  code: string;
  resumeStateId?: string;
}

export interface HighlightOutput {
  lines: HighlightLine[];
  stateId: string | null;
}

export interface HighlightBackend {
  highlight(input: HighlightInput, signal: AbortSignal): Promise<HighlightOutput>;
  /** Forget a failed/crashed state so the next request starts afresh. */
  reset?(): void;
}

/** The worker no longer holds the grammar state to resume from. */
export class HighlightStateMissingError extends Error {
  constructor() {
    super("Highlighter grammar state is no longer available");
    this.name = "HighlightStateMissingError";
  }
}

/** The highlighter is not available right now (load failure, crash, timeout). */
export class HighlightUnavailableError extends Error {
  constructor(message = "Syntax highlighting is unavailable") {
    super(message);
    this.name = "HighlightUnavailableError";
  }
}

/** The worker rejected the language/theme; it will not succeed for this input. */
export class HighlightUnsupportedError extends Error {
  constructor() {
    super("Syntax highlighting does not support this language");
    this.name = "HighlightUnsupportedError";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface Pending {
  resolve: (output: HighlightOutput) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerHighlightBackend implements HighlightBackend {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failures = 0;

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
      type: "module",
      name: "transcript-highlighter",
    });
    worker.onmessage = (event: MessageEvent<HighlightResponse>) => this.settle(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.crash("Highlighter worker failed");
    };
    this.worker = worker;
    return worker;
  }

  private settle(response: HighlightResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      this.failures = 0;
      pending.resolve({ lines: response.lines, stateId: response.stateId });
    } else if (response.error === "state-missing") {
      pending.reject(new HighlightStateMissingError());
    } else if (response.error === "unsupported") {
      pending.reject(new HighlightUnsupportedError());
    } else {
      this.failures++;
      pending.reject(new HighlightUnavailableError());
    }
  }

  /** Terminate the worker and fail everything it held; the next request respawns it. */
  private crash(reason: string): void {
    this.failures++;
    this.worker?.terminate();
    this.worker = null;
    for (const [id, pending] of Array.from(this.pending.entries())) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new HighlightUnavailableError(reason));
    }
  }

  highlight(input: HighlightInput, signal: AbortSignal): Promise<HighlightOutput> {
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      return Promise.reject(
        new HighlightUnavailableError("Syntax highlighting stopped after repeated failures"),
      );
    }
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    let worker: Worker;
    try {
      worker = this.spawn();
    } catch {
      this.failures = MAX_CONSECUTIVE_FAILURES;
      return Promise.reject(new HighlightUnavailableError("Syntax highlighting could not start"));
    }
    const id = this.nextId++;
    return new Promise<HighlightOutput>((resolve, reject) => {
      const timer = setTimeout(
        () => this.crash("Highlighter worker timed out"),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, { resolve, reject, timer });
      signal.addEventListener(
        "abort",
        () => {
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
      const request: HighlightRequest = { id, ...input };
      worker.postMessage(request);
    });
  }

  reset(): void {
    this.failures = 0;
  }
}

function defaultBackend(): HighlightBackend | null {
  // Bun's DOM test runner cannot load Vite's worker URL; tests inject a backend.
  if (typeof (globalThis as typeof globalThis & { Bun?: unknown }).Bun !== "undefined") return null;
  if (typeof Worker === "undefined") return null;
  return new WorkerHighlightBackend();
}

let backend: HighlightBackend | null | undefined;

export function highlightBackend(): HighlightBackend | null {
  if (backend === undefined) backend = defaultBackend();
  return backend;
}

/** Replace the tokenization backend (tests, or a platform without module workers). */
export function setHighlightBackend(next: HighlightBackend | null | undefined): void {
  backend = next;
}
