import type { AgentOptions, CursorAgentPlatform } from "@cursor/sdk";

/**
 * SDK 1.0.31 caches sandbox support process-wide. An unsandboxed run can ask
 * for its environment metadata before the SDK has registered cursorsandbox,
 * caching `false` permanently. A later read-only review then fails to start.
 *
 * Initialize through the public executor API before admitting any host run.
 * No agent or turn is created. Empty settings and no MCP servers keep this
 * probe independent of the user's tools. Real sandbox failures are left to
 * the eventual sandboxed run; they must never relax its requested policy.
 */
export function createCursorSandboxBootstrap() {
  let initialized: Promise<void> | undefined;
  return (
    platform: Pick<CursorAgentPlatform, "prewarmLocalWorkspace">,
    options: AgentOptions,
    sandboxBoundary: "none" | "provider" | "container",
  ): Promise<void> => {
    // Containers already have a boundary; probing a nested sandbox is wrong.
    if (sandboxBoundary === "container") return Promise.resolve();
    // The SDK skips sandbox initialization entirely without an API key.
    if (!options.apiKey) return Promise.resolve();
    initialized ??= (async () => {
      try {
        const release = await platform.prewarmLocalWorkspace({
          apiKey: options.apiKey,
          local: {
            cwd: options.local?.cwd,
            settingSources: [],
            sandboxOptions: { enabled: true },
            autoReview: false,
          },
        });
        await release();
      } catch {
        // Unsupported hosts still support normal unsandboxed sessions.
        // A sandboxed session's own executor reports failure authoritatively.
      }
    })();
    return initialized;
  };
}
