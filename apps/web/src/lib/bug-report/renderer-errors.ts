import {
  MAX_BUG_REPORT_RENDERER_ERROR_CHARS,
  MAX_BUG_REPORT_RENDERER_ERRORS,
  type BugReportRendererError,
} from "@orkestrator/protocol/bug-report";

/**
 * The last few errors this renderer saw, for a bug report.
 *
 * Bounded in count and length, kept only in memory, and never sent anywhere
 * except into a report the user starts, where the agent is told to redact
 * them before they reach the public issue.
 */
const recent: BugReportRendererError[] = [];
let installed = false;

function describe(value: unknown): string {
  if (value instanceof Error) {
    const stack = value.stack?.split("\n").slice(0, 4).join(" | ");
    return stack && stack.includes(value.message) ? stack : `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function recordRendererError(
  kind: BugReportRendererError["kind"],
  ...values: unknown[]
): void {
  const message = values
    .map(describe)
    .join(" ")
    .trim()
    .slice(0, MAX_BUG_REPORT_RENDERER_ERROR_CHARS);
  if (!message) return;
  const last = recent.at(-1);
  // A render loop repeats one error; keep one copy of it.
  if (last?.message === message && last.kind === kind) return;
  recent.push({ at: new Date().toISOString(), kind, message });
  if (recent.length > MAX_BUG_REPORT_RENDERER_ERRORS)
    recent.splice(0, recent.length - MAX_BUG_REPORT_RENDERER_ERRORS);
}

export function recentRendererErrors(): BugReportRendererError[] {
  return recent.map((entry) => ({ ...entry }));
}

/** What the first `console.error` argument says it reports. */
export function rendererErrorKind(first: unknown): BugReportRendererError["kind"] {
  if (typeof first !== "string") return "console";
  // The logger's text form of the bootstrap handlers' two `web.window` events.
  if (first.startsWith("[web.window] rejection.unhandled")) return "unhandledrejection";
  if (first.startsWith("[web.window] error.unhandled")) return "error";
  return "console";
}

/**
 * Start recording. Idempotent. Window errors and unhandled rejections reach
 * `console.error` through the logger's console sink, which reads the method at
 * call time, so wrapping it sees them too; the original keeps logging everything
 * as before. This wraps the console itself, so it stays on the raw global.
 */
export function installRendererErrorRecorder(): void {
  if (installed) return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...values: unknown[]) => {
    try {
      recordRendererError(rendererErrorKind(values[0]), ...values);
    } catch {
      // Recording must never break logging.
    }
    original(...values);
  };
}

export function resetRendererErrorsForTests(): void {
  recent.length = 0;
}
