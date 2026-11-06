import type { CommandContext } from "./commands-context.js";
import type { ContainerCredentialMode } from "./container-bridge-credential.js";
import { containerImageCapabilitySupport } from "./claude-state-signal.js";

/**
 * How a bridge started now receives its token: through the root-owned launcher
 * with an authority key on an image that has one, as a verifier on an image
 * whose bridges take one, otherwise as the token. An unreadable image refuses
 * startup rather than weakening authentication.
 */
export async function containerCredentialMode(
  context: CommandContext,
  containerId: string,
  check = containerImageCapabilitySupport,
): Promise<ContainerCredentialMode> {
  const unreadable = () => {
    throw new Error(
      "Cannot determine bridge credential support; retry when the container image is available",
    );
  };
  const launcher = await check(containerId, context, "bridge-launch", 1).catch(
    () => "unknown" as const,
  );
  if (launcher === "unknown") return unreadable();
  if (launcher === "supported") return "launcher";
  const support = await check(containerId, context, "bridge-credential", 1).catch(
    () => "unknown" as const,
  );
  if (support === "unknown") return unreadable();
  return support === "supported" ? "verifier" : "token-file";
}
