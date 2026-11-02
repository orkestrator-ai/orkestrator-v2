/**
 * The last line of defence between a stray promise rejection and a dead
 * process.
 *
 * Under Bun an unhandled rejection is fatal once the entry module has finished
 * evaluating, and every long-lived process here — the backend and each bridge —
 * is exactly that shape. The blast radius is not proportionate: a rejected
 * `reader.cancel()` inside a vendored SSE client took the whole backend down,
 * and the desktop supervisor answers a backend exit by taking Local offline for
 * the session and asking the user to restart the app. One dropped promise should
 * degrade one feature, not end the session.
 *
 * This is deliberately not a general error-swallowing net. It reports loudly and
 * keeps running, so the failure stays visible in the logs while remaining
 * survivable. Code that can handle its own rejections still must: reaching this
 * handler means something was missed, and the log line is the evidence.
 *
 * That line is one bounded line of text, safe to write whatever was rejected. It
 * follows the rules of `log-error.ts`, which this file cannot import, and
 * `fatal-rejections.test.ts` holds the two to the same fixtures.
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
   * see the installation check for why every other suite wants the default.
   */
  force?: boolean;
}

/**
 * Under `bun test`, an unhandled rejection failing the run is signal worth
 * keeping: suites import the bridge entrypoints directly, so installing the
 * guard there would silently downgrade a real defect to a log line nobody
 * reads. Production entrypoints are unaffected.
 *
 * Survive unhandled rejections instead of exiting, reporting each one.
 *
 * Returns a stop function so tests can uninstall the listener; production
 * callers install it for the life of the process and ignore the result.
 */
export function installFatalRejectionGuard(options: FatalRejectionGuardOptions): () => void {
  // Keep this function self-contained: environment-side validation workers
  // serialize it to install the same guard without repository dependencies.
  if (options.force !== true && process.env.NODE_ENV === "test") return () => {};
  const MAX_TEXT_CHARS = 1024;
  const MAX_FRAMES = 16;
  const MAX_FRAME_CHARS = 240;
  const MAX_RAW_FRAME_CHARS = 1024;
  const IDENTIFIER = /^[\w.:$-]{1,64}$/;
  const FRAME_LOCATION =
    /(^|[\s(])((?:[a-z][a-z0-9+.-]*:\/\/[^/\s)]*)?(?:\/|[a-z]:[\\/]|\\\\).*?)(?=:\d+(?::\d+)?\)?(?:,|$)|\)(?:,|$)|,\s|$)/gi;
  const LOCATION_SCHEME = /^([a-z][a-z0-9+.-]*):\/\/[^/\s)]*/i;
  const APP_PATH =
    /(?:^|\/)((?:apps\/(?:backend|desktop|web|web-public)|packages\/(?:protocol|cli|toolchain)|bridges\/[\w-]+|[\w-]+-bridge)\/.*)$/;
  const PACKAGED_PATH = /\/((?:app\.asar(?:\.unpacked)?|resources)\/.*)$/i;
  // Keep these rules equivalent to secret-redaction.ts. Serialized workers cannot
  // import it; common fixtures in fatal-rejections.test.ts enforce parity.
  const CREDENTIALS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
    // scheme://user:password@host — the password is the point, but the username is
    // identity, so both go.
    {
      pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi,
      replacement: "$1[redacted]@",
    },
    // Query credentials and OAuth state/code in a URL or a log line containing one.
    {
      pattern:
        /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|auth|authorization|token|secret|password|passwd|signature|sig|key|state|code)=)[^&\s"'`]+/gi,
      replacement: "$1[redacted]",
    },
    { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer [redacted]" },
    { pattern: /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, replacement: "Basic [redacted]" },
    // JWTs: three base64url segments. Matched before the generic key rules so a
    // token in an `Authorization:` header line is not partially replaced.
    {
      pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
      replacement: "[redacted]",
    },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: "[redacted]" },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted]" },
    { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, replacement: "[redacted]" },
    { pattern: /\bxox[baprse]-[A-Za-z0-9-]{8,}/g, replacement: "[redacted]" },
    { pattern: /\bAKIA[0-9A-Z]{12,}/g, replacement: "[redacted]" },
    { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replacement: "[redacted]" },
    /**
     * `api_key: "…"`, `OPENAI_API_KEY=…`, `password: …` in prose or a config dump.
     *
     * The leading `(?:[A-Za-z0-9]+[_-])*` matters: `\bAPI_KEY` never matches inside
     * `OPENAI_API_KEY`, because `_` is a word character and there is no boundary
     * before `API`. The lookahead keeps this from swallowing an auth *scheme* whose
     * token an earlier rule has already replaced, and `&` is excluded from the
     * value so it stops at the end of one query parameter.
     */
    {
      pattern:
        /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|passphrase|authorization))("?\s*[:=]\s*)("?)(?!Bearer\b|Basic\b|\[redacted\])[^\s"',;)&]{6,}\3/gi,
      replacement: "$1$2[redacted]",
    },
  ];

  /** Cuts first and redacts after, so a secret split by the cut still matches. */
  function bounded(value: string, maxChars: number): string {
    const cut = value.length > maxChars ? `${value.slice(0, maxChars - 14)}...[truncated]` : value;
    let text = cut;
    for (const { pattern, replacement } of CREDENTIALS) text = text.replace(pattern, replacement);
    // oxlint-disable-next-line no-control-regex -- the report is one line of text
    return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  }
  function appRelativeLocation(location: string): string {
    const scheme = LOCATION_SCHEME.exec(location)?.[1]?.toLowerCase();
    const isWebUrl = scheme !== undefined && scheme !== "file";
    const withoutOrigin = location.replace(LOCATION_SCHEME, "");
    const path = (isWebUrl ? withoutOrigin.split(/[?#]/, 1)[0]! : withoutOrigin).replace(
      /\\/g,
      "/",
    );
    const modules = path.lastIndexOf("/node_modules/");
    if (modules >= 0) return path.slice(modules + 1);
    const app = APP_PATH.exec(path)?.[1] ?? PACKAGED_PATH.exec(path)?.[1];
    if (app) return app;
    if (isWebUrl) return path.replace(/^\/+/, "");
    return `.../${path.slice(path.lastIndexOf("/") + 1)}`;
  }
  function read(target: object, key: string): unknown {
    try {
      return (target as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }
  /** `at ...` lines after the message, so no part of the message comes along. */
  function frames(stack: unknown, message: string | undefined): string[] {
    if (typeof stack !== "string") return [];
    const index = message ? stack.indexOf(message) : -1;
    return (index >= 0 ? stack.slice(index + message!.length) : stack)
      .split("\n")
      .filter((line) => /^\s*at\s/.test(line))
      .slice(0, MAX_FRAMES)
      .map((line) =>
        bounded(
          line
            .slice(0, MAX_RAW_FRAME_CHARS)
            .replace(
              FRAME_LOCATION,
              (_match, lead: string, location: string) => `${lead}${appRelativeLocation(location)}`,
            ),
          MAX_FRAME_CHARS,
        ),
      );
  }
  function identifiers(target: object): string {
    return ["code", "exitCode", "signal"]
      .flatMap((key) => {
        const value = read(target, key);
        const text = typeof value === "number" ? String(value) : value;
        return typeof text === "string" && IDENTIFIER.test(text)
          ? [`${key}=${bounded(text, 64)}`]
          : [];
      })
      .join(" ");
  }
  function describeError(error: object): string {
    const rawName = read(error, "name");
    const name =
      typeof rawName === "string" && IDENTIFIER.test(rawName) ? bounded(rawName, 64) : "Error";
    const rawMessage = read(error, "message");
    const message = typeof rawMessage === "string" ? rawMessage : undefined;
    // A failed child process's message is its output, and its other fields are too.
    const commandFailure =
      name === "CommandFailedError" ||
      Boolean(message?.startsWith("Command failed")) ||
      ["stdout", "stderr", "cmd", "spawnargs"].some((key) => read(error, key) !== undefined);
    const stack = read(error, "stack");
    const stackHoldsMessage = message !== undefined && String(stack ?? "").includes(message);
    const heading = commandFailure
      ? `${name}: [output omitted]`
      : `${name === "Error" ? "" : `${name}: `}${bounded(message ?? "", MAX_TEXT_CHARS)}`;
    const parts = [heading.trim(), identifiers(error)];
    if (!commandFailure || stackHoldsMessage || !message) {
      parts.push(...frames(stack, message));
    }
    return parts.filter(Boolean).join(" | ");
  }
  function describeObject(target: object): string {
    let tag = "[object]";
    let keyCount: number | undefined;
    try {
      tag = bounded(Object.prototype.toString.call(target), 64);
      keyCount = Object.keys(target).length;
    } catch {
      // A hostile tag or proxy still gets reported, just with less.
    }
    // Keys and values can be anything, so an arbitrary object is never described
    // by its contents: only its shape, and identifiers that pass the same check.
    const rawName = read(target, "name");
    const name =
      typeof rawName === "string" && IDENTIFIER.test(rawName) ? `name=${bounded(rawName, 64)}` : "";
    return [tag, name, identifiers(target), keyCount === undefined ? "" : `keys=${keyCount}`]
      .filter(Boolean)
      .join(" ");
  }
  function describe(reason: unknown): string {
    try {
      if (typeof reason === "string") return bounded(reason, MAX_TEXT_CHARS);
      if (typeof reason === "function") return "[function]";
      if (typeof reason !== "object" || reason === null) return bounded(String(reason), 64);
      if (reason instanceof Error || typeof read(reason, "message") === "string") {
        return describeError(reason);
      }
      return describeObject(reason);
    } catch {
      return "[unreadable]";
    }
  }
  const warn = options.warn ?? ((message: string) => console.error(message));
  // `process.on` is overloaded per event name, so a union of it and the seam
  // narrows the event parameter to `never`. The cast keeps the seam honest
  // without dragging those overloads into every caller's typecheck.
  const target: RejectionEventTarget =
    options.onProcess ?? (process as unknown as RejectionEventTarget);
  const handler = (reason: unknown): void => {
    try {
      warn(`${options.label} Unhandled promise rejection (continuing): ${describe(reason)}`);
    } catch {
      // A throw from this handler would be the crash the guard exists to prevent.
    }
  };
  target.on("unhandledRejection", handler);
  return () => {
    target.off?.("unhandledRejection", handler);
  };
}
