import type { AgentOptions, CursorAgentPlatform } from "@cursor/sdk";
import { cursorSetupDebug } from "./run-diagnostics.js";

/**
 * The SDK's own wording for a host that cannot sandbox at all. That answer is
 * final, so one probe settles it. Every other failure leaves `cursorsandbox`
 * unregistered, so treating it as settled would let one transient error
 * reinstate the dispatch failure this bootstrap exists to prevent.
 */
const SANDBOX_UNSUPPORTED = "sandboxing is not supported in this environment";

function sandboxUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SANDBOX_UNSUPPORTED);
}

/** Empty settings and no MCP servers keep the probe clear of the user's tools. */
function probeOptions(options: AgentOptions): AgentOptions {
  return {
    apiKey: options.apiKey,
    local: {
      cwd: options.local?.cwd,
      settingSources: [],
      sandboxOptions: { enabled: true },
      autoReview: false,
    },
  };
}

/** Resolves true when the barrier is settled and must not be probed again. */
async function probe(
  platform: Pick<CursorAgentPlatform, "prewarmLocalWorkspace">,
  options: AgentOptions,
  report: (error: unknown) => void,
): Promise<boolean> {
  let release: () => Promise<void>;
  try {
    release = await platform.prewarmLocalWorkspace(probeOptions(options));
  } catch (error) {
    report(error);
    return sandboxUnsupported(error);
  }
  try {
    await release();
  } catch (error) {
    // A lease only exists once the helper is registered, so a release that
    // fails has already bought what the probe was for. The SDK owns its own
    // reference count from here; probing again would not repair it.
    report(error);
  }
  return true;
}

/**
 * SDK 1.0.31 caches sandbox support process-wide. An unsandboxed run can ask
 * for its environment metadata before the SDK has registered cursorsandbox,
 * caching `false` permanently. A later read-only review then fails to start.
 *
 * Initialize through the public executor API before admitting any host run.
 * No agent or turn is created. Real sandbox failures are left to the eventual
 * sandboxed run; they must never relax its requested policy.
 */
export function createCursorSandboxBootstrap(
  report: (error: unknown) => void = (error) => cursorSetupDebug("sandbox-bootstrap", error),
) {
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
    if (initialized) return initialized;
    // The callback runs a microtask later, so `attempt` is always assigned by
    // the time it compares. Callers already in flight still resolve; only the
    // next attach re-probes.
    const attempt: Promise<void> = probe(platform, options, report).then((settled) => {
      if (!settled && initialized === attempt) initialized = undefined;
    });
    initialized = attempt;
    return attempt;
  };
}
