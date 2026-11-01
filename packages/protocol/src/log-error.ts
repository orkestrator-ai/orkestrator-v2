import { redactSecrets } from "./secret-redaction.js";

const MAX_MESSAGE_CHARS = 1024;
const MAX_STACK_FRAMES = 8;
const MAX_FRAME_CHARS = 240;
const MAX_CAUSE_DEPTH = 2;
const TRUNCATED_MARKER = "...[truncated]";

const NAME_PATTERN = /^[A-Za-z_$][\w$.-]{0,63}$/;
const CODE_PATTERN = /^[\w.:-]{1,64}$/;
const SYSCALL_PATTERN = /^[\w./ -]{1,128}$/;

/**
 * Fields a failed child process carries. Their values are command output, and
 * the message of such an error usually is too: `CommandFailedError`'s message
 * is the child's stderr and `exec`'s is "Command failed: <cmd>\n<stderr>".
 */
const COMMAND_OUTPUT_FIELDS = ["stdout", "stderr", "cmd", "spawnargs"] as const;

declare const SAFE_LOG_ERROR: unique symbol;

/** What an error may contribute to a log entry. Every field is bounded. */
export interface LogErrorDetails {
  readonly name: string;
  readonly message?: string;
  readonly code?: string | number;
  readonly errno?: number;
  readonly syscall?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  /** The message was dropped because it can hold a child process's output. */
  readonly outputOmitted?: true;
  /** `at ...` lines only, so no part of the message can come along. */
  readonly stack?: readonly string[];
  readonly cause?: LogErrorDetails;
  /** An AggregateError's size; its first member is the `cause`. */
  readonly errorCount?: number;
}

/** An error `formatLogError` has made safe. Only it can produce one. */
export type SafeLogError = LogErrorDetails & { readonly [SAFE_LOG_ERROR]: true };

const safeErrors = new WeakSet<object>();

export function isSafeLogError(value: unknown): value is SafeLogError {
  return typeof value === "object" && value !== null && safeErrors.has(value);
}

function brand(details: LogErrorDetails): SafeLogError {
  const safe = Object.freeze(details) as SafeLogError;
  safeErrors.add(safe);
  return safe;
}

/**
 * Cuts first and redacts after, so a secret split by the cut still matches. The
 * marker counts towards the bound, so a relayed value is not cut a second time.
 */
function boundedText(value: string, maxChars: number): string {
  const cut =
    value.length > maxChars
      ? `${value.slice(0, maxChars - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`
      : value;
  return (
    redactSecrets(cut)
      // oxlint-disable-next-line no-control-regex -- a log entry is one line of text
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
      .trim()
  );
}

function read(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isCommandFailure(target: object, name: string, message: string | undefined): boolean {
  return (
    name === "CommandFailedError" ||
    Boolean(message?.startsWith("Command failed")) ||
    COMMAND_OUTPUT_FIELDS.some((field) => read(target, field) !== undefined)
  );
}

function stackFrames(target: object, message: string | undefined): string[] | undefined {
  const stack = read(target, "stack");
  if (typeof stack !== "string") return undefined;
  // A multi-line message can itself contain `at ...` lines, so everything up to
  // its end goes first. A stack whose header no longer holds the message is kept
  // only when that message is not command output, which the caller decides.
  const index = message ? stack.indexOf(message) : -1;
  const body = index >= 0 ? stack.slice(index + message!.length) : stack;
  const frames = body
    .split("\n")
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => boundedText(line, MAX_FRAME_CHARS));
  return frames.length > 0 ? frames : undefined;
}

function describe(error: unknown, includeStack: boolean, depth: number): LogErrorDetails {
  if (typeof error !== "object" || error === null) {
    return {
      name: "NonError",
      message:
        typeof error === "string" ? boundedText(error, MAX_MESSAGE_CHARS) : `[${typeof error}]`,
    };
  }
  const rawMessage = read(error, "message");
  if (!(error instanceof Error) && typeof rawMessage !== "string") {
    // An arbitrary object is never described by its contents.
    return { name: "NonError", message: "[object]" };
  }
  const name = matching(read(error, "name"), NAME_PATTERN) ?? "Error";
  const message = typeof rawMessage === "string" ? rawMessage : undefined;
  const commandFailure = isCommandFailure(error, name, message);
  const stackHoldsMessage =
    message !== undefined && String(read(error, "stack") ?? "").includes(message);
  const details: {
    -readonly [Key in keyof LogErrorDetails]: LogErrorDetails[Key];
  } = { name };
  if (commandFailure) details.outputOmitted = true;
  else if (message) details.message = boundedText(message, MAX_MESSAGE_CHARS);
  const code = read(error, "code");
  const safeCode = finite(code) ?? matching(code, CODE_PATTERN);
  if (safeCode !== undefined) details.code = safeCode;
  const errno = finite(read(error, "errno"));
  if (errno !== undefined) details.errno = errno;
  const syscall = matching(read(error, "syscall"), SYSCALL_PATTERN);
  if (syscall) details.syscall = syscall;
  const exitCode = finite(read(error, "exitCode"));
  if (exitCode !== undefined) details.exitCode = exitCode;
  const signal = matching(read(error, "signal"), CODE_PATTERN);
  if (signal) details.signal = signal;
  if (includeStack && (!commandFailure || stackHoldsMessage || !message)) {
    const frames = stackFrames(error, message);
    if (frames) details.stack = frames;
  }
  const members = read(error, "errors");
  if (Array.isArray(members)) details.errorCount = members.length;
  const cause = read(error, "cause") ?? (Array.isArray(members) ? members[0] : undefined);
  if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
    details.cause = describe(cause, false, depth + 1);
  }
  return details;
}

export interface FormatLogErrorOptions {
  /** Include bounded stack frames. Pass false on a hot path or an expected failure. */
  stack?: boolean;
}

/**
 * The only way an error reaches a log entry. Returns the name, code and a
 * bounded, redacted message, plus bounded stack frames. It never returns an
 * error's other fields, and never `stdout`, `stderr`, `cmd` or `spawnargs`: for
 * a failed child process even the message is dropped, because it is that output.
 */
export function formatLogError(error: unknown, options: FormatLogErrorOptions = {}): SafeLogError {
  try {
    return brand(describe(error, options.stack !== false, 0));
  } catch {
    return brand({ name: "Error", message: "[unreadable]" });
  }
}

/**
 * What a throttled log call keys an error by: its code, else its type. Never its
 * message, which varies and can hold content, and only names short enough to
 * pass the same patterns `formatLogError` uses.
 */
export function logErrorKind(error: unknown): string {
  if (typeof error !== "object" || error === null) return "NonError";
  if (!(error instanceof Error) && typeof read(error, "message") !== "string") return "NonError";
  const code = read(error, "code");
  const safeCode = finite(code) ?? matching(code, CODE_PATTERN);
  if (safeCode !== undefined) return String(safeCode);
  return matching(read(error, "name"), NAME_PATTERN) ?? "Error";
}

/** Rebuilds a relayed error, applying the same bounds; null if it is not one. */
export function logErrorFromWire(value: unknown, depth = 0): SafeLogError | null {
  if (typeof value !== "object" || value === null) return null;
  const wire = value as Record<string, unknown>;
  const name = matching(wire.name, NAME_PATTERN);
  if (!name) return null;
  const details: {
    -readonly [Key in keyof LogErrorDetails]: LogErrorDetails[Key];
  } = { name };
  if (typeof wire.message === "string")
    details.message = boundedText(wire.message, MAX_MESSAGE_CHARS);
  const code = finite(wire.code) ?? matching(wire.code, CODE_PATTERN);
  if (code !== undefined) details.code = code;
  const errno = finite(wire.errno);
  if (errno !== undefined) details.errno = errno;
  const syscall = matching(wire.syscall, SYSCALL_PATTERN);
  if (syscall) details.syscall = syscall;
  const exitCode = finite(wire.exitCode);
  if (exitCode !== undefined) details.exitCode = exitCode;
  const signal = matching(wire.signal, CODE_PATTERN);
  if (signal) details.signal = signal;
  if (wire.outputOmitted === true) details.outputOmitted = true;
  const errorCount = finite(wire.errorCount);
  if (errorCount !== undefined) details.errorCount = errorCount;
  if (Array.isArray(wire.stack)) {
    const frames = wire.stack
      .filter((frame): frame is string => typeof frame === "string")
      .slice(0, MAX_STACK_FRAMES)
      .map((frame) => boundedText(frame, MAX_FRAME_CHARS));
    if (frames.length > 0) details.stack = frames;
  }
  if (depth < MAX_CAUSE_DEPTH) {
    const cause = logErrorFromWire(wire.cause, depth + 1);
    if (cause) details.cause = cause;
  }
  return brand(details);
}
