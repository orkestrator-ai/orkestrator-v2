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

/**
 * How the container's OpenCode (2.x) server starts: `opencode2-launcher` on an
 * image whose launcher also starts it (`opencode2-launch=1`,
 * `opencode2-container-launch.ts`), otherwise as the bridges' mode says, where
 * `launcher` and `verifier` both keep the password in root's file and the
 * server's environment alone. (`opencode-launch=1`, which started OpenCode
 * 1.x, is never asked for.)
 */
export type OpenCode2ContainerMode = ContainerCredentialMode | "opencode2-launcher";

export async function containerOpenCode2Mode(
  context: CommandContext,
  containerId: string,
  check = containerImageCapabilitySupport,
): Promise<OpenCode2ContainerMode> {
  const bridges = await containerCredentialMode(context, containerId, check);
  if (bridges !== "launcher") return bridges;
  const launch = await check(containerId, context, "opencode2-launch", 1).catch(
    () => "unknown" as const,
  );
  if (launch === "unknown") {
    throw new Error(
      "Cannot determine bridge credential support; retry when the container image is available",
    );
  }
  return launch === "supported" ? "opencode2-launcher" : "launcher";
}
