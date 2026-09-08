/**
 * The last line of defence between a stray promise rejection and a dead
 * process.
 *
 * Under Bun an unhandled rejection is fatal once the entry module has finished
 * evaluating, and every long-lived process here — the backend and each bridge —
 * is exactly that shape. The blast radius is not proportionate: a rejected
 * `reader.cancel()` inside a vendored SSE client took the whole backend down,
 * and the desktop supervisor answers a backend exit by telling the user the app
 * will close. One dropped promise should degrade one feature, not end the
 * session.
 *
 * This is deliberately not a general error-swallowing net. It reports loudly and
 * keeps running, so the failure stays visible in the logs while remaining
 * survivable. Code that can handle its own rejections still must: reaching this
 * handler means something was missed, and the log line is the evidence.
 */

/**
 * The slice of `process` this guard uses.
 *
 * Deliberately not `Pick<NodeJS.Process, "on" | "off">`: those are heavily
 * overloaded, so borrowing them forces every test double to satisfy unrelated
 * signatures like the `memoryPressure` listener. `process` still satisfies this.
 */
export interface RejectionEventTarget {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off?(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

export interface FatalRejectionGuardOptions {
  /** Prefix identifying the process, e.g. `[Backend]` or `[claude-bridge]`. */
  label: string;
  /** Injected in tests. */
  warn?: (message: string) => void;
  /** Injected in tests. */
  onProcess?: RejectionEventTarget;
  /**
   * Install even under the test runner. Only the guard's own tests set this;
   * see `shouldInstall` for why every other suite wants the default.
   */
  force?: boolean;
}

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    // DOMException and friends carry the useful identity in `name`, and an
    // abort's message ("The operation was aborted.") says nothing on its own.
    const name = reason.name && reason.name !== "Error" ? `${reason.name}: ` : "";
    const stack = reason.stack ? `\n${reason.stack}` : "";
    return `${name}${reason.message}${stack}`;
  }
  if (typeof reason === "object" && reason !== null) {
    try {
      return JSON.stringify(reason);
    } catch {
      return Object.prototype.toString.call(reason);
    }
  }
  return String(reason);
}

/**
 * Under `bun test`, an unhandled rejection failing the run is signal worth
 * keeping: suites import the bridge entrypoints directly, so installing the
 * guard there would silently downgrade a real defect to a log line nobody
 * reads. Production entrypoints are unaffected.
 */
function shouldInstall(force: boolean | undefined): boolean {
  return force === true || process.env.NODE_ENV !== "test";
}

/**
 * Survive unhandled rejections instead of exiting, reporting each one.
 *
 * Returns a stop function so tests can uninstall the listener; production
 * callers install it for the life of the process and ignore the result.
 */
export function installFatalRejectionGuard(options: FatalRejectionGuardOptions): () => void {
  if (!shouldInstall(options.force)) return () => {};
  const warn = options.warn ?? ((message: string) => console.error(message));
  // `process.on` is overloaded per event name, so a union of it and the seam
  // narrows the event parameter to `never`. The cast keeps the seam honest
  // without dragging those overloads into every caller's typecheck.
  const target: RejectionEventTarget =
    options.onProcess ?? (process as unknown as RejectionEventTarget);
  const handler = (reason: unknown): void => {
    warn(`${options.label} Unhandled promise rejection (continuing): ${describe(reason)}`);
  };
  target.on("unhandledRejection", handler);
  return () => {
    target.off?.("unhandledRejection", handler);
  };
}
