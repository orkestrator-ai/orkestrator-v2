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
 * inherited `CURSOR_API_KEY` would be, so each consumer reports and forwards it
 * the same way. A stored key in the profile's own settings still wins.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

/** Written by `seedAgentTestProviderCredentials` in `apps/desktop/scripts/dev/profile-io.ts`. */
export function agentTestHostCursorCredentialPath(dataDir: string): string {
  return path.join(dataDir, "agent-credentials", "cursor", "host-api-key.json");
}

const MAX_SNAPSHOT_BYTES = 64 * 1024;
let hostCursorApiKey: string | undefined;

/** Read the snapshot once at startup; a later host change applies on the next start. */
export function loadAgentTestHostCursorApiKey(options: {
  dataDir: string;
  runtimeFlavor?: string;
  credentialSources?: ReadonlySet<AgentPlatform>;
}): void {
  hostCursorApiKey = undefined;
  if (options.runtimeFlavor !== "agent-test" || !options.credentialSources?.has("cursor")) return;
  try {
    const raw = readFileSync(agentTestHostCursorCredentialPath(options.dataDir), "utf8");
    if (raw.length > MAX_SNAPSHOT_BYTES) return;
    const parsed = JSON.parse(raw) as { apiKey?: unknown } | null;
    const apiKey = typeof parsed?.apiKey === "string" ? parsed.apiKey.trim() : "";
    if (apiKey) hostCursorApiKey = apiKey;
  } catch {
    // No snapshot, or an unreadable one, is a signed-out profile.
  }
}

/** `CURSOR_API_KEY` from this process, else the agent-test host snapshot. */
export function inheritedCursorApiKey(): string | undefined {
  return process.env.CURSOR_API_KEY?.trim() || hostCursorApiKey;
}

export function resetAgentTestHostCursorApiKeyForTests(): void {
  hostCursorApiKey = undefined;
}
