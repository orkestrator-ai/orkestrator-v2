import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import type { DesignFrame, DesignOperation } from "@orkestrator/protocol/design-canvas";
import {
  DESIGN_LIMITS,
  type DesignRendererHealth,
  type DesignRendererState,
} from "@orkestrator/protocol/design-operations";
import { DesignError } from "./design-errors.js";
import {
  DesignRenderQueue,
  asError,
  attempt,
  within,
  type DesignRenderPriority,
} from "./design-render-queue.js";

export type { DesignRenderPriority } from "./design-render-queue.js";

export interface DesignRenderJob {
  environmentId: string;
  canvasId: string;
  priority: DesignRenderPriority;
  frame: Pick<DesignFrame, "html" | "width" | "height">;
  operation: DesignOperation | { op: "capture" };
}

export interface DesignRenderBudgets {
  queueMs: number;
  launchMs: number;
  contextMs: number;
  runMs: number;
  cleanupMs: number;
  overallMs: number;
}

export const DEFAULT_DESIGN_RENDER_BUDGETS: DesignRenderBudgets = {
  queueMs: 15_000,
  launchMs: 15_000,
  contextMs: 5_000,
  runMs: 15_000,
  cleanupMs: 3_000,
  overallMs: 45_000,
};

export interface DesignRendererOptions {
  launchBrowser?: typeof chromium.launch;
  executablePath?: () => string | undefined;
  budgets?: Partial<DesignRenderBudgets>;
  maxJobs?: number;
  workers?: number;
  healthCacheMs?: number;
}

const MAX_REQUEST_HTML_BYTES = 256 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
/** After an unexpected generation death, report "recovering" at most this long. */
const RECOVERING_MS = 5_000;
const MAX_ASSET_WAIT_MS = 5_000;

const INSTALL_GUIDANCE =
  "Design workspaces require Chromium. Install Chromium or set ORKESTRATOR_DESIGN_CHROMIUM_PATH to its executable.";
const LAUNCH_FAILED_MESSAGE =
  "Chromium was found but failed to start. Check the browser installation or ORKESTRATOR_DESIGN_CHROMIUM_PATH.";

const SYSTEM_CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export function resolveDesignChromiumPath(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = SYSTEM_CHROMIUM_PATHS,
): string | undefined {
  const configured = env.ORKESTRATOR_DESIGN_CHROMIUM_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  const managed = env.PLAYWRIGHT_BROWSERS_PATH ? chromium.executablePath() : undefined;
  return [managed, chromium.executablePath(), ...candidates].find(
    (candidate): candidate is string => Boolean(candidate && existsSync(candidate)),
  );
}

interface Generation {
  id: number;
  dead: boolean;
  browser?: Browser;
  ready: Promise<Browser>;
  launchTimer?: ReturnType<typeof setTimeout>;
  jobs: Set<Ticket>;
  terminating?: Promise<void>;
}

interface Ticket {
  job: DesignRenderJob;
  environmentId: string;
  canvasId: string;
  priority: DesignRenderPriority;
  enqueuedAt: number;
  deadline: number;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
  /** Rejects the phase currently awaited, if any, and clears its timer. */
  cancelPhase?: (error: Error) => void;
}

interface ProbeRecord {
  at: number;
  ok: boolean;
  state?: DesignRendererState;
  message?: string;
}

type RuntimeResult = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Backend DOM operations never depend on a mounted client's iframe.
 *
 * Every job runs in a fresh isolated context of a shared browser generation.
 * Each lifecycle phase has its own deadline, capped by the job's overall
 * deadline, and nothing awaits Playwright without a bound.
 */
export class DesignRenderer {
  private readonly launchBrowser: typeof chromium.launch;
  private readonly executablePath: () => string | undefined;
  private readonly budgets: DesignRenderBudgets;
  private readonly maxJobs: number;
  private readonly workers: number;
  private readonly healthCacheMs: number;
  private readonly queue = new DesignRenderQueue<Ticket>();
  private readonly running = new Set<Ticket>();
  private readonly active = new Set<Promise<void>>();
  private readonly generations = new Set<Generation>();
  private current: Generation | undefined;
  private generationCounter = 0;
  private launchFailure: { at: number } | undefined;
  private recoveringSince: number | undefined;
  private probeRecord: ProbeRecord | undefined;
  private probing: Promise<DesignRendererHealth> | undefined;
  private stopping = false;
  private closing: Promise<void> | undefined;

  constructor(options: DesignRendererOptions = {}) {
    this.launchBrowser = options.launchBrowser ?? chromium.launch.bind(chromium);
    this.executablePath = options.executablePath ?? resolveDesignChromiumPath;
    this.budgets = { ...DEFAULT_DESIGN_RENDER_BUDGETS, ...options.budgets };
    this.maxJobs = Math.max(1, options.maxJobs ?? DESIGN_LIMITS.renderJobs);
    this.workers = Math.max(1, options.workers ?? DESIGN_LIMITS.renderWorkers);
    this.healthCacheMs = Math.max(0, options.healthCacheMs ?? DESIGN_LIMITS.healthCacheMs);
  }

  run<T = unknown>(job: DesignRenderJob): Promise<T> {
    if (this.stopping)
      return Promise.reject(new DesignError("renderer-unavailable", "Design renderer is stopping"));
    const oversized = requestTooLarge(job);
    if (oversized) return Promise.reject(new DesignError("invalid-content", oversized));
    if (!this.executablePath())
      return Promise.reject(new DesignError("renderer-unavailable", INSTALL_GUIDANCE));
    if (this.admitted >= this.maxJobs) {
      warn("capacity", { queued: this.queue.size, running: this.running.size });
      return Promise.reject(
        new DesignError("capacity", "Design renderer busy; retry later", {
          retryAfterMs: Math.min(this.budgets.runMs, 1_000),
        }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const now = Date.now();
      const ticket: Ticket = {
        job,
        environmentId: job.environmentId,
        canvasId: job.canvasId,
        priority: job.priority,
        enqueuedAt: now,
        deadline: now + this.budgets.overallMs,
        settled: false,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      ticket.queueTimer = setTimeout(
        () => {
          ticket.queueTimer = undefined;
          if (!this.queue.remove(ticket)) return;
          warn("queue-deadline", { waitedMs: Date.now() - ticket.enqueuedAt });
          this.settle(
            ticket,
            new DesignError("deadline", "Design render expired in the queue; not started", {
              retry: "after-delay",
            }),
          );
        },
        Math.min(this.budgets.queueMs, this.budgets.overallMs),
      );
      this.queue.push(ticket);
      this.pump();
    });
  }

  status(): DesignRendererHealth {
    const now = Date.now();
    const base = {
      queued: this.queue.size,
      running: this.running.size,
      generation: this.current?.id ?? this.generationCounter,
      executableConfigured: Boolean(process.env.ORKESTRATOR_DESIGN_CHROMIUM_PATH?.trim()),
    };
    const probe =
      this.probeRecord && now - this.probeRecord.at < this.healthCacheMs
        ? this.probeRecord
        : undefined;
    const checkedAt = new Date(probe?.at ?? now).toISOString();
    const health = (state: DesignRendererState, message: string): DesignRendererHealth => {
      const ready =
        state === "ready" || state === "running" || state === "saturated" || state === "unknown";
      return { state, ready, message, checkedAt, ...base, ...(ready ? {} : { error: message }) };
    };
    if (this.stopping) return health("stopping", "Design renderer is stopping");
    if (!this.executablePath()) return health("missing-executable", INSTALL_GUIDANCE);
    if (this.launchFailure) return health("launch-failed", LAUNCH_FAILED_MESSAGE);
    if (this.isRecovering(now))
      return health("recovering", "Design renderer is restarting after a browser failure");
    if (this.admitted >= this.maxJobs)
      return health("saturated", "Design renderer is at capacity; retry shortly");
    if (this.running.size > 0) return health("running", "Design renderer is running");
    if (probe && !probe.ok)
      return health(probe.state ?? "recovering", probe.message ?? "Design renderer check failed");
    if (probe?.ok || (this.current?.browser && !this.current.dead))
      return health("ready", "Design renderer ready");
    return health("unknown", "Design renderer has not been checked yet");
  }

  probe(force = false): Promise<DesignRendererHealth> {
    if (this.probing) return this.probing;
    if (this.stopping || !this.executablePath()) return Promise.resolve(this.status());
    const record = this.probeRecord;
    if (!force && record && Date.now() - record.at < this.healthCacheMs)
      return Promise.resolve(this.status());
    const probing = this.run({
      environmentId: "\u0000health",
      canvasId: "probe",
      priority: "validation",
      frame: { html: "<p>ok</p>", width: 64, height: 64 },
      operation: { op: "serialize" },
    })
      .then(
        () => {
          this.probeRecord = { at: Date.now(), ok: true };
        },
        (error: unknown) => {
          if (error instanceof DesignError && error.code === "capacity") return;
          const launchFailed = this.launchFailure !== undefined;
          this.probeRecord = {
            at: Date.now(),
            ok: false,
            state: launchFailed ? "launch-failed" : "recovering",
            message: error instanceof DesignError ? error.message : "Design renderer check failed",
          };
        },
      )
      .then(() => this.status())
      .finally(() => {
        if (this.probing === probing) this.probing = undefined;
      });
    this.probing = probing;
    return probing;
  }

  invalidateHealth(): void {
    this.probeRecord = undefined;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private get admitted(): number {
    return this.queue.size + this.running.size;
  }

  private isRecovering(now: number): boolean {
    if (this.recoveringSince === undefined) return false;
    if (now - this.recoveringSince < RECOVERING_MS) return true;
    const relaunching = this.current !== undefined && !this.current.browser && !this.current.dead;
    if (!relaunching) this.recoveringSince = undefined;
    return relaunching;
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    this.invalidateHealth();
    const stopping = () => new DesignError("renderer-unavailable", "Design renderer is stopping");
    for (const ticket of this.queue.drain()) this.settle(ticket, stopping());
    const { cleanupMs } = this.budgets;
    if (this.active.size) {
      const drained = await within(Promise.allSettled(Array.from(this.active)), cleanupMs);
      if (!drained) warn("close-drain-timeout", { running: this.running.size });
    }
    for (const generation of Array.from(this.generations))
      this.markDead(generation, "stopping", stopping);
    for (const ticket of Array.from(this.running)) this.settle(ticket, stopping());
    await Promise.allSettled(Array.from(this.generations, (gen) => this.terminate(gen)));
    this.current = undefined;
  }

  private pump(): void {
    while (!this.stopping && this.running.size < this.workers) {
      const ticket = this.queue.take(Date.now());
      if (!ticket) return;
      if (ticket.queueTimer) clearTimeout(ticket.queueTimer);
      ticket.queueTimer = undefined;
      this.running.add(ticket);
      const work = this.execute(ticket)
        .catch((error: unknown) => this.settle(ticket, asError(error)))
        .finally(() => {
          this.running.delete(ticket);
          this.active.delete(work);
          this.pump();
        });
      this.active.add(work);
    }
  }

  private settle(ticket: Ticket, outcome: Error | { value: unknown }): void {
    if (ticket.settled) return;
    ticket.settled = true;
    if (ticket.queueTimer) clearTimeout(ticket.queueTimer);
    ticket.queueTimer = undefined;
    if (outcome instanceof Error) {
      ticket.cancelPhase?.(outcome);
      ticket.reject(outcome);
    } else {
      ticket.resolve(outcome.value);
    }
  }

  /** Awaits one lifecycle phase within min(budget, remaining overall). */
  private phase<T>(
    ticket: Ticket,
    promise: Promise<T>,
    budgetMs: number,
    onTimeout: () => Error,
  ): Promise<T> {
    if (ticket.settled) {
      promise.catch(() => undefined);
      return Promise.reject(new DesignError("renderer-unavailable", "Design render was canceled"));
    }
    const ms = Math.max(0, Math.min(budgetMs, ticket.deadline - Date.now()));
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => {
        done = true;
        clearTimeout(timer);
        if (ticket.cancelPhase === cancel) ticket.cancelPhase = undefined;
      };
      const cancel = (error: Error) => {
        if (done) return;
        finish();
        reject(error);
      };
      const timer = setTimeout(() => cancel(onTimeout()), ms);
      ticket.cancelPhase = cancel;
      promise.then(
        (value) => {
          if (done) return;
          finish();
          resolve(value);
        },
        (error: unknown) => {
          if (done) return;
          finish();
          reject(asError(error));
        },
      );
    });
  }

  private async execute(ticket: Ticket): Promise<void> {
    const { job } = ticket;
    const gen = this.acquireGeneration();
    const started = Date.now();
    await this.phase(ticket, gen.ready, this.budgets.launchMs, () =>
      unavailable("Design renderer did not start in time"),
    );
    if (gen.dead) throw unavailable("Design renderer stopped unexpectedly");
    const browser = gen.browser!;
    gen.jobs.add(ticket);
    let context: BrowserContext | undefined;
    let timedOut = false;
    let result: { value: unknown } | undefined;
    try {
      const creating = attempt(() =>
        browser.newContext({
          viewport: { width: Math.round(job.frame.width), height: Math.round(job.frame.height) },
          deviceScaleFactor: 1,
          colorScheme: "light",
          reducedMotion: "reduce",
          serviceWorkers: "block",
          acceptDownloads: false,
        }),
      );
      context = await this.phase(ticket, creating, this.budgets.contextMs, () => {
        // No isolated context exists to cancel; retire the generation instead.
        warn("context-deadline", { generation: gen.id });
        const error = unavailable("Design renderer did not respond in time");
        this.settle(ticket, error);
        creating.then(
          (late) => detachClose(late),
          () => undefined,
        );
        this.retire(gen, "context-deadline");
        return error;
      });
      const runMs = Math.max(0, Math.min(this.budgets.runMs, ticket.deadline - Date.now()));
      const value = await this.phase(ticket, this.perform(context, job, runMs), runMs, () => {
        timedOut = true;
        warn("run-deadline", { generation: gen.id, elapsedMs: Date.now() - started });
        return new DesignError("deadline", "Design render exceeded its time budget");
      });
      result = { value };
    } catch (error) {
      // Failures settle immediately; cleanup continues while holding the slot.
      this.settle(ticket, asError(error));
    } finally {
      gen.jobs.delete(ticket);
      if (context && !gen.dead) await this.closeContext(gen, context, timedOut);
    }
    // Successes release their isolated context and slot before the caller resumes.
    this.running.delete(ticket);
    if (result) this.settle(ticket, result);
  }

  private async perform(
    context: BrowserContext,
    job: DesignRenderJob,
    runMs: number,
  ): Promise<unknown> {
    // Designs are self-contained. No credentialed, local-network or file reads.
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(Math.max(1, runMs));
    await page.setContent(designBootstrap(randomUUID()), { waitUntil: "load" });
    await runtime(page, { op: "render", html: job.frame.html });
    if (job.operation.op !== "capture") return runtime(page, job.operation);
    await page.evaluate(waitForAssets, Math.min(MAX_ASSET_WAIT_MS, Math.floor(runMs / 3)));
    const png = await page.screenshot({ type: "png", animations: "disabled" });
    if (png.byteLength > MAX_CAPTURE_BYTES)
      throw new DesignError("invalid-content", "Capture exceeds 8 MiB");
    return { mimeType: "image/png", data: png.toString("base64") };
  }

  private async closeContext(gen: Generation, context: BrowserContext, timedOut: boolean) {
    const closed = await within(
      attempt(() => context.close()),
      this.budgets.cleanupMs,
    );
    if (closed) return;
    warn("context-close-deadline", { generation: gen.id, afterTimeout: timedOut });
    this.retire(gen, "context-close-deadline");
  }

  private acquireGeneration(): Generation {
    if (this.current && !this.current.dead) return this.current;
    const executablePath = this.executablePath();
    if (!executablePath) throw new DesignError("renderer-unavailable", INSTALL_GUIDANCE);
    let resolveReady!: (browser: Browser) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<Browser>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => undefined);
    const gen: Generation = { id: ++this.generationCounter, dead: false, jobs: new Set(), ready };
    const launchMs = this.budgets.launchMs;
    const started = Date.now();
    gen.launchTimer = setTimeout(() => {
      gen.launchTimer = undefined;
      warn("launch-deadline", { generation: gen.id, elapsedMs: Date.now() - started });
      this.noteLaunchFailure();
      this.markDead(gen, "launch-deadline");
      rejectReady(unavailable("Design renderer did not start in time"));
    }, launchMs);
    attempt(() => this.launchBrowser({ headless: true, timeout: launchMs, executablePath })).then(
      (browser) => {
        if (gen.launchTimer) clearTimeout(gen.launchTimer);
        gen.launchTimer = undefined;
        gen.browser = browser;
        if (gen.dead) {
          // Launch finished after its deadline or shutdown: this process is ours to end.
          void this.terminate(gen);
          rejectReady(unavailable("Design renderer did not start in time"));
          return;
        }
        this.launchFailure = undefined;
        this.recoveringSince = undefined;
        browser.once("disconnected", () => this.onDisconnected(gen));
        resolveReady(browser);
      },
      () => {
        if (gen.launchTimer) clearTimeout(gen.launchTimer);
        gen.launchTimer = undefined;
        if (gen.dead) return;
        warn("launch-failed", { generation: gen.id, elapsedMs: Date.now() - started });
        this.noteLaunchFailure();
        this.markDead(gen, "launch-failed");
        rejectReady(new DesignError("renderer-unavailable", LAUNCH_FAILED_MESSAGE));
      },
    );
    this.generations.add(gen);
    this.current = gen;
    return gen;
  }

  private noteLaunchFailure(): void {
    this.launchFailure = { at: Date.now() };
    this.recoveringSince = undefined;
    this.invalidateHealth();
  }

  private onDisconnected(gen: Generation): void {
    if (gen.dead) {
      this.generations.delete(gen);
      return;
    }
    warn("generation-disconnected", { generation: gen.id, running: gen.jobs.size });
    this.recoveringSince = Date.now();
    this.markDead(gen, "disconnected");
    this.generations.delete(gen);
  }

  /** Marks a generation unusable and fails its running jobs exactly once. */
  private markDead(
    gen: Generation,
    reason: string,
    error: () => Error = () => unavailable("Design renderer stopped unexpectedly"),
  ): void {
    if (gen.dead) return;
    gen.dead = true;
    if (gen.launchTimer) clearTimeout(gen.launchTimer);
    gen.launchTimer = undefined;
    if (this.current === gen) this.current = undefined;
    // A launch that never produced a browser owns nothing to terminate yet; a
    // late browser is terminated when it arrives.
    if (!gen.browser) this.generations.delete(gen);
    if (reason !== "stopping") this.invalidateHealth();
    for (const ticket of Array.from(gen.jobs)) this.settle(ticket, error());
    gen.jobs.clear();
  }

  private retire(gen: Generation, reason: string): void {
    if (!gen.dead) this.recoveringSince = Date.now();
    this.markDead(gen, reason);
    void this.terminate(gen);
  }

  /** Closes an owned browser within cleanupMs, then kills its process if exposed. */
  private terminate(gen: Generation): Promise<void> {
    const browser = gen.browser;
    if (!browser) return Promise.resolve();
    gen.terminating ??= (async () => {
      const closed = await within(
        attempt(() => browser.close()),
        this.budgets.cleanupMs,
      );
      if (!closed) {
        warn("browser-close-deadline", { generation: gen.id });
        killBrowserProcess(browser);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.generations.delete(gen);
      });
    return gen.terminating;
  }
}

async function runtime(page: Page, operation: DesignOperation): Promise<unknown> {
  const result = (await page.evaluate(async (input) => {
    try {
      const run = (window as unknown as { orkDesign: (input: unknown) => unknown }).orkDesign;
      return { ok: true, value: await run(input) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Runtime failed" };
    }
  }, operation)) as RuntimeResult;
  // Runtime messages pass through unchanged; callers map them to failures.
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Runs in the page: settle fonts and images, bounded so capture cannot hang. */
async function waitForAssets(maxMs: number): Promise<void> {
  const images = Array.from(document.images).map((image) =>
    image.complete ? undefined : image.decode().catch(() => undefined),
  );
  await Promise.race([
    Promise.all([document.fonts?.ready, ...images]),
    new Promise((resolve) => setTimeout(resolve, maxMs)),
  ]);
}

function requestTooLarge(job: DesignRenderJob): string | undefined {
  const { operation } = job;
  const html = "html" in operation && typeof operation.html === "string" ? operation.html : "";
  if (
    Buffer.byteLength(job.frame.html) > MAX_REQUEST_HTML_BYTES ||
    Buffer.byteLength(html) > MAX_REQUEST_HTML_BYTES
  )
    return "HTML exceeds 256 KiB";
  return undefined;
}

function detachClose(context: BrowserContext): void {
  attempt(() => context.close()).catch(() => undefined);
}

function killBrowserProcess(browser: Browser): void {
  try {
    const child = (
      browser as unknown as { process?: () => { kill: (signal?: string) => void } }
    ).process?.();
    child?.kill("SIGKILL");
  } catch {
    // The process may already be gone.
  }
}

function unavailable(message: string): DesignError {
  return new DesignError("renderer-unavailable", message);
}

function warn(reason: string, detail: Record<string, number | boolean>): void {
  console.warn(`[design-renderer] ${reason}`, detail);
}
