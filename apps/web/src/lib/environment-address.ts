import type { Environment } from "@/types";
import { getGatewayBaseUrl } from "@/lib/gateway-url";

export function getEnvironmentPortAddress(environment: Environment | null | undefined): string | null {
  if (
    !environment ||
    // Local environments do not currently receive host port mappings.
    environment.environmentType === "local" ||
    environment.entryPort == null ||
    environment.hostEntryPort == null
  ) {
    return null;
  }

  if (typeof window !== "undefined" && window.orkestratorGateway?.enabled) {
    if (environment.hostEntryPort <= 0) return null;
    return `${getGatewayBaseUrl()}/__orkestrator/proxy/loopback/${environment.hostEntryPort}/`;
  }

  return `localhost:${environment.hostEntryPort}`;
}

/** Backend-local URL used as the initial address for an environment browser tab. */
export function getEnvironmentBrowserUrl(environment: Environment | null | undefined): string | null {
  if (
    !environment
    || environment.environmentType === "local"
    || environment.entryPort == null
    || environment.hostEntryPort == null
    || environment.hostEntryPort <= 0
  ) {
    return null;
  }

  return `http://localhost:${environment.hostEntryPort}/`;
}
