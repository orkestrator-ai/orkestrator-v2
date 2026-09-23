import type { BrowserPreviewTransportState } from "@orkestrator/protocol/browser-preview";
import {
  normalizePreviewPath,
  type PreviewCapabilities,
  type PreviewErrorCategory,
  type PreviewServiceDefinition,
  type PreviewServiceSnapshot,
} from "@orkestrator/protocol/preview-services";

/** The address the application believes it is served at, e.g. `http://localhost:3000/x`. */
export function serviceDisplayUrl(
  definition: Pick<PreviewServiceDefinition, "scheme" | "applicationPort">,
  path: string,
): string {
  return `${definition.scheme}://localhost:${definition.applicationPort}${path}`;
}

export type ServiceAddressInput =
  | { kind: "path"; path: string }
  | { kind: "other-port"; url: string }
  | { kind: "invalid"; message: string };

/**
 * Interpret the address bar of a service tab. A path (or a full address on
 * the service's own port) navigates within the service; an address on another
 * port asks the backend to resolve a different service. Nothing here builds a
 * transport URL.
 */
export function parseServiceAddressInput(
  input: string,
  definition: Pick<PreviewServiceDefinition, "applicationPort">,
): ServiceAddressInput {
  const value = input.trim();
  if (!value) return { kind: "path", path: "/" };
  try {
    if (value.startsWith("/") || value.startsWith("?") || value.startsWith("#")) {
      // Typed paths may contain spaces or non-ASCII; encode them the way a
      // browser would, since service paths travel as visible ASCII only.
      return {
        kind: "path",
        path: normalizePreviewPath(value.replace(/[^\x21-\x7e]/gu, encodeURIComponent)),
      };
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { kind: "invalid", message: "Only http and https addresses are supported." };
    }
    if (!["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname)) {
      return {
        kind: "invalid",
        message: "Service previews address the environment's loopback services.",
      };
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (port === definition.applicationPort) {
      return {
        kind: "path",
        path: normalizePreviewPath(`${url.pathname}${url.search}${url.hash}`),
      };
    }
    return { kind: "other-port", url: url.toString() };
  } catch (error) {
    return {
      kind: "invalid",
      message:
        error instanceof Error
          ? error.message.replace(/^PreviewError:[a-z-]+:\s*/, "")
          : "Invalid address.",
    };
  }
}

const TARGET_LABEL: Record<PreviewServiceDefinition["targetKind"], string> = {
  container: "container",
  worktree: "worktree",
  "backend-host": "backend host",
};

export function serviceTargetLabel(
  definition: Pick<PreviewServiceDefinition, "targetKind" | "applicationPort">,
): string {
  return `${TARGET_LABEL[definition.targetKind]}:${definition.applicationPort}`;
}

export type ServiceReadinessTone = "ready" | "starting" | "problem" | "unknown";

export function serviceReadiness(snapshot: PreviewServiceSnapshot): {
  label: string;
  tone: ServiceReadinessTone;
} {
  const { endpoint, definition } = snapshot;
  if (!definition.enabled) return { label: "disabled", tone: "problem" };
  if (endpoint.state === "unresolved" || endpoint.state === "resolving")
    return { label: "checking", tone: "unknown" };
  if (endpoint.state === "revoked") return { label: "reconnecting", tone: "starting" };
  if (endpoint.state === "unavailable") {
    const category = endpoint.failure?.category;
    if (category === "environment-stopped") return { label: "stopped", tone: "problem" };
    if (category === "target-unmapped") return { label: "not published", tone: "problem" };
    return { label: "unavailable", tone: "problem" };
  }
  const { tcp, http } = endpoint.readiness;
  if (tcp.state === "failed") return { label: "not listening", tone: "starting" };
  if (tcp.state === "pending") return { label: "checking", tone: "unknown" };
  if (http.state === "ok") return { label: `ready · ${http.statusClass ?? "http"}`, tone: "ready" };
  if (tcp.state === "ok") return { label: "ready", tone: "ready" };
  return { label: "available", tone: "unknown" };
}

/** `web · container:3000 · ready` */
export function serviceSummary(snapshot: PreviewServiceSnapshot): string {
  return `${snapshot.definition.label} · ${serviceTargetLabel(snapshot.definition)} · ${serviceReadiness(snapshot).label}`;
}

export type DiagnosisAction =
  | "retry"
  | "start-environment"
  | "configure-mapping"
  | "choose-service"
  | "reconnect"
  | "open-top-level"
  | "use-relay";

export interface ServiceDiagnosis {
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
  actions: DiagnosisAction[];
}

/**
 * One actionable explanation per failure layer. Page-loading problems are
 * reported separately by the view; this covers the route to the service.
 */
export function diagnoseService(
  snapshot: PreviewServiceSnapshot | null,
  options: {
    transport?: BrowserPreviewTransportState | null;
    capabilities?: PreviewCapabilities | null;
    backendOnline?: boolean;
  } = {},
): ServiceDiagnosis | null {
  if (options.backendOnline === false) {
    return {
      severity: "error",
      title: "Backend offline",
      detail:
        "Restore the backend or tailnet connection. The service identity is kept and reconnects afterwards.",
      actions: ["retry"],
    };
  }
  if (!snapshot) {
    return {
      severity: "error",
      title: "Service not found",
      detail:
        "This service was removed or belongs to another backend. Choose a service for this tab.",
      actions: ["choose-service"],
    };
  }
  const { endpoint, definition } = snapshot;
  const failure: PreviewErrorCategory | undefined = endpoint.failure?.category;
  if (!definition.enabled) {
    return {
      severity: "warning",
      title: "Service disabled",
      detail: "Enable the service in environment settings to preview it.",
      actions: ["choose-service"],
    };
  }
  if (failure === "environment-stopped") {
    return {
      severity: "warning",
      title: "Environment stopped",
      detail: "Start this environment to preview the service.",
      actions: ["start-environment", "retry"],
    };
  }
  if (failure === "target-unmapped") {
    const relay = options.capabilities?.relay.available === true;
    return {
      severity: "warning",
      title: `Container port ${definition.applicationPort} is not published`,
      detail: relay
        ? "Use the container relay to reach it without recreating the container, or add a port mapping (requires recreation)."
        : "Add a port mapping for this port in environment settings. Saving a mapping requires recreating the container.",
      actions: relay ? ["use-relay", "configure-mapping"] : ["configure-mapping", "retry"],
    };
  }
  if (failure === "target-unverified") {
    return {
      severity: "error",
      title: "Service owner could not be verified",
      detail: endpoint.failure?.message ?? "",
      actions: ["retry"],
    };
  }
  if (failure === "forbidden") {
    return {
      severity: "error",
      title: "Port not allowed",
      detail: endpoint.failure?.message ?? "This port cannot be previewed.",
      actions: ["choose-service"],
    };
  }
  if (endpoint.state === "available" && endpoint.readiness.tcp.state === "failed") {
    const container = definition.targetKind === "container";
    return {
      severity: "warning",
      title: `Nothing is listening on ${container ? "container" : "backend"} port ${definition.applicationPort}`,
      detail: container
        ? "Start the development server. Inside a container it must listen on 0.0.0.0, not only 127.0.0.1, to be reachable through the published port."
        : "Start the development server, or check that it listens on this port and address family.",
      actions: ["retry"],
    };
  }
  if (endpoint.readiness.tls.state === "failed") {
    return {
      severity: "error",
      title: "TLS verification failed",
      detail: `Expected a certificate valid for ${definition.tlsServerName ?? "localhost"}. Fix the certificate or its trust configuration; verification is never disabled.`,
      actions: ["retry"],
    };
  }
  const transport = options.transport;
  if (transport?.state === "unavailable") {
    if (transport.failure === "access-expired" || transport.failure === "forbidden") {
      return {
        severity: "warning",
        title: "Preview access expired",
        detail: "Reconnect to obtain fresh access for this service.",
        actions: ["reconnect"],
      };
    }
    if (transport.failure === "capacity-exceeded") {
      return {
        severity: "warning",
        title: "Preview at capacity",
        detail: "Close unused previews and retry.",
        actions: ["retry"],
      };
    }
    return {
      severity: "error",
      title: "Preview transport unavailable",
      detail: transport.message ?? "The desktop tunnel could not be opened.",
      actions: ["reconnect"],
    };
  }
  if (transport?.state === "reconnecting") {
    return {
      severity: "info",
      title: "Reconnecting",
      detail: "The service endpoint changed; new requests use fresh access.",
      actions: [],
    };
  }
  if (endpoint.state === "unavailable") {
    return {
      severity: "error",
      title: "Service unavailable",
      detail: endpoint.failure?.message ?? "The service could not be reached.",
      actions: ["retry"],
    };
  }
  return null;
}
