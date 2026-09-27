import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DesignAgent, DesignReadinessView } from "./design-launch";

type Tone = "ok" | "warn" | "error" | "pending";

interface Fact {
  key: string;
  label: string;
  tone: Tone;
  title: string;
  detail?: ReactNode;
}

export const DESIGN_AGENT_LABELS: Record<DesignAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

const CAPABLE_WITHOUT_RENDERER =
  "You can still open, rename, export and import designs; imports are stored unvalidated.";

function rendererFact(view: DesignReadinessView): Fact {
  const renderer = view.renderer;
  const base = { key: "renderer", label: "Renderer" };
  switch (renderer.state) {
    case "missing-executable":
      return {
        ...base,
        tone: "error",
        title: "Chromium is not installed on this backend",
        detail: (
          <>
            {renderer.executableConfigured ? (
              <>
                A custom browser path is configured, but no executable was found there. Check{" "}
                <code className="rounded bg-muted px-1">ORKESTRATOR_DESIGN_CHROMIUM_PATH</code>.
              </>
            ) : (
              <>
                Install Chromium or Google Chrome on the backend machine, or set{" "}
                <code className="rounded bg-muted px-1">ORKESTRATOR_DESIGN_CHROMIUM_PATH</code> to
                its executable.
              </>
            )}{" "}
            Then press Retry — no restart is needed. {CAPABLE_WITHOUT_RENDERER}
          </>
        ),
      };
    case "launch-failed":
      return {
        ...base,
        tone: "error",
        title: "Chromium was found but failed to launch",
        detail: `${renderer.message} ${CAPABLE_WITHOUT_RENDERER}`,
      };
    case "recovering":
      return {
        ...base,
        tone: "warn",
        title: "The render service is restarting after a failure",
        detail:
          "Designs stay available; captures and validation resume shortly. Retry in a moment.",
      };
    case "saturated":
      return {
        ...base,
        tone: "warn",
        title: "The render queue is temporarily full",
        detail: `${renderer.queued ?? 0} render jobs are waiting. Designs stay available; captures and validation wait their turn.`,
      };
    case "stopping":
      return {
        ...base,
        tone: "warn",
        title: "The renderer is shutting down",
        detail: "Retry once the backend has restarted it.",
      };
    case "ready":
    case "running":
      return {
        ...base,
        tone: "ok",
        title: "Renderer ready",
        ...(renderer.running ? { detail: `${renderer.running} render in progress.` } : {}),
      };
    default:
      return {
        ...base,
        tone: "pending",
        title: "Renderer not checked yet",
        detail: "It starts when a design needs it.",
      };
  }
}

function backendFact(view: DesignReadinessView): Fact {
  const base = { key: "backend", label: "Backend" };
  switch (view.backend.state) {
    case "connected":
      return {
        ...base,
        tone: "ok",
        title: view.protocol === "v1" ? "Connected (older design backend)" : "Connected",
        ...(view.protocol === "v1"
          ? { detail: "Library search, rename, duplicate and trash need a newer backend." }
          : {}),
      };
    case "disconnected":
      return {
        ...base,
        tone: "error",
        title: "Disconnected",
        detail: "Reconnect to the backend, then press Retry. Your draft is kept.",
      };
    case "unauthorized":
      return { ...base, tone: "error", title: "Sign-in required", detail: view.backend.message };
    default:
      return {
        ...base,
        tone: "error",
        title: "Design service unavailable",
        detail: view.backend.message,
      };
  }
}

function storageFact(view: DesignReadinessView): Fact {
  const base = { key: "storage", label: "Storage" };
  if (view.storage.state === "available")
    return {
      ...base,
      tone: "ok",
      title: "Available",
      ...(view.storage.limit
        ? { detail: `${view.storage.canvases ?? 0} of ${view.storage.limit} designs used.` }
        : {}),
    };
  if (view.storage.state === "unavailable")
    return { ...base, tone: "error", title: "Unavailable", detail: view.storage.message };
  return { ...base, tone: "pending", title: "Not reported", detail: view.storage.message };
}

function agentFact(agents: Record<DesignAgent, boolean>, selected: DesignAgent | null): Fact {
  const base = { key: "agent", label: "Agent" };
  if (selected === null)
    return {
      ...base,
      tone: "ok",
      title: "Blank canvas",
      detail: "No agent conversation will be started.",
    };
  const label = DESIGN_AGENT_LABELS[selected];
  if (agents[selected]) return { ...base, tone: "ok", title: `${label} is enabled` };
  const other = (Object.keys(agents) as DesignAgent[]).find(
    (agent) => agent !== selected && agents[agent],
  );
  return {
    ...base,
    tone: "warn",
    title: `${label} is disabled in Settings`,
    detail: other
      ? `Enable it in Settings, choose ${DESIGN_AGENT_LABELS[other]}, or start with a blank canvas.`
      : "Enable Claude or Codex in Settings, or start with a blank canvas.",
  };
}

/** One sentence for screen readers summarizing what the user can do now. */
export function readinessSummary(view: DesignReadinessView | null, loading: boolean): string {
  if (!view)
    return loading ? "Checking design services…" : "Design services have not been checked.";
  if (view.backend.state !== "connected")
    return `Design backend ${backendFact(view).title.toLowerCase()}.`;
  if (view.storage.state === "unavailable") return "Design storage is unavailable.";
  const renderer = rendererFact(view);
  if (renderer.tone === "error")
    return `Renderer unavailable: ${renderer.title}. ${CAPABLE_WITHOUT_RENDERER}`;
  if (renderer.tone === "warn") return `${renderer.title}.`;
  return loading ? "Rechecking design services…" : "Design services ready.";
}

const ICONS: Record<Tone, ReactNode> = {
  ok: <CheckCircle2 aria-hidden className="size-4 shrink-0 text-emerald-600" />,
  warn: <AlertTriangle aria-hidden className="size-4 shrink-0 text-amber-600" />,
  error: <XCircle aria-hidden className="size-4 shrink-0 text-destructive" />,
  pending: <Loader2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
};

export function DesignReadinessPanel({
  view,
  loading,
  onRetry,
  agents,
  selectedAgent,
}: {
  view: DesignReadinessView | null;
  loading: boolean;
  onRetry: () => void;
  agents: Record<DesignAgent, boolean>;
  selectedAgent: DesignAgent | null;
}) {
  const facts: Fact[] = view
    ? [
        backendFact(view),
        ...(view.backend.state === "connected" ? [storageFact(view), rendererFact(view)] : []),
        agentFact(agents, selectedAgent),
      ]
    : [];
  return (
    <section aria-label="Design readiness" className="grid gap-2 rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p role="status" aria-live="polite" className="font-medium">
          {readinessSummary(view, loading)}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={loading}
          aria-label="Retry design readiness checks"
        >
          <RefreshCw aria-hidden className={cn("size-3.5", loading && "animate-spin")} />
          Retry
        </Button>
      </div>
      {facts.length > 0 && (
        <ul className="grid gap-1.5">
          {facts.map((fact) => (
            <li key={fact.key} className="flex gap-2" data-fact={fact.key} data-tone={fact.tone}>
              {ICONS[fact.tone]}
              <div className="min-w-0">
                <span className="text-muted-foreground">{fact.label}: </span>
                <span>{fact.title}</span>
                {fact.detail && <p className="text-xs text-muted-foreground">{fact.detail}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
