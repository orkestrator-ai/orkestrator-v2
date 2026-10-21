import type { SshAdapterContext, SshChildProcess } from "./context.js";

export const MAX_TUNNEL_STDERR_BYTES = 16 * 1024;
const MAX_STDERR_LINE_LENGTH = 4 * 1024;
export const TUNNEL_TERMINATE_GRACE_MS = 3_000;

export type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The process could not be started (for example, the binary vanished). */
  spawnFailed: boolean;
};

/** Keeps only the most recent `maxBytes` of a text stream. */
export class BoundedTail {
  #text = "";
  readonly #max: number;

  constructor(maxBytes: number) {
    this.#max = maxBytes;
  }

  append(chunk: string): void {
    this.#text += chunk;
    if (this.#text.length > this.#max) this.#text = this.#text.slice(this.#text.length - this.#max);
  }

  get text(): string {
    return this.#text;
  }
}

/**
 * One Orkestrator-owned OpenSSH child. It keeps a bounded tail of stderr for
 * classification, emits complete stderr lines, and terminates only its own pid:
 * SIGTERM, a bounded wait, then SIGKILL. It never signals any other process.
 */
export class OwnedSshChild {
  readonly pid: number | undefined;
  readonly exited: Promise<ChildExit>;
  #child: SshChildProcess;
  #context: SshAdapterContext;
  #stderr = new BoundedTail(MAX_TUNNEL_STDERR_BYTES);
  #partialLine = "";
  #lineListeners = new Set<(line: string) => void>();
  #exit: ChildExit | null = null;
  #terminating: Promise<ChildExit> | null = null;

  constructor(context: SshAdapterContext, child: SshChildProcess) {
    this.#context = context;
    this.#child = child;
    this.pid = child.pid;
    this.exited = new Promise((resolve) => {
      child.once("error", () => {
        if (this.#exit) return;
        this.#exit = { code: null, signal: null, spawnFailed: true };
        resolve(this.#exit);
      });
      child.once("exit", (code, signal) => {
        if (this.#exit) return;
        // Let buffered stderr drain before observers classify the exit.
        setImmediate(() => {
          this.#flushPartialLine();
          this.#exit = { code, signal, spawnFailed: false };
          resolve(this.#exit);
        });
      });
    });
    child.stderr?.on("data", (chunk: Buffer | string) => this.#onStderr(chunk.toString()));
    child.stdout?.on("data", () => undefined);
  }

  get alive(): boolean {
    return this.#exit === null && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  get stderr(): string {
    return this.#stderr.text;
  }

  onStderrLine(listener: (line: string) => void): () => void {
    this.#lineListeners.add(listener);
    return () => this.#lineListeners.delete(listener);
  }

  terminate(graceMs = TUNNEL_TERMINATE_GRACE_MS): Promise<ChildExit> {
    if (!this.alive) return this.exited;
    this.#terminating ??= (async () => {
      this.#child.kill("SIGTERM");
      const deadline = new AbortController();
      const exited = this.exited.then((exit) => {
        deadline.abort();
        return exit;
      });
      await this.#context.clock.sleep(graceMs, deadline.signal);
      if (this.alive) {
        this.#context.logger.warn("ssh tunnel child ignored SIGTERM; sending SIGKILL", {
          pid: this.pid ?? -1,
        });
        this.#child.kill("SIGKILL");
        // Bounded even if the exit event never arrives, so app quit cannot hang.
        const killed = new AbortController();
        void exited.then(() => killed.abort());
        await this.#context.clock.sleep(graceMs, killed.signal);
        if (!this.#exit) return { code: null, signal: "SIGKILL", spawnFailed: false };
      }
      return exited;
    })();
    return this.#terminating;
  }

  #onStderr(text: string): void {
    this.#stderr.append(text);
    const combined = this.#partialLine + text;
    const lines = combined.split(/\r?\n/);
    this.#partialLine = (lines.pop() ?? "").slice(-MAX_STDERR_LINE_LENGTH);
    for (const line of lines) this.#emitLine(line);
  }

  #flushPartialLine(): void {
    if (!this.#partialLine) return;
    const line = this.#partialLine;
    this.#partialLine = "";
    this.#emitLine(line);
  }

  #emitLine(line: string): void {
    const bounded = line.slice(0, MAX_STDERR_LINE_LENGTH).trim();
    if (!bounded) return;
    for (const listener of this.#lineListeners) listener(bounded);
  }
}
