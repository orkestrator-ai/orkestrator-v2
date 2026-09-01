import { describe, expect, test } from "bun:test";
import { resolveStartupLaunchFromSettings } from "@orkestrator/protocol/startup-launch";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AppConfig, Environment } from "@/types";
import { agentSettingsTiers, resolvedActionDefault } from "./agent-settings";

describe("resolvedActionDefault", () => {
  const enabled = ["claude", "codex", "cursor", "grok", "opencode"] as const;

  test("resolves PR, Resolve, and Push independently across all three tiers", () => {
    const tiers = {
      global: {
        actionDefaults: {
          review: { platform: "claude" as const },
          pr: { platform: "claude" as const, model: "app-pr" },
          resolve: { platform: "claude" as const, model: "app-resolve" },
          push: { platform: "claude" as const, model: "app-push" },
        },
      },
      repository: {
        actionDefaults: {
          review: { platform: "codex" as const },
          pr: { platform: "codex" as const, model: "repo-pr" },
          resolve: { platform: "codex" as const, model: "repo-resolve" },
        },
      },
      environment: {
        actionDefaults: {
          review: { platform: "cursor" as const },
          pr: { platform: "grok" as const, model: "env-pr" },
        },
      },
    };

    expect(resolvedActionDefault(tiers, "review", enabled)).toEqual({ agent: "cursor" });
    expect(resolvedActionDefault(tiers, "pr", enabled)).toEqual({
      agent: "grok",
      model: "env-pr",
    });
    expect(resolvedActionDefault(tiers, "resolve", enabled)).toEqual({
      agent: "codex",
      model: "repo-resolve",
    });
    expect(resolvedActionDefault(tiers, "push", enabled)).toEqual({
      agent: "claude",
      model: "app-push",
    });
  });

  test("an action default is not displaced by a narrower generic tab default", () => {
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
    ).toEqual({ agent: "claude" });
  });

  test("ignores an action entry whose platform the user has since disabled", () => {
    // The entry is dropped whole rather than having its model carried across to
    // a different platform. The generic default then follows its own cascade.
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

  test("resolves newProject the same way, which is what the create dialog reads", () => {
    // `CreateEnvironmentDialog` shares this resolver, so the rule that stops a
    // generic tab default displacing an action entry reaches the preselected
    // agent and model of a new environment too. Deliberate: "New environments"
    // is a decision about this action, and a repository-wide Default agent is
    // not. The dialog has no environment tier, so this is the narrowest case.
    expect(
      resolvedActionDefault(
        {
          global: {
            defaultAgent: "claude",
            actionDefaults: { newProject: { platform: "claude", model: "sonnet" } },
          },
          repository: { defaultAgent: "codex" },
        },
        "newProject",
        enabled,
      ),
    ).toEqual({ agent: "claude", model: "sonnet" });

    // With no entry to answer for the action, the repository's generic agent is
    // still the one that does.
    expect(
      resolvedActionDefault(
        { global: { defaultAgent: "claude" }, repository: { defaultAgent: "codex" } },
        "newProject",
        enabled,
      ),
    ).toEqual({ agent: "codex" });
  });

  test("clamps the generic fallback to the enabled set when no action names one", () => {
    // Nothing configured this action, so the generic cascade answers — but it
    // names a platform the user has since turned off. Handing that back would
    // launch an agent with no catalogue and no toolchain; the enabled list is
    // ordered, so its head is the same agent every other caller falls back to.
    expect(
      resolvedActionDefault(
        { global: { defaultAgent: "claude" }, environment: { defaultAgent: "grok" } },
        "review",
        ["codex", "claude"],
      ),
    ).toEqual({ agent: "codex" });

    // An enabled generic default is still preferred over the head of the list.
    expect(
      resolvedActionDefault({ environment: { defaultAgent: "claude" } }, "review", [
        "codex",
        "claude",
      ]),
    ).toEqual({ agent: "claude" });
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
 * The renderer and backend share the same tier assembly. TerminalContainer
 * builds it with `agentSettingsTiers`, while reconciliation builds the same
 * triple by hand from its own records.
 *
 * Grok gained a mode column of its own in the agent-settings migration, having
 * previously been routed through the OpenCode branch of a mode ternary. Cursor
 * keeps the column only for persisted compatibility and always resolves native.
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
        const expectedMode = platform === "cursor" ? "native" : (environmentMode ?? "native");
        expect(resolveStartupLaunchFromSettings(renderer)).toMatchObject({
          agent: platform,
          mode: expectedMode,
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
