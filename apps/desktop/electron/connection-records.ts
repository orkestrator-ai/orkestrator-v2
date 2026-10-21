import { randomBytes } from "node:crypto";
import type { BackendHello } from "@orkestrator/protocol/backend-profile";
import {
  expandTailscaleMachineName,
  type ConnectionIdentityState,
  type ConnectionTransportState,
} from "@orkestrator/protocol/connections";
import {
  orderedRoutes,
  type SavedBackend,
  type SavedHttpsRoute,
  type SavedRoute,
} from "@orkestrator/protocol/device-catalogue";
import type { RouteId } from "@orkestrator/protocol/federation";
import type { HelloOutcome } from "./backend-hello.js";
import type { OpenedRoute } from "./connection-routes.js";

/** Catalogue record helpers and shared machine state for the connection manager. */

export type MachineStatus = {
  transport: ConnectionTransportState;
  detail?: string;
  hello?: BackendHello;
  identity: ConnectionIdentityState;
  lastHelloAt?: string;
  latencyMs?: number;
  /** Routes quarantined by a trust failure, with a sanitized reason. */
  blockedRoutes: Map<string, string>;
};

export type Established = {
  route: SavedRoute;
  transport: OpenedRoute;
  token: string;
  outcome: HelloOutcome;
};

export function normalizeRemoteAddress(
  value: string,
  knownAddresses: readonly string[] = [],
): string {
  const candidate = expandTailscaleMachineName(value, knownAddresses);
  if (!candidate) throw new Error("Enter the backend address.");
  if (
    candidate === value.trim() &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(candidate) &&
    candidate.toLowerCase() !== "localhost"
  ) {
    throw new Error(
      "Enter the full Tailscale HTTPS address once. Saved machines on that tailnet can then use a short name.",
    );
  }

  let url: URL;
  try {
    url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  } catch {
    throw new Error("Enter a valid backend URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The backend address must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Put the gateway token in the token field, not in the URL.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use the backend origin only, without a path, query, or fragment.");
  }
  const isLoopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("Remote backends must use HTTPS. Use the HTTPS address exposed by Tailscale.");
  }
  return url.origin;
}

export function newRouteId(kind: "https" | "ssh"): RouteId {
  return `${kind}-${randomBytes(6).toString("hex")}` as RouteId;
}

export function primaryHttpsRoute(backend: SavedBackend): SavedHttpsRoute | undefined {
  return orderedRoutes(backend).find((route): route is SavedHttpsRoute => route.kind === "https");
}

/** Display address of a machine: its first HTTPS origin, if it has one. */
export function backendAddress(backend: SavedBackend): string | null {
  return primaryHttpsRoute(backend)?.origin ?? null;
}

export function withAlias(backend: SavedBackend, alias: string | undefined): SavedBackend {
  const { localAlias: _previous, ...rest } = backend;
  return alias ? { ...rest, localAlias: alias } : rest;
}

export function replaceRoute(backend: SavedBackend, route: SavedRoute): SavedBackend {
  return {
    ...backend,
    routes: backend.routes.map((candidate) => (candidate.id === route.id ? route : candidate)),
  };
}
