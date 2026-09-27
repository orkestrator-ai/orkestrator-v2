/**
 * Test-only design renderer: executes the REAL design runtime inside a fresh
 * happy-dom window per job, so service tests exercise the same sanitizer,
 * selector and style logic as Chromium without launching a browser.
 *
 * Never import this module from production code.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { installDesignRuntime } from "@orkestrator/protocol/design-runtime";
import {
  DESIGN_EVENT,
  type DesignChange,
  type DesignOperation,
} from "@orkestrator/protocol/design-canvas";
import type { DesignRendererHealth } from "@orkestrator/protocol/design-operations";
import { DesignError } from "./design-errors.js";
import type { DesignRenderJob } from "./design-renderer.js";
import {
  DesignService,
  type DesignRendererLike,
  type DesignServiceOptions,
} from "./design-service.js";

/** A valid 1x1 transparent PNG. */
export const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const MAX_REQUEST_HTML_BYTES = 256 * 1024;

export interface TestRenderJobRecord {
  environmentId: string;
  canvasId: string;
  priority: DesignRenderJob["priority"];
  op: string;
}

export type TestRenderBlock = Promise<void> | ((job: DesignRenderJob) => Promise<void> | undefined);

export interface TestRendererOptions {
  /** Awaited before a job runs. A function may block selected jobs only. */
  block?: TestRenderBlock;
  /** Returning an error rejects the job with it (checked after `block`). */
  fail?: (job: DesignRenderJob) => Error | undefined;
  health?: Partial<DesignRendererHealth>;
}

export interface TestRenderer extends DesignRendererLike {
  /** Every admitted job, in admission order. */
  readonly jobs: TestRenderJobRecord[];
  block: TestRenderBlock | undefined;
  fail: ((job: DesignRenderJob) => Error | undefined) | undefined;
  health: DesignRendererHealth;
  readonly closed: boolean;
  /** Resolves once `count` jobs matching `predicate` have been admitted (past or future). */
  started(predicate?: (job: TestRenderJobRecord) => boolean, count?: number): Promise<void>;
  /** Number of jobs currently admitted and not yet settled. */
  readonly active: number;
  /** Accept jobs again after `close()` (a restarted service reuses the renderer). */
  reopen(): void;
}

function readyHealth(overrides: Partial<DesignRendererHealth> = {}): DesignRendererHealth {
  return {
    state: "ready",
    ready: true,
    message: "Design renderer ready",
    queued: 0,
    running: 0,
    generation: 1,
    executableConfigured: false,
    ...overrides,
  };
}

type RuntimeWindow = Window & { orkDesign: (operation: DesignOperation) => unknown };

async function runInRuntime(job: DesignRenderJob): Promise<unknown> {
  const window = new Window({ width: job.frame.width, height: job.frame.height }) as RuntimeWindow;
  try {
    window.eval(`(${installDesignRuntime.toString()})()`);
    const run = (operation: DesignOperation) => {
      try {
        return window.orkDesign(operation);
      } catch (error) {
        // The real renderer forwards runtime messages as plain errors.
        throw new Error(error instanceof Error ? error.message : "Runtime failed");
      }
    };
    run({ op: "render", html: job.frame.html });
    if (job.operation.op === "capture") return { mimeType: "image/png", data: TEST_PNG_BASE64 };
    return run(job.operation);
  } finally {
    await window.happyDOM.close();
  }
}

function tooLarge(job: DesignRenderJob): boolean {
  const html =
    "html" in job.operation && typeof job.operation.html === "string" ? job.operation.html : "";
  return (
    Buffer.byteLength(job.frame.html) > MAX_REQUEST_HTML_BYTES ||
    Buffer.byteLength(html) > MAX_REQUEST_HTML_BYTES
  );
}

export function createTestRenderer(options: TestRendererOptions = {}): TestRenderer {
  const jobs: TestRenderJobRecord[] = [];
  const waiters: Array<{
    predicate: (job: TestRenderJobRecord) => boolean;
    count: number;
    resolve: () => void;
  }> = [];
  const matching = (predicate: (job: TestRenderJobRecord) => boolean) =>
    jobs.filter(predicate).length;
  let closed = false;
  let active = 0;
  const renderer: TestRenderer = {
    jobs,
    block: options.block,
    fail: options.fail,
    health: readyHealth(options.health),
    get closed() {
      return closed;
    },
    get active() {
      return active;
    },
    started(predicate = () => true, count = 1) {
      if (matching(predicate) >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ predicate, count, resolve }));
    },
    async run<T = unknown>(job: DesignRenderJob): Promise<T> {
      if (closed) throw new DesignError("renderer-unavailable", "Design renderer is stopping");
      if (tooLarge(job)) throw new DesignError("invalid-content", "HTML exceeds 256 KiB");
      const record: TestRenderJobRecord = {
        environmentId: job.environmentId,
        canvasId: job.canvasId,
        priority: job.priority,
        op: job.operation.op,
      };
      jobs.push(record);
      for (const waiter of Array.from(waiters)) {
        if (matching(waiter.predicate) < waiter.count) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      active++;
      try {
        const block = typeof renderer.block === "function" ? renderer.block(job) : renderer.block;
        if (block) await block;
        // Always settle asynchronously, as a real browser round trip would.
        await Promise.resolve();
        const failure = renderer.fail?.(job);
        if (failure) throw failure;
        return (await runInRuntime(job)) as T;
      } finally {
        active--;
      }
    },
    status() {
      return { ...renderer.health, running: active };
    },
    async probe() {
      return renderer.status();
    },
    async close() {
      closed = true;
    },
    reopen() {
      closed = false;
    },
    invalidateHealth() {},
  };
  return renderer;
}

/** A promise with its settle functions, for deterministic interleavings. */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Records unhandled rejections. Call `install()` before the work, assert
 * `seen` is empty afterwards, and always `remove()` the listener.
 */
export function trackUnhandledRejections() {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };
  return {
    seen,
    install() {
      process.on("unhandledRejection", listener);
    },
    remove() {
      process.off("unhandledRejection", listener);
    },
  };
}

export interface DesignHarness {
  dir: string;
  service: DesignService;
  renderer: TestRenderer;
  /** Every published design hint, in order, across restarts. */
  events: DesignChange[];
  /** Closes the current service (when open) and starts a new one on the same data. */
  restart(options?: DesignServiceOptions): Promise<DesignService>;
  close(): Promise<void>;
}

/** A service on a private temporary directory using the happy-dom runtime renderer. */
export async function createDesignHarness(
  options: {
    prefix?: string;
    renderer?: TestRenderer;
    service?: DesignServiceOptions;
  } = {},
): Promise<DesignHarness> {
  const dir = await mkdtemp(join(tmpdir(), options.prefix ?? "ork-design-"));
  const renderer = options.renderer ?? createTestRenderer();
  const events: DesignChange[] = [];
  const emit = (event: string, payload: unknown) => {
    if (event === DESIGN_EVENT) events.push(payload as DesignChange);
  };
  let closed = false;
  const harness: DesignHarness = {
    dir,
    renderer,
    events,
    service: new DesignService(dir, emit, renderer, options.service),
    async restart(serviceOptions) {
      if (!closed) await harness.service.close();
      closed = false;
      harness.renderer.reopen();
      harness.service = new DesignService(dir, emit, harness.renderer, serviceOptions);
      return harness.service;
    },
    async close() {
      if (!closed) await harness.service.close();
      closed = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
