/**
 * The host's Cursor key, as granted to an agent-test profile.
 *
 * Cursor's login is not in a provider home the profile can point at: it is
 * Orkestrator's own stored key or minted SDK login, both in the production data
 * directory. `dev:test` writes the effective one as an owner-only snapshot into
 * the profile's credential root on every start, and removes it when the profile
 * does not authorize Cursor or the host has no login.
 *
 * The key is held in this module rather than exported into `process.env`, which
 * local terminals and every child process inherit. It is read where an
 * inherited `CURSOR_API_KEY` would be, with a distinct source and expiry.
 * A stored key in the profile's own settings still wins.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

/** Written by `seedAgentTestProviderCredentials` in `apps/desktop/scripts/dev/profile-io.ts`. */
export function agentTestHostCursorCredentialPath(dataDir: string): string {
  return path.join(dataDir, "agent-credentials", "cursor", "host-api-key.json");
}

const MAX_SNAPSHOT_BYTES = 64 * 1024;
/**
 * Process-wide on purpose: the process entry loads it once from its own data
 * directory, so two agent-test backends in one process would see one key
 * (docs/architecture/backend-runtime.md).
 */
let hostCursorCredential: { apiKey: string; apiKeyExpiresAtMs?: number } | undefined;

export type CursorApiKeySource = "config" | "host-env" | "host-snapshot" | "none";

/** Read the snapshot once at startup; a later host change applies on the next start. */
export function loadAgentTestHostCursorApiKey(options: {
  dataDir: string;
  runtimeFlavor?: string;
  credentialSources?: ReadonlySet<AgentPlatform>;
}): void {
  hostCursorCredential = undefined;
  if (options.runtimeFlavor !== "agent-test" || !options.credentialSources?.has("cursor")) return;
  try {
    const raw = readFileSync(agentTestHostCursorCredentialPath(options.dataDir), "utf8");
    if (raw.length > MAX_SNAPSHOT_BYTES) return;
    const parsed = JSON.parse(raw) as { apiKey?: unknown; apiKeyExpiresAtMs?: unknown } | null;
    const apiKey = typeof parsed?.apiKey === "string" ? parsed.apiKey.trim() : "";
    const expiry = parsed?.apiKeyExpiresAtMs;
    if (expiry !== undefined && (typeof expiry !== "number" || !Number.isFinite(expiry))) return;
    if (apiKey)
      hostCursorCredential = {
        apiKey,
        ...(typeof expiry === "number" ? { apiKeyExpiresAtMs: expiry } : {}),
      };
  } catch {
    // No snapshot, or an unreadable one, is a signed-out profile.
  }
}

/** The same key/source selection is used for launch and auth status. */
export function resolveCursorCredential(configuredValue?: string): {
  apiKey?: string;
  source: CursorApiKeySource;
  apiKeyExpiresAtMs?: number;
} {
  const configured = configuredValue?.trim();
  if (configured) return { apiKey: configured, source: "config" };
  const inherited = process.env.CURSOR_API_KEY?.trim();
  if (inherited) return { apiKey: inherited, source: "host-env" };
  if (
    hostCursorCredential &&
    (hostCursorCredential.apiKeyExpiresAtMs === undefined ||
      hostCursorCredential.apiKeyExpiresAtMs > Date.now())
  )
    return { ...hostCursorCredential, source: "host-snapshot" };
  return { source: "none" };
}

export function resetAgentTestHostCursorApiKeyForTests(): void {
  hostCursorCredential = undefined;
}
