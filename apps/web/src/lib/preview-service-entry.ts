import type { BrowserPreviewServiceTarget } from "@orkestrator/protocol/browser-preview";
import {
  formatPreviewIntentUri,
  formatPreviewServiceUri,
  normalizePreviewPath,
  resolvePreviewEntryService,
  type PreviewCapabilities,
  type PreviewRegistrySnapshot,
  type PreviewServiceRef,
  type PreviewServiceSnapshot,
  type PreviewUrlSource,
} from "@orkestrator/protocol/preview-services";

import { isLoopbackUrl } from "@/lib/terminal-links";
import { ensurePreviewServiceSync, usePreviewServiceStore } from "@/stores/previewServiceStore";
import type { Environment } from "@/types";

/**
 * Target for the environment's browser button: the registered entry service
 * (resolved to a transport only when the tab attaches), falling back to the
 * legacy entry address when the backend predates preview services.
 */
export async function environmentBrowserTarget(
  environment: Pick<Environment, "id">,
  legacyUrl: string | null,
): Promise<string | undefined> {
  ensurePreviewServiceSync();
  const store = usePreviewServiceStore.getState();
  const capabilities = await store.loadCapabilities();
  if (!capabilities) return legacyUrl ?? undefined;
  const snapshot = await store.refreshEnvironment(environment.id);
  if (!snapshot) return legacyUrl ?? undefined;
  // The backend resolves the entry service; an older backend omits it, and the
  // same protocol rule is applied to its services here.
  const serviceId =
    snapshot.entryServiceId !== undefined
      ? snapshot.entryServiceId
      : (resolvePreviewEntryService(snapshot.services, environment.id)?.definition.serviceId ??
        null);
  if (!serviceId) return legacyUrl ?? undefined;
  return formatPreviewServiceUri({
    backendInstanceId: capabilities.backendInstanceId,
    environmentId: environment.id,
    serviceId,
    path: "/",
  });
}

/**
 * Target for a loopback link printed by a terminal or agent. It is kept as an
 * unresolved intent interpreted in its *source* environment, so a container's
 * `localhost:3000` means that container's port 3000 rather than whichever
 * backend process owns host port 3000. Non-loopback links and older backends
 * keep the previous behaviour.
 */
export function linkBrowserTarget(
  environment: Pick<Environment, "id" | "environmentType"> | null | undefined,
  url: string,
  origin: "terminal" | "agent" = "terminal",
): string {
  if (!environment || !isLoopbackUrl(url)) return url;
  ensurePreviewServiceSync();
  if (usePreviewServiceStore.getState().status === "unsupported") return url;
  const source = linkUrlSource(environment, origin);
  return formatPreviewIntentUri({ environmentId: environment.id, source, url: url.trim() });
}

/** Who interprets a printed loopback link: the terminal's environment, or the agent's. */
export function linkUrlSource(
  environment: Pick<Environment, "environmentType">,
  origin: "terminal" | "agent",
): PreviewUrlSource {
  if (origin === "agent") return "agent-link";
  return environment.environmentType === "local" ? "worktree-terminal" : "container-terminal";
}

/** A same-service link opened from inside a service preview. */
export function serviceLinkTarget(target: BrowserPreviewServiceTarget): string {
  return formatPreviewServiceUri(target);
}

/** Hosts a legacy URL tab can address: the backend machine's loopback. */
const LEGACY_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The backend host port a legacy URL tab (`http://localhost:<port>/…`) loads,
 * or null for anything that is not a plain loopback HTTP address.
 */
export function legacyUrlHostPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || !LEGACY_LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.username || parsed.password) return null;
  const port = parsed.port ? Number(parsed.port) : 80;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** A legacy URL tab's address that one current service owns. */
export interface LegacyUrlServiceMatch {
  service: PreviewServiceSnapshot;
  /** The durable service reference the tab would become, keeping the URL's path. */
  ref: PreviewServiceRef;
  /** The binding the match was made against; a conversion must still see it. */
  backendEpoch: string;
  endpointGeneration: number;
}

/**
 * The service a legacy URL tab can be opened as, or null.
 *
 * A host port says nothing durable about which application answers it, so a
 * match needs all of: the tab's own environment (never the active one), a
 * snapshot from the current backend identity and epoch, exactly one service in
 * that environment whose last resolved host port is the URL's port (a second
 * claimant, even a stale one, makes it ambiguous), and that service enabled
 * with an available endpoint of the current epoch and a host socket in the
 * literal URL's address family. Relay-only endpoints never claim host ports;
 * localhost stays manual until the legacy route's family is known. Anything
 * else keeps the tab as it is.
 */
export function legacyUrlServiceMatch(
  url: string,
  environmentId: string,
  capabilities: Pick<PreviewCapabilities, "backendInstanceId" | "backendEpoch"> | null | undefined,
  snapshot: PreviewRegistrySnapshot | null | undefined,
): LegacyUrlServiceMatch | null {
  const port = legacyUrlHostPort(url);
  if (port === null || !capabilities || !snapshot) return null;
  if (
    snapshot.backendInstanceId !== capabilities.backendInstanceId ||
    snapshot.backendEpoch !== capabilities.backendEpoch ||
    (snapshot.environmentId !== null && snapshot.environmentId !== environmentId)
  ) {
    return null;
  }
  const hostname = new URL(url).hostname;
  const family = hostname === "127.0.0.1" ? "ipv4" : hostname === "[::1]" ? "ipv6" : null;
  const claimants = snapshot.services.filter(
    (service) =>
      service.definition.environmentId === environmentId &&
      service.endpoint.hostPort === port &&
      (service.endpoint.transportKind === "backend-loopback" ||
        service.endpoint.transportKind === "published-port") &&
      (family === null || service.endpoint.addressFamily === family),
  );
  if (claimants.length !== 1) return null;
  const service = claimants[0]!;
  const { endpoint } = service;
  // localhost can resolve to a different socket family than this binding.
  // The snapshot does not establish which family the legacy view used.
  if (family === null) return null;
  if (
    !service.definition.enabled ||
    endpoint.state !== "available" ||
    endpoint.backendEpoch !== snapshot.backendEpoch
  ) {
    return null;
  }
  let path: string;
  try {
    const parsed = new URL(url);
    path = normalizePreviewPath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return null;
  }
  return {
    service,
    ref: {
      backendInstanceId: capabilities.backendInstanceId,
      environmentId,
      serviceId: service.definition.serviceId,
      path,
    },
    backendEpoch: endpoint.backendEpoch,
    endpointGeneration: endpoint.endpointGeneration,
  };
}

/** True when two matches name the same service binding (service, epoch and generation). */
export function sameLegacyUrlServiceBinding(
  left: LegacyUrlServiceMatch,
  right: LegacyUrlServiceMatch,
): boolean {
  return (
    left.ref.backendInstanceId === right.ref.backendInstanceId &&
    left.ref.environmentId === right.ref.environmentId &&
    left.ref.serviceId === right.ref.serviceId &&
    left.backendEpoch === right.backendEpoch &&
    left.endpointGeneration === right.endpointGeneration
  );
}

/**
 * Convert a legacy URL tab to the service that owns its port, re-checking the
 * offer against a fresh snapshot first: the tab converts only if the same
 * service still holds the same binding (epoch and endpoint generation), so a
 * port reassigned since the offer was shown is never followed. Returns the
 * service tab target, or null when the offer no longer holds.
 */
export async function confirmLegacyUrlServiceMatch(
  url: string,
  environmentId: string,
  offered: LegacyUrlServiceMatch,
): Promise<string | null> {
  ensurePreviewServiceSync();
  const store = usePreviewServiceStore.getState();
  const snapshot = await store.confirmEnvironment(environmentId);
  const current = legacyUrlServiceMatch(
    url,
    environmentId,
    usePreviewServiceStore.getState().capabilities,
    snapshot,
  );
  if (!current || !sameLegacyUrlServiceBinding(current, offered)) return null;
  return formatPreviewServiceUri(current.ref);
}
