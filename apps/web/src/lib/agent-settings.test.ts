import { describe, expect, test } from "bun:test";
import { resolveStartupLaunchFromSettings } from "@orkestrator/protocol/startup-launch";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AppConfig, Environment } from "@/types";
import { agentSettingsTiers, resolvedActionDefault } from "./agent-settings";

describe("resolvedActionDefault", () => {
  const enabled = ["claude", "codex", "cursor", "grok", "opencode"] as const;

  test("resolves action entries independently across all three tiers", () => {
    const tiers = {
      global: {
        actionDefaults: {
          review: { platform: "claude" as const },
          pr: { platform: "grok" as const, model: "grok-4" },
        },
      },
      repository: { actionDefaults: { review: { platform: "codex" as const } } },
      environment: { actionDefaults: { review: { platform: "cursor" as const } } },
    };

    expect(resolvedActionDefault(tiers, "review", enabled)).toEqual({ agent: "cursor" });
    expect(resolvedActionDefault(tiers, "pr", enabled)).toEqual({
      agent: "grok",
      model: "grok-4",
    });
  });

  test("a narrower generic agent wins when that tier does not set the action", () => {
    expect(
      resolvedActionDefault(
        {
          global: { actionDefaults: { review: { platform: "claude" } } },
          repository: { defaultAgent: "codex" },
          environment: { defaultAgent: "cursor" },
        },
        "review",
        enabled,
      ),
    ).toEqual({ agent: "cursor" });
  });

  test("ignores an action entry whose platform the user has since disabled", () => {
    // The entry is dropped whole rather than having its model carried across to
    // a different platform, and the narrower generic agent is what takes over —
    // not the application default, which is wider than the choice the user made
    // for this environment.
    expect(
      resolvedActionDefault(
        {
          global: {
            defaultAgent: "claude",
            actionDefaults: { review: { platform: "grok", model: "grok-4" } },
          },
          environment: { defaultAgent: "codex" },
        },
        "review",
        ["claude", "codex"],
      ),
    ).toEqual({ agent: "codex" });

    // With nothing narrower to fall back to, the application default answers —
    // still without the disabled platform's model.
    expect(
      resolvedActionDefault(
        {
          global: {
            defaultAgent: "claude",
            actionDefaults: { review: { platform: "grok", model: "grok-4" } },
          },
        },
        "review",
        ["claude", "codex"],
      ),
    ).toEqual({ agent: "claude" });
  });

  test("a disabled generic agent does not displace a still-enabled action entry", () => {
    // The environment names an agent the user has turned off. That choice is
    // unusable, so it must not suppress the repository's Review default and
    // hand the run to the application fallback instead.
    expect(
      resolvedActionDefault(
        {
          global: { defaultAgent: "claude" },
          repository: { actionDefaults: { review: { platform: "codex", model: "gpt-5.4" } } },
          environment: { defaultAgent: "grok" },
        },
        "review",
        ["claude", "codex"],
      ),
    ).toEqual({ agent: "codex", model: "gpt-5.4" });
  });

  test("an action at a tier wins over that tier's generic agent", () => {
    expect(
      resolvedActionDefault(
        {
          global: { defaultAgent: "claude" },
          repository: {
            defaultAgent: "codex",
            actionDefaults: { review: { platform: "grok", reasoningEffort: "high" } },
          },
        },
        "review",
        enabled,
      ),
    ).toEqual({ agent: "grok", reasoningEffort: "high" });
  });
});

/**
 * The renderer and the backend must answer `dispatchedByBackend` identically,
 * because it decides which of them owns the initial prompt's image
 * attachments. They share `resolveStartupLaunchFromSettings`, so the only place
 * they can still drift is the tier assembly they feed it: `TerminalContainer`
 * builds it with `agentSettingsTiers`, while `reconcileInitialLaunchOnce`
 * builds the same triple by hand from its own records.
 *
 * Cursor and Grok are the pair to pin. They gained a mode column of their own
 * in the agent-settings migration, having previously been routed through the
 * OpenCode branch of a mode ternary.
 */
describe("agentSettingsTiers matches the backend's own assembly", () => {
  /** Exactly what `native-agent-service-reconciliation.ts` constructs. */
  const backendTiers = (
    config: Pick<AppConfig, "global" | "repositories">,
    projectId: string,
    environment: Pick<Environment, "agentSettings">,
  ) => ({
    environment: environment.agentSettings,
    repository: config.repositories[projectId]?.agentSettings,
    global: config.global.agentSettings,
  });

  const configFor = (platform: AgentPlatform, environmentMode?: "terminal" | "native") => {
    const config = {
      global: {
        agentSettings: {
          defaultAgent: platform,
          platforms: { [platform]: { mode: "terminal" as const } },
        },
      },
      repositories: {
        "project-1": { agentSettings: { platforms: { [platform]: { mode: "native" as const } } } },
      },
    } as unknown as Pick<AppConfig, "global" | "repositories">;
    const environment = {
      agentSettings: environmentMode
        ? { platforms: { [platform]: { mode: environmentMode } } }
        : undefined,
    } as Pick<Environment, "agentSettings">;
    return { config, environment };
  };

  for (const platform of ["cursor", "grok", "claude", "codex", "opencode"] as const) {
    for (const environmentMode of [undefined, "terminal", "native"] as const) {
      test(`${platform} agrees with the backend (environment mode: ${environmentMode ?? "inherit"})`, () => {
        const { config, environment } = configFor(platform, environmentMode);
        const renderer = agentSettingsTiers(config, "project-1", environment);
        const backend = backendTiers(config, "project-1", environment);

        expect(renderer).toEqual(backend);
        expect(resolveStartupLaunchFromSettings(renderer)).toEqual(
          resolveStartupLaunchFromSettings(backend),
        );
        // And the answer is the one the tiers actually describe, not merely a
        // matching pair of wrong answers.
        expect(resolveStartupLaunchFromSettings(renderer)).toMatchObject({
          agent: platform,
          mode: environmentMode ?? "native",
          dispatchedByBackend: (environmentMode ?? "native") === "native",
        });
      });
    }
  }

  test("an environment with no project resolves against the application tier alone", () => {
    const { config, environment } = configFor("cursor", "native");
    // `projectId` is optional on this path — the create dialog and the settings
    // pages both open with no environment, and a repository lookup keyed on
    // `undefined` must not silently pick up an unrelated repository's block.
    expect(agentSettingsTiers(config, undefined, environment)).toEqual({
      environment: environment.agentSettings,
      repository: undefined,
      global: config.global.agentSettings,
    });
  });
});
