import type { CommandContext } from "./commands-context.js";
import { resolveActiveAgentAccount } from "./agent-accounts-active.js";
import { providerCredentialsAllowed } from "./portable-input-status.js";

/**
 * What a container tab says when its Codex or Grok login lapses.
 *
 * A container that imports the host's login holds it access-only
 * (`packages/protocol/src/login-snapshots.ts`): it can never renew it, and the
 * bridges' own "sign in again" advice only lasts until the next restart, which
 * blanks the refresh token of a login made inside the container too. The fix
 * is on the host: renew its login there, then restart the environment, which
 * restages the host's current login. A container whose provider credentials
 * are revoked keeps its own login, so it keeps the bridge's message.
 */

const HOST_RENEWAL_GUIDANCE = {
  codex:
    "This container's Codex login is a copy of the host's and cannot renew itself. Run codex on the host (codex login if it is signed out there), then restart this environment. Signing in here lasts only until the next restart.",
  codexAccount:
    "This container's Codex login is a copy of the active Codex account's and cannot renew itself. Sign in to that account again in Orkestrator's settings if it has expired, then restart this environment. Signing in here lasts only until the next restart.",
  grok: "This container's Grok login is a copy of the host's and cannot renew itself. Run grok on the host (grok login if it is signed out there), then restart this environment. Signing in here lasts only until the next restart.",
} as const;

/**
 * The guidance for a lapsed login in this environment's container, or
 * undefined when the bridge's own message stands: a local environment, a
 * provider other than Codex or Grok, or one whose credentials are not imported.
 */
export async function containerSignInGuidance(
  context: CommandContext,
  environmentId: string,
  agent: string,
): Promise<string | undefined> {
  if (agent !== "codex" && agent !== "grok") return undefined;
  const environment = await context.storage.getEnvironment(environmentId);
  if (environment?.environmentType !== "containerized" || !environment.containerId) {
    return undefined;
  }
  const { global } = await context.storage.loadConfig();
  if (!providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, agent)) {
    return undefined;
  }
  if (agent === "grok") return HOST_RENEWAL_GUIDANCE.grok;
  const active = await resolveActiveAgentAccount(context, "codex");
  return active.home ? HOST_RENEWAL_GUIDANCE.codexAccount : HOST_RENEWAL_GUIDANCE.codex;
}
