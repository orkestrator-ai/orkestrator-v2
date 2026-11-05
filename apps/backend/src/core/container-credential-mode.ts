import type { CommandContext } from "./commands-context.js";
import type { ContainerCredentialMode } from "./container-bridge-credential.js";
import { containerImageCapabilitySupport } from "./claude-state-signal.js";

/**
 * How a bridge started now receives its token: as a verifier on an image whose
 * bridges take one, otherwise as the token. An unreadable image refuses startup rather than weakening authentication.
 */
export async function containerCredentialMode(
  context: CommandContext,
  containerId: string,
  check = containerImageCapabilitySupport,
): Promise<ContainerCredentialMode> {
  const support = await check(containerId, context, "bridge-credential", 1).catch(
    () => "unknown" as const,
  );
  if (support === "unknown")
    throw new Error(
      "Cannot determine bridge credential support; retry when the container image is available",
    );
  return support === "supported" ? "verifier" : "token-file";
}
