import type {
  GraphLaunchOptions,
  GraphLaunchProviderOption,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphTemplateRef, GraphTemplateSummary } from "@orkestrator/protocol/graphs/library";

/** Fixtures for Settings → Schedules' "Run a graph" action (test-only). */

export const GRAPH_REF: GraphTemplateRef = { scope: "user", id: "nightly-review" };

function provider(platform: GraphLaunchProviderOption["platform"]): GraphLaunchProviderOption {
  return { platform, tier: "enforced", allowed: true, structuredResults: true, available: true };
}

export function graphTemplateSummary(
  overrides: Partial<GraphTemplateSummary> = {},
): GraphTemplateSummary {
  return {
    ref: GRAPH_REF,
    scope: "user",
    id: "nightly-review",
    name: "Nightly review",
    revision: 2,
    digest: "a".repeat(64),
    readOnly: false,
    trust: "trusted",
    launchable: true,
    compile: {
      ok: true,
      launchable: true,
      errors: 0,
      warnings: 0,
      infos: 0,
      pendingAcknowledgements: 0,
      planDigest: "b".repeat(64),
      cost: { agentSessions: { best: 2, worst: 2 }, peakParallelism: 2 },
    },
    ...overrides,
  } as GraphTemplateSummary;
}

/** A panel role, one integer parameter and an optional text input; new worktree by default. */
export function graphScheduleOptions(
  overrides: Partial<GraphLaunchOptions> = {},
): GraphLaunchOptions {
  return {
    summary: graphTemplateSummary(),
    launchable: true,
    errors: [],
    roles: [
      {
        role: { key: "reviewer", label: "Reviewer", multiplicity: "panel", maxPanel: 3 },
        nodes: ["review"],
        panel: true,
        maxPanel: 3,
        providers: [provider("claude"), provider("codex")],
        default: [{ platform: "claude" }, { platform: "codex" }],
      },
    ],
    parameters: [{ key: "rounds", label: "Rounds", type: "integer", min: 1, max: 5, default: 2 }],
    params: { rounds: 3 },
    inputs: [{ name: "brief", type: "text@1", label: "Brief", required: false, launchable: true }],
    environment: { workspace: "environment", default: "new-worktree" },
    ...overrides,
  } as GraphLaunchOptions;
}
