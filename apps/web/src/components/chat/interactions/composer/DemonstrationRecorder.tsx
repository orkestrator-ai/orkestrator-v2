import { useEffect, useRef, useState } from "react";
import { Circle, Square } from "lucide-react";
import type {
  BrowserPreviewTraceResult,
  BrowserPreviewTraceStatus,
} from "@orkestrator/protocol/browser-preview";
import { Button } from "@/components/ui/button";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { richInteractionErrorMessage } from "@/lib/backend/rich-interactions";
import { newIdempotencyKey } from "@/lib/chat/rich-interactions";
import { useNodeScope } from "@/lib/node-scope/providers";
import { cn } from "@/lib/utils";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { inputClass, textareaClass } from "../shared";

function traceApi() {
  return typeof window === "undefined" ? undefined : window.orkestrator?.browserPreview?.trace;
}

/** Whether this client can record a demonstration (the desktop preview runtime). */
export function canRecordDemonstrations(): boolean {
  return Boolean(traceApi());
}

/**
 * Feature 20: record a demonstration in one browser preview tab, review it,
 * trim steps, add the expected outcome, and send it. Recording is explicit
 * (start/stop, a visible indicator), scoped to the preview's origin, and keeps
 * semantic steps only: typed values are never recorded. Clients without the
 * desktop recorder can still review demonstrations others sent.
 */
export function DemonstrationRecorder({
  environmentId,
  logicalSessionKey,
  onSent,
}: {
  environmentId: string;
  logicalSessionKey: string;
  onSent?: () => void;
}) {
  const api = traceApi();
  const scope = useNodeScope();
  const backend = useScopeBackend();
  const tabs = scope
    .store(paneLayoutStore)
    .getState()
    .getAllTabs(environmentId)
    .filter((tab) => tab.type === "browser" && tab.browserData);
  const [tabId, setTabId] = useState<string>(tabs[0]?.id ?? "");
  const [status, setStatus] = useState<BrowserPreviewTraceStatus | null>(null);
  const [trace, setTrace] = useState<BrowserPreviewTraceResult | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [observation, setObservation] = useState("");
  const [expected, setExpected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendKey = useRef<string | null>(null);
  const traceId = useRef(`trace-${newIdempotencyKey().slice(3, 15)}`);

  useEffect(() => {
    if (!api || !status?.recording || !tabId) return;
    const timer = setInterval(
      () =>
        void api
          .status(tabId)
          .then(setStatus)
          .catch(() => undefined),
      1_000,
    );
    return () => clearInterval(timer);
  }, [api, status?.recording, tabId]);

  if (!api) {
    return (
      <p className="text-xs text-muted-foreground">
        Recording a demonstration needs the desktop app's preview runtime. You can still review
        demonstrations in the transcript on this client.
      </p>
    );
  }
  const start = async () => {
    setError(null);
    setTrace(null);
    try {
      const tab = tabs.find((t) => t.id === tabId);
      setStatus(
        await api.start(
          tabId,
          tab?.browserData?.url ? new URL(tab.browserData.url).host : "Preview",
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recording could not start.");
    }
  };
  const stop = async () => {
    try {
      const result = await api.stop(tabId);
      setTrace(result);
      setKept(new Set(result.steps.map((s) => s.stepId)));
      setStatus(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recording could not stop.");
    }
  };
  const send = async () => {
    if (!trace) return;
    setSending(true);
    setError(null);
    sendKey.current ??= newIdempotencyKey();
    try {
      await backend.composeRichInteraction({
        environmentId,
        tabId: logicalSessionKey.slice(logicalSessionKey.indexOf(":") + 1),
        kind: "demonstration",
        title: `Demonstration: ${expected.trim().slice(0, 60) || trace.service.label}`,
        spec: {
          traceId: traceId.current,
          revision: 1,
          ...trace,
          steps: trace.steps.map((s) => ({ ...s, captureRefs: [] })),
          expectedOutcome: expected.trim(),
        },
        actionId: "send",
        idempotencyKey: sendKey.current,
        result: {
          stepIds: trace.steps.filter((s) => kept.has(s.stepId)).map((s) => s.stepId),
          expectedOutcome: expected.trim(),
        },
      });
      sendKey.current = null;
      setTrace(null);
      setExpected("");
      traceId.current = `trace-${newIdempotencyKey().slice(3, 15)}`;
      onSent?.();
    } catch (cause) {
      setError(`${richInteractionErrorMessage(cause)} The recording is kept; it is safe to retry.`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-xs">
      {!trace ? (
        <>
          <label className="flex items-center gap-2">
            Preview tab
            <select
              className={cn(inputClass, "w-auto py-1 text-xs")}
              value={tabId}
              disabled={Boolean(status?.recording)}
              onChange={(e) => setTabId(e.target.value)}
            >
              {tabs.length === 0 ? <option value="">No browser preview is open</option> : null}
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.browserData?.url || tab.id}
                </option>
              ))}
            </select>
          </label>
          {status?.recording ? (
            <div
              className="flex flex-col gap-2 rounded border border-red-500/40 bg-red-500/[0.06] p-2"
              role="status"
            >
              <p className="flex items-center gap-2 font-medium">
                <span className="size-2 animate-pulse rounded-full bg-red-500" aria-hidden />
                Recording {status.origin} · {Math.round(status.elapsedMs / 1000)} s · {status.steps}{" "}
                step(s). Typed values are not recorded.
              </p>
              <div className="flex gap-2">
                <input
                  className={cn(inputClass, "py-1 text-xs")}
                  placeholder="Mark “wrong here” with what you see"
                  aria-label="Observation"
                  value={observation}
                  onChange={(e) => setObservation(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void api
                      .mark(tabId, observation)
                      .then((s) => {
                        setStatus(s);
                        setObservation("");
                      })
                      .catch((c: unknown) =>
                        setError(c instanceof Error ? c.message : "Could not mark."),
                      )
                  }
                >
                  Wrong here
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void stop()}>
                  <Square className="size-3.5" aria-hidden />
                  Stop
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={!tabId}
              onClick={() => void start()}
            >
              <Circle className="size-3.5 text-red-500" aria-hidden />
              Record a demonstration
            </Button>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">
            Review before sending: {trace.steps.length} step(s) in {trace.service.origin}
            {trace.stopReason !== "user" ? ` · stopped: ${trace.stopReason}` : ""}. Uncheck steps to
            trim them.
          </p>
          <ol className="flex max-h-64 flex-col gap-1 overflow-auto">
            {trace.steps.map((step, index) => (
              <li key={step.stepId}>
                <label
                  className={cn(
                    "flex items-start gap-2 rounded border px-2 py-1",
                    kept.has(step.stepId)
                      ? "border-border/60"
                      : "border-dashed border-border/40 opacity-60",
                    step.wrongHere && "border-failure/50",
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 accent-primary"
                    checked={kept.has(step.stepId)}
                    onChange={(e) =>
                      setKept((current) => {
                        const next = new Set(current);
                        if (e.target.checked) next.add(step.stepId);
                        else next.delete(step.stepId);
                        return next;
                      })
                    }
                  />
                  <span>
                    {index + 1}. {(step.offsetMs / 1000).toFixed(1)}s{" "}
                    <span className="font-medium">{step.action}</span>{" "}
                    {step.target
                      ? [step.target.role, step.target.label ?? step.target.text]
                          .filter(Boolean)
                          .join(" ")
                      : ""}
                    {step.route ? (
                      <span className="text-muted-foreground"> on {step.route}</span>
                    ) : null}
                    {step.valueOmitted ? (
                      <span className="text-muted-foreground"> (value not recorded)</span>
                    ) : null}
                    {step.userObservation ? (
                      <span className="block text-muted-foreground">{step.userObservation}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ol>
          {trace.gaps.map((gap, i) => (
            <p key={i} className="text-amber-300">
              {gap.reason}
            </p>
          ))}
          <textarea
            className={textareaClass}
            rows={2}
            aria-label="Expected outcome"
            placeholder="What should have happened? (required)"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setTrace(null)}>
              Discard
            </Button>
            <Button
              size="sm"
              disabled={sending || !expected.trim() || kept.size === 0}
              onClick={() => void send()}
            >
              {sending ? "Sending…" : "Send demonstration"}
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <p className="text-failure" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
