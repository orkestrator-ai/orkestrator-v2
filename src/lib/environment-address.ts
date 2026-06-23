import type { Environment } from "@/types";

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
    return `${window.location.origin}/__orkestrator/proxy/loopback/${environment.hostEntryPort}/`;
  }

  return `localhost:${environment.hostEntryPort}`;
}
