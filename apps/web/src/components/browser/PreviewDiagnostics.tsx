import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Info, RefreshCw } from "lucide-react";
import type { BrowserPreviewTransportState } from "@orkestrator/protocol/browser-preview";
import type { PreviewServiceSnapshot } from "@orkestrator/protocol/preview-services";

import { Button } from "@/components/ui/button";
import {
  serviceTargetLabel,
  type DiagnosisAction,
  type ServiceDiagnosis,
} from "@/lib/preview-service-display";
import { cn } from "@/lib/utils";

const ACTION_LABEL: Record<DiagnosisAction, string> = {
  retry: "Retry",
  "start-environment": "Start environment",
  "configure-mapping": "Configure ports",
  "choose-service": "Choose service",
  reconnect: "Reconnect",
  "open-top-level": "Open top-level preview",
  "use-relay": "Use container relay",
};

export interface PreviewDiagnosticsProps {
  diagnosis: ServiceDiagnosis | null;
  service: PreviewServiceSnapshot | null;
  transport: BrowserPreviewTransportState | null;
  mode: "desktop-tunnel" | "compatibility" | "top-level" | "unsupported";
  onAction: (action: DiagnosisAction) => void;
  busy?: boolean;
}

function layer(state: string | undefined) {
  return state ?? "unknown";
}

/**
 * Route diagnostics: why the service is (un)reachable, separate from page
 * loading. The expandable route detail shows backend-side facts that are safe
 * to display to the user; it is not an export and holds no credential.
 */
export function PreviewDiagnostics({
  diagnosis,
  service,
  transport,
  mode,
  onAction,
  busy,
}: PreviewDiagnosticsProps) {
  const [expanded, setExpanded] = useState(false);
  if (!diagnosis && !expanded && mode !== "compatibility") {
    return service ? (
      <button
        type="button"
        className="flex w-full shrink-0 items-center gap-1 border-b border-border/60 bg-muted/10 px-3 py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
      >
        <ChevronRight className="h-3 w-3" />
        Route details
      </button>
    ) : null;
  }
  const Icon = diagnosis?.severity === "info" || !diagnosis ? Info : AlertTriangle;
  return (
    <div
      role={diagnosis && diagnosis.severity !== "info" ? "alert" : "status"}
      className={cn(
        "min-w-0 shrink-0 border-b px-3 py-1.5 text-xs",
        diagnosis?.severity === "error"
          ? "border-destructive/20 bg-destructive/10 text-destructive"
          : diagnosis?.severity === "warning"
            ? "border-amber-500/20 bg-amber-500/10 text-amber-200"
            : "border-border/60 bg-muted/20 text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          {diagnosis?.title ?? (mode === "compatibility" ? "Compatibility mode" : "Route details")}
        </span>
        <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
          {diagnosis?.detail ??
            (mode === "compatibility"
              ? "This backend uses the legacy path preview: HMR and application WebSockets may not work remotely, and cookies are shared across services."
              : "")}
        </span>
        {diagnosis?.actions.map((action) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={() => onAction(action)}
          >
            {action === "retry" && busy ? (
              <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            {ACTION_LABEL[action]}
          </Button>
        ))}
        {service && (
          <button
            type="button"
            className="flex items-center gap-0.5 text-[11px] opacity-80 hover:opacity-100"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Route
          </button>
        )}
      </div>
      {expanded && service && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          <dt>service</dt>
          <dd className="truncate">
            {service.definition.label} · {service.definition.scheme} ·{" "}
            {serviceTargetLabel(service.definition)}
            {service.endpoint.ownership === "user-registered" ? " · user-registered" : ""}
          </dd>
          <dt>binding</dt>
          <dd>
            {service.endpoint.hostPort
              ? `${service.endpoint.transportKind} → backend ${service.endpoint.addressFamily === "ipv6" ? "[::1]" : "127.0.0.1"}:${service.endpoint.hostPort}`
              : service.endpoint.state}
            {service.endpoint.containerId ? ` · container ${service.endpoint.containerId}` : ""}
          </dd>
          <dt>generation</dt>
          <dd>{service.endpoint.endpointGeneration}</dd>
          <dt>readiness</dt>
          <dd>
            env {layer(service.endpoint.readiness.environment.state)} · binding{" "}
            {layer(service.endpoint.readiness.binding.state)} · tcp{" "}
            {layer(service.endpoint.readiness.tcp.state)} · tls{" "}
            {layer(service.endpoint.readiness.tls.state)} · http{" "}
            {layer(service.endpoint.readiness.http.state)}
            {service.endpoint.readiness.http.statusClass
              ? ` (${service.endpoint.readiness.http.statusClass})`
              : ""}
          </dd>
          <dt>observed</dt>
          <dd>
            {service.endpoint.readiness.observedAt
              ? new Date(service.endpoint.readiness.observedAt).toLocaleTimeString()
              : "never"}
          </dd>
          <dt>transport</dt>
          <dd>
            {mode}
            {transport ? ` · ${transport.state}` : ""}
          </dd>
        </dl>
      )}
    </div>
  );
}
