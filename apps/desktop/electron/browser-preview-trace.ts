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
import { randomUUID } from "node:crypto";
import type {
  BrowserPreviewTraceResult,
  BrowserPreviewTraceStatus,
  BrowserPreviewTraceStep,
} from "@orkestrator/protocol/browser-preview";

export const TRACE_BOUNDS = {
  steps: 120,
  durationMs: 5 * 60_000,
  pollMs: 500,
  labelChars: 120,
  retainedPreviews: 64,
} as const;

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
const traceInstallScript = (token: string, origin: string) => String.raw`(() => {
  const token = ${JSON.stringify(token)};
  if (location.origin !== ${JSON.stringify(origin)}) return;
  const key = "__orkestratorTrace";
  if (window[key]?.token === token) return;
  window[key]?.finish?.();
  const controller = new AbortController();
  const listener = { capture: true, signal: controller.signal };
  const queue = [];
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
  const editableSelector = 'input,textarea,select,[contenteditable],[role="textbox"]';
  const containsEditable = (element) =>
    element.isContentEditable || element.closest(editableSelector) || element.querySelector(editableSelector);
  const describe = (node) => {
    const element = node instanceof Element ? (node.closest("button,a,input,select,textarea,[role],label,summary") || node) : null;
    if (!element) return {};
    const role = clip(roleOf(element), 40);
    if (containsEditable(element) || (node instanceof Element && containsEditable(node))) return { role };
    let label = element.getAttribute("aria-label");
    if (!label && element.id) {
      const owner = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
      label = owner && !containsEditable(owner) ? owner.textContent : null;
    }
    if (!label) label = element.getAttribute("title") || element.getAttribute("placeholder");
    return { role, label: clip(label, 120), text: clip(element.innerText, 80) };
  };
  const push = (action, target, extra) => {
    if (queue.length >= 200) return;
    queue.push(Object.assign({ action, target: describe(target), route: location.pathname }, extra || {}));
  };
  document.addEventListener("click", (event) => { if (event.isTrusted) push("click", event.target); }, listener);
  document.addEventListener("change", (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    const choice = target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio"));
    if (choice) push("select", target);
    else push("input", target, { valueOmitted: true });
  }, listener);
  document.addEventListener("submit", (event) => { if (event.isTrusted) push("submit", event.target); }, listener);
  document.addEventListener("keydown", (event) => {
    if (event.isTrusted && !event.repeat && (event.key === "Enter" || event.key === "Escape")) push("keypress", event.target);
  }, listener);
  const drain = () => queue.splice(0);
  const finish = () => {
    controller.abort();
    delete window[key];
    return drain();
  };
  Object.defineProperty(window, key, { value: { token, drain, finish }, configurable: true });

})();`;
const traceDrainScript = (token: string, finish: boolean) =>
  `window.__orkestratorTrace?.token === ${JSON.stringify(token)} ? window.__orkestratorTrace.${finish ? "finish" : "drain"}() : null`;

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
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
  return clean || undefined;
}

interface TraceSession {
  tabId: string;
  token: string;
  contents: TraceWebContents;
  installing: Promise<unknown>;
  polling: Promise<void> | null;
  stopping: Promise<BrowserPreviewTraceResult> | null;
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

  constructor(
    private readonly options: {
      preview: (tabId: string) => TracePreviewHandle | null;
      now?: () => number;
      /** Shared by preview runtimes owned by the same desktop window. */
      retained?: () => Map<string, BrowserPreviewTraceResult> | undefined;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async start(tabId: string, label: string): Promise<BrowserPreviewTraceStatus> {
    if (this.sessions.has(tabId) || this.options.retained?.()?.has(tabId))
      throw new Error("Stop and review the existing recording before starting another.");
    const handle = this.options.preview(tabId);
    if (!handle || handle.contents.isDestroyed()) throw new Error("The preview is not open.");
    const origin = originOf(handle.contents.getURL());
    if (!origin) throw new Error("Only an http(s) preview can be recorded.");
    const session: TraceSession = {
      tabId,
      token: randomUUID(),
      contents: handle.contents,
      installing: Promise.resolve(),
      polling: null,
      stopping: null,
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
    session.installing = this.install(session, handle);
    try {
      await session.installing;
    } catch (error) {
      this.finish(session, "user");
      if (this.sessions.get(tabId) === session && !session.stopping) this.sessions.delete(tabId);
      throw error;
    }
    if (session.stopReason || session.stopping || this.sessions.get(tabId) !== session)
      return this.status(tabId);
    session.timer = setInterval(
      () => void this.poll(session).catch(() => undefined),
      TRACE_BOUNDS.pollMs,
    );
    session.timer.unref?.();
    return this.status(tabId);
  }

  status(tabId: string): BrowserPreviewTraceStatus {
    const session = this.sessions.get(tabId);
    if (!session) {
      const retained = this.options.retained?.()?.get(tabId);
      return retained
        ? {
            recording: false,
            steps: retained.steps.length,
            elapsedMs: retained.durationMs,
            stopReason: retained.stopReason,
            origin: retained.service.origin,
          }
        : { recording: false, steps: 0, elapsedMs: 0, stopReason: null };
    }
    return {
      recording: session.stopReason === null,
      steps: session.steps.length,
      elapsedMs: this.now() - session.startedAt,
      stopReason: session.stopReason,
      origin: session.origin,
    };
  }

  /** A "wrong here" marker with the person's own observation (host-owned, not page text). */
  mark(tabId: string, observation: string): BrowserPreviewTraceStatus {
    const session = this.sessions.get(tabId);
    if (!session || session.stopReason) throw new Error("No recording is in progress.");
    this.append(session, {
      action: "mark",
      target: undefined,
      route: session.lastRoute,
      userObservation: text(observation, 2_000),
      wrongHere: true,
    });
    return this.status(tabId);
  }

  async stop(tabId: string, retain = false): Promise<BrowserPreviewTraceResult> {
    const session = this.sessions.get(tabId);
    if (!session) {
      const retained = this.options.retained?.();
      const result = retained?.get(tabId);
      if (!result) throw new Error("No recording exists for this preview.");
      if (!retain) retained?.delete(tabId);
      return result;
    }
    session.stopping ??= this.stopSession(session);
    const result = await session.stopping;
    if (!retain) {
      if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
      const retained = this.options.retained?.();
      if (retained?.get(tabId)?.steps === session.steps) retained.delete(tabId);
    }
    return result;
  }

  private async stopSession(session: TraceSession): Promise<BrowserPreviewTraceResult> {
    this.stopTimer(session);
    await session.installing.catch(() => undefined);
    await session.polling?.catch(() => undefined);
    if (!session.stopReason) {
      await this.readPage(session, true);
      this.finish(session, session.stopReason ?? "user");
    }
    return this.result(session);
  }

  private result(session: TraceSession): BrowserPreviewTraceResult {
    return {
      service: { label: session.label, origin: session.origin },
      startedAt: new Date(session.startedAt).toISOString(),
      durationMs: Math.min(
        TRACE_BOUNDS.durationMs,
        Math.max(0, session.steps.at(-1)?.offsetMs ?? 0),
      ),
      steps: session.steps,
      gaps: session.gaps,
      stopReason: session.stopReason ?? "user",
    };
  }

  /** The preview closed: stop, keeping the steps for review. */
  previewClosed(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (!session.stopReason) this.finish(session, "preview-closed");
    const retained = this.options.retained?.();
    if (!retained) return;
    retained.set(tabId, this.result(session));
    while (retained.size > TRACE_BOUNDS.retainedPreviews) {
      const oldest = retained.keys().next().value;
      if (oldest === undefined) break;
      retained.delete(oldest);
    }
    this.sessions.delete(tabId);
  }

  dispose(): void {
    for (const session of this.sessions.values()) this.finish(session, "preview-closed");
    this.sessions.clear();
  }

  private stopTimer(session: TraceSession): void {
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
  }

  private async removeListeners(session: TraceSession, contents: TraceWebContents): Promise<void> {
    try {
      if (!contents.isDestroyed())
        await contents.executeJavaScript(traceDrainScript(session.token, true), false);
    } catch {
      // The preview may have navigated or closed before main removed the listeners.
    }
  }

  private async install(session: TraceSession, handle: TracePreviewHandle): Promise<void> {
    session.contents = handle.contents;
    await handle.contents.executeJavaScript(
      traceInstallScript(session.token, session.origin),
      false,
    );
    if (session.stopReason || this.sessions.get(session.tabId) !== session)
      await this.removeListeners(session, handle.contents);
  }

  private finish(session: TraceSession, reason: NonNullable<TraceSession["stopReason"]>): void {
    session.stopReason ??= reason;
    this.stopTimer(session);
    void this.removeListeners(session, session.contents);
  }

  private poll(session: TraceSession): Promise<void> {
    session.polling ??= this.readPage(session, false).finally(() => {
      session.polling = null;
    });
    return session.polling;
  }

  private async readPage(session: TraceSession, stopping: boolean): Promise<void> {
    if (session.stopReason) return;
    if (this.now() - session.startedAt >= TRACE_BOUNDS.durationMs)
      return this.finish(session, "time-limit");
    const handle = this.options.preview(session.tabId);
    if (!handle || handle.contents.isDestroyed()) return this.finish(session, "preview-closed");
    const url = handle.contents.getURL();
    if (originOf(url) !== session.origin) {
      // Never broaden the recording silently: leaving the service stops it.
      session.gaps.push({
        ...(session.steps.at(-1) ? { afterStepId: session.steps.at(-1)!.stepId } : {}),
        reason: "The preview left the recorded service; recording stopped.",
      });
      return this.finish(session, "left-service");
    }
    if (handle.generation !== session.generation) {
      // A new document: its events before the recorder was reinstalled are a gap.
      session.generation = handle.generation;
      session.segment += 1;
      session.lastRoute = pathOf(url);
      this.append(session, { action: "navigate", target: undefined, route: session.lastRoute });
      try {
        if (!session.stopReason && !stopping) await this.install(session, handle);
      } catch {
        if (session.stopReason) return;
        session.gaps.push({
          afterStepId: session.steps.at(-1)?.stepId,
          reason: "The recorder could not attach to the new page.",
        } as BrowserPreviewTraceResult["gaps"][number]);
      }
      return;
    }
    let drained: unknown;
    try {
      drained = await handle.contents.executeJavaScript(
        traceDrainScript(session.token, stopping),
        false,
      );
    } catch {
      return;
    }
    if (
      session.stopReason ||
      this.sessions.get(session.tabId) !== session ||
      this.options.preview(session.tabId)?.generation !== handle.generation
    )
      return;
    if (drained === null) {
      // The script is gone without a generation change (an in-page reset): reinstall.
      if (!stopping) await this.install(session, handle).catch(() => undefined);
      return;
    }
    if (!Array.isArray(drained)) return;
    for (const raw of drained.slice(0, 200)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.action !== "string" || !ACTIONS.has(record.action)) continue;
      const target =
        record.target && typeof record.target === "object"
          ? (record.target as Record<string, unknown>)
          : {};
      const route =
        typeof record.route === "string"
          ? record.route.split(/[?#]/u)[0]!.slice(0, 1_000)
          : session.lastRoute;
      session.lastRoute = route;
      this.append(session, {
        action: record.action as BrowserPreviewTraceStep["action"],
        target: {
          ...(text(target.role, 40) ? { role: text(target.role, 40) } : {}),
          ...(text(target.label, TRACE_BOUNDS.labelChars)
            ? { label: text(target.label, TRACE_BOUNDS.labelChars) }
            : {}),
          ...(text(target.text, 80) ? { text: text(target.text, 80) } : {}),
        },
        route,
        ...(record.valueOmitted === true ? { valueOmitted: true } : {}),
      });
      if (session.stopReason) break;
    }
  }

  private append(
    session: TraceSession,
    step: Omit<BrowserPreviewTraceStep, "stepId" | "offsetMs" | "documentSegment">,
  ): void {
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
