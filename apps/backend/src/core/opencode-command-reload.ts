/**
 * Reloading OpenCode's command files without restarting its server.
 *
 * OpenCode 1.19.0 reads command files once per directory instance, so a file
 * added while `opencode serve` runs never reaches `command.list`. The only
 * documented way to make the server read them again is `instance.dispose`,
 * which drops the directory's instance; the next request rebuilds it from disk.
 * Disposal also aborts whatever that instance is running: observed live, a
 * busy session's Bash call ended "User aborted the command". So a reload runs
 * only while the whole directory is idle, never during this provider's own
 * dispatch, and otherwise waits for the next idle edge.
 */
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { asRecord, assertSdkResponse } from "./agent-provider-runtime.js";

export type OpenCodeInstanceReloadResult = "reloaded" | "deferred";

export interface OpenCodeInstanceReloadDependencies {
  /** True when no session in the directory is busy or retrying. */
  idle(): Promise<boolean>;
  /** `instance.dispose` for the directory. Throws when OpenCode refuses it. */
  dispose(): Promise<void>;
  /** Runs before dispatch reopens, so nothing reaches the old instance's state. */
  reloaded(): void;
}

export class OpenCodeInstanceReload {
  private dispatches = 0;
  private running: Promise<"reloaded" | "busy"> | null = null;
  private pendingReload = false;

  constructor(private readonly dependencies: OpenCodeInstanceReloadDependencies) {}

  /** A reload was asked for and is waiting for the directory to go idle. */
  get pending(): boolean {
    return this.pendingReload;
  }

  /** Run `operation` as one dispatch (see {@link enterDispatch}). */
  async withinDispatch<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.enterDispatch();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Hold reloads off for one dispatch. Waits out a reload already running, so
   * a dispatch never lands on an instance that is being disposed.
   */
  async enterDispatch(): Promise<() => void> {
    while (this.running) await this.running.catch(() => undefined);
    this.dispatches += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dispatches -= 1;
      // `session.command` answers only after its whole turn, so that turn's
      // idle edge arrives while its dispatch is still open. Re-check here.
      if (this.dispatches === 0) this.idleObserved();
    };
  }

  /**
   * An explicit refresh: reload now if the directory is idle, otherwise at the
   * next idle edge ({@link idleObserved}). Disposal failures propagate.
   */
  async request(): Promise<OpenCodeInstanceReloadResult> {
    this.pendingReload = true;
    try {
      return (await this.attempt()) === "reloaded" ? "reloaded" : "deferred";
    } catch (error) {
      this.pendingReload = false;
      throw error;
    }
  }

  /**
   * Every stream event, owned session or not: a deferred reload waits for the
   * whole directory, so any session's idle edge re-checks it.
   */
  observeEvent(type: string, properties: Record<string, unknown>): void {
    if (
      type === "session.idle" ||
      (type === "session.status" && asRecord(properties.status)?.type === "idle")
    ) {
      this.idleObserved();
    }
  }

  /** The event stream saw a session go idle: retry a deferred reload. */
  idleObserved(): void {
    if (!this.pendingReload || this.running) return;
    void this.attempt().catch(() => {
      // A failed deferred reload is not retried on every idle edge; the next
      // explicit refresh tries again and reports the failure.
      this.pendingReload = false;
    });
  }

  private attempt(): Promise<"reloaded" | "busy"> {
    if (this.running) return this.running;
    if (this.dispatches > 0) return Promise.resolve("busy");
    // Set before the first await, so a dispatch that starts now waits.
    const running = this.reload().finally(() => {
      if (this.running === running) this.running = null;
    });
    this.running = running;
    return running;
  }

  private async reload(): Promise<"reloaded" | "busy"> {
    if (!(await this.dependencies.idle())) return "busy";
    await this.dependencies.dispose();
    this.pendingReload = false;
    this.dependencies.reloaded();
    return "reloaded";
  }
}

/** A reload of `directory`'s instance on one OpenCode server. */
export function openCodeInstanceReload(
  client: OpencodeClient,
  directory: string | undefined,
  requestOptions: () => { signal: AbortSignal },
  reloaded: () => void,
): OpenCodeInstanceReload {
  return new OpenCodeInstanceReload({
    async idle() {
      const response = await client.session.status({ directory }, requestOptions());
      assertSdkResponse(response, "OpenCode status read");
      const statuses = asRecord(response.data);
      if (!statuses) throw new Error("OpenCode returned a malformed status read");
      return Object.values(statuses).every((status) => asRecord(status)?.type === "idle");
    },
    async dispose() {
      const response = await client.instance.dispose({ directory }, requestOptions());
      assertSdkResponse(response, "OpenCode instance reload");
    },
    reloaded,
  });
}
