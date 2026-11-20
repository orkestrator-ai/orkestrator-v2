/**
 * Demonstration recording in a browser preview (feature 20 of the interactive
 * sessions plan): an explicitly started, explicitly stopped sequence of
 * semantic steps from one preview tab.
 *
 * The page script observes only trusted user events (`isTrusted`) and records
 * what kind of action happened and what it targeted (role, accessible label,
 * short visible text). It never reads a field's value: typing is recorded as
 * "a value was entered". Routes are recorded as the path only, without query
 * or fragment. Page output is untrusted: main drains it on a timer and
 * revalidates and rebuilds every field. Leaving the recorded origin, closing
 * the preview, or reaching a step or time bound stops recording with the
 * reason, keeping every step captured so far.
 */
import type {
  BrowserPreviewTraceResult,
  BrowserPreviewTraceStatus,
  BrowserPreviewTraceStep,
} from "@orkestrator/protocol/browser-preview";

export const TRACE_BOUNDS = { steps: 120, durationMs: 5 * 60_000, pollMs: 500, labelChars: 120 } as const;

export interface TraceWebContents {
  getURL(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  isDestroyed(): boolean;
}

export interface TracePreviewHandle {
  contents: TraceWebContents;
  generation: number;
}

/**
 * Installed in the page as a literal script (never a serialized function, so
 * bundler helpers cannot leak into the page). It never reads a field value.
 */
const TRACE_SCRIPT = String.raw`(() => {
  const key = "__orkestratorTrace";
  if (window[key]) return;
  const queue = [];
  const started = performance.now();
  const clip = (text, max) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLAnchorElement) return "link";
    if (element instanceof HTMLSelectElement) return "combobox";
    if (element instanceof HTMLTextAreaElement) return "textbox";
    if (element instanceof HTMLInputElement) return element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : element.type === "submit" || element.type === "button" ? "button" : "textbox";
    return element.tagName.toLowerCase();
  };
  const describe = (node) => {
    const element = node instanceof Element ? (node.closest("button,a,input,select,textarea,[role],label,summary") || node) : null;
    if (!element) return {};
    let label = element.getAttribute("aria-label");
    if (!label && element.id) {
      const owner = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
      label = owner ? owner.textContent : null;
    }
    if (!label) label = element.getAttribute("title") || element.getAttribute("placeholder");
    const entry = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    return { role: clip(roleOf(element), 40), label: clip(label, 120), text: entry ? "" : clip(element.innerText, 80) };
  };
  const push = (action, target, extra) => {
    if (queue.length >= 200) return;
    queue.push(Object.assign({ action, target: describe(target), route: location.pathname }, extra || {}));
  };
  document.addEventListener("click", (event) => { if (event.isTrusted) push("click", event.target); }, true);
  document.addEventListener("change", (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    const choice = target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio"));
    if (choice) push("select", target);
    else push("input", target, { valueOmitted: true });
  }, true);
  document.addEventListener("submit", (event) => { if (event.isTrusted) push("submit", event.target); }, true);
  document.addEventListener("keydown", (event) => {
    if (event.isTrusted && !event.repeat && (event.key === "Enter" || event.key === "Escape")) push("keypress", event.target);
  }, true);
  Object.defineProperty(window, key, { value: () => queue.splice(0), configurable: false, enumerable: false });
  void started;
})();`;
const DRAIN_SCRIPT = `typeof window.__orkestratorTrace === "function" ? window.__orkestratorTrace() : null`;

const ACTIONS = new Set(["click", "input", "select", "submit", "keypress"]);

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.slice(0, 1_000);
  } catch {
    return "/";
  }
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return clean || undefined;
}

interface TraceSession {
  tabId: string;
  label: string;
  origin: string;
  startedAt: number;
  generation: number;
  segment: number;
  steps: BrowserPreviewTraceStep[];
  gaps: BrowserPreviewTraceResult["gaps"];
  stopReason: BrowserPreviewTraceResult["stopReason"] | null;
  timer: ReturnType<typeof setInterval> | null;
  lastRoute: string;
}

export class BrowserPreviewTraceSessions {
  private readonly sessions = new Map<string, TraceSession>();

  constructor(private readonly options: { preview: (tabId: string) => TracePreviewHandle | null; now?: () => number }) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async start(tabId: string, label: string): Promise<BrowserPreviewTraceStatus> {
    const handle = this.options.preview(tabId);
    if (!handle || handle.contents.isDestroyed()) throw new Error("The preview is not open.");
    const origin = originOf(handle.contents.getURL());
    if (!origin) throw new Error("Only an http(s) preview can be recorded.");
    this.stopTimer(tabId);
    const session: TraceSession = {
      tabId,
      label: label.slice(0, 120) || origin,
      origin,
      startedAt: this.now(),
      generation: handle.generation,
      segment: 0,
      steps: [],
      gaps: [],
      stopReason: null,
      timer: null,
      lastRoute: pathOf(handle.contents.getURL()),
    };
    this.sessions.set(tabId, session);
    await handle.contents.executeJavaScript(TRACE_SCRIPT, false);
    session.timer = setInterval(() => void this.poll(session), TRACE_BOUNDS.pollMs);
    session.timer.unref?.();
    return this.status(tabId);
  }

  status(tabId: string): BrowserPreviewTraceStatus {
    const session = this.sessions.get(tabId);
    if (!session) return { recording: false, steps: 0, elapsedMs: 0, stopReason: null };
    return { recording: session.stopReason === null, steps: session.steps.length, elapsedMs: this.now() - session.startedAt, stopReason: session.stopReason, origin: session.origin };
  }

  /** A "wrong here" marker with the person's own observation (host-owned, not page text). */
  mark(tabId: string, observation: string): BrowserPreviewTraceStatus {
    const session = this.sessions.get(tabId);
    if (!session || session.stopReason) throw new Error("No recording is in progress.");
    this.append(session, { action: "mark", target: undefined, route: session.lastRoute, userObservation: text(observation, 2_000), wrongHere: true });
    return this.status(tabId);
  }

  async stop(tabId: string): Promise<BrowserPreviewTraceResult> {
    const session = this.sessions.get(tabId);
    if (!session) throw new Error("No recording exists for this preview.");
    if (!session.stopReason) {
      await this.poll(session);
      this.finish(session, session.stopReason ?? "user");
    }
    this.sessions.delete(tabId);
    return {
      service: { label: session.label, origin: session.origin },
      startedAt: new Date(session.startedAt).toISOString(),
      durationMs: Math.min(TRACE_BOUNDS.durationMs, Math.max(0, (session.steps.at(-1)?.offsetMs ?? 0))),
      steps: session.steps,
      gaps: session.gaps,
      stopReason: session.stopReason ?? "user",
    };
  }

  /** The preview closed: stop, keeping the steps for review. */
  previewClosed(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session && !session.stopReason) this.finish(session, "preview-closed");
  }

  dispose(): void {
    for (const tabId of this.sessions.keys()) this.stopTimer(tabId);
    this.sessions.clear();
  }

  private stopTimer(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session?.timer) clearInterval(session.timer);
    if (session) session.timer = null;
  }

  private finish(session: TraceSession, reason: NonNullable<TraceSession["stopReason"]>): void {
    session.stopReason = reason;
    this.stopTimer(session.tabId);
  }

  private async poll(session: TraceSession): Promise<void> {
    if (session.stopReason) return;
    if (this.now() - session.startedAt >= TRACE_BOUNDS.durationMs) return this.finish(session, "time-limit");
    const handle = this.options.preview(session.tabId);
    if (!handle || handle.contents.isDestroyed()) return this.finish(session, "preview-closed");
    const url = handle.contents.getURL();
    if (originOf(url) !== session.origin) {
      // Never broaden the recording silently: leaving the service stops it.
      session.gaps.push({ ...(session.steps.at(-1) ? { afterStepId: session.steps.at(-1)!.stepId } : {}), reason: "The preview left the recorded service; recording stopped." });
      return this.finish(session, "left-service");
    }
    if (handle.generation !== session.generation) {
      // A new document: its events before the recorder was reinstalled are a gap.
      session.generation = handle.generation;
      session.segment += 1;
      session.lastRoute = pathOf(url);
      this.append(session, { action: "navigate", target: undefined, route: session.lastRoute });
      try {
        await handle.contents.executeJavaScript(TRACE_SCRIPT, false);
      } catch {
        session.gaps.push({ afterStepId: session.steps.at(-1)?.stepId, reason: "The recorder could not attach to the new page." } as BrowserPreviewTraceResult["gaps"][number]);
      }
      return;
    }
    let drained: unknown;
    try {
      drained = await handle.contents.executeJavaScript(DRAIN_SCRIPT, false);
    } catch {
      return;
    }
    if (drained === null) {
      // The script is gone without a generation change (an in-page reset): reinstall.
      await handle.contents.executeJavaScript(TRACE_SCRIPT, false).catch(() => undefined);
      return;
    }
    if (!Array.isArray(drained)) return;
    for (const raw of drained.slice(0, 200)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.action !== "string" || !ACTIONS.has(record.action)) continue;
      const target = record.target && typeof record.target === "object" ? (record.target as Record<string, unknown>) : {};
      const route = typeof record.route === "string" ? record.route.split(/[?#]/u)[0]!.slice(0, 1_000) : session.lastRoute;
      session.lastRoute = route;
      this.append(session, {
        action: record.action as BrowserPreviewTraceStep["action"],
        target: { ...(text(target.role, 40) ? { role: text(target.role, 40) } : {}), ...(text(target.label, TRACE_BOUNDS.labelChars) ? { label: text(target.label, TRACE_BOUNDS.labelChars) } : {}), ...(text(target.text, 80) ? { text: text(target.text, 80) } : {}) },
        route,
        ...(record.valueOmitted === true ? { valueOmitted: true } : {}),
      });
      if (session.stopReason) break;
    }
  }

  private append(session: TraceSession, step: Omit<BrowserPreviewTraceStep, "stepId" | "offsetMs" | "documentSegment">): void {
    if (session.steps.length >= TRACE_BOUNDS.steps) {
      this.finish(session, "step-limit");
      return;
    }
    const target = step.target && Object.keys(step.target).length ? step.target : undefined;
    const { target: _target, ...rest } = step;
    session.steps.push({
      ...rest,
      ...(target ? { target } : {}),
      stepId: `step-${session.steps.length + 1}`,
      offsetMs: Math.min(TRACE_BOUNDS.durationMs, this.now() - session.startedAt),
      documentSegment: session.segment,
    });
    if (session.steps.length >= TRACE_BOUNDS.steps) this.finish(session, "step-limit");
  }
}
