import { describe, expect, test } from "bun:test";

import { AGENT_PLATFORMS } from "./agent-platforms.js";
import { COMPONENT_KINDS } from "./capability-resources.js";
import {
  BASELINE_CAPABILITY_SUPPORT,
  CAPABILITY_LOCATIONS,
  capabilityLiveSemantics,
  describeCapabilitySupport,
  maxVerificationLevel,
  planCapabilityLocations,
} from "./capability-resources-support.js";

describe("shared locations", () => {
  test("every provider at once needs two physical copies and leaks to nobody", () => {
    // Antigravity reads no qualified skill location yet, so it stays uncovered.
    expect(planCapabilityLocations("skill", ["antigravity"]).uncovered).toEqual(["antigravity"]);
    const plan = planCapabilityLocations(
      "skill",
      AGENT_PLATFORMS.filter((platform) => platform !== "antigravity"),
    );
    expect(plan.uncovered).toEqual([]);
    expect(plan.isolated).toBe(true);
    expect(plan.locations.map((entry) => entry.id).sort()).toEqual([
      "agents-shared-skills",
      "claude-user-skills",
    ]);
  });

  test("a Claude-only skill cannot be isolated: three other providers read its directory", () => {
    const plan = planCapabilityLocations("skill", ["claude"]);
    expect(plan.locations.map((entry) => entry.id)).toEqual(["claude-user-skills"]);
    expect(plan.isolated).toBe(false);
    // Not Pi: its pinned SDK never reads ~/.claude/skills.
    expect(plan.alsoVisibleTo).toEqual(["cursor", "grok", "opencode"]);
  });

  test("a provider with a private directory is isolated", () => {
    for (const provider of ["cursor", "grok", "opencode", "pi"] as const) {
      const plan = planCapabilityLocations("skill", [provider]);
      expect(plan.isolated).toBe(true);
      expect(plan.locations).toHaveLength(1);
    }
  });

  test("Codex alone uses the shared directory, not its deprecated one, and says who else sees it", () => {
    const plan = planCapabilityLocations("skill", ["codex"]);
    expect(plan.locations.map((entry) => entry.id)).toEqual(["agents-shared-skills"]);
    expect(plan.alsoVisibleTo).toEqual(["cursor", "grok", "opencode", "pi"]);
  });

  test("commands fall back to prompt templates where a provider has no command directory", () => {
    const plan = planCapabilityLocations("command", ["codex", "pi", "claude"]);
    expect(plan.locations.map((entry) => entry.id).sort()).toEqual([
      "claude-user-commands",
      "codex-user-prompts",
      "pi-user-prompts",
    ]);
    expect(planCapabilityLocations("command", ["grok"]).uncovered).toEqual(["grok"]);
  });

  test("location ids are unique", () => {
    expect(new Set(CAPABILITY_LOCATIONS.map((entry) => entry.id)).size).toBe(
      CAPABILITY_LOCATIONS.length,
    );
  });
});

describe("support matrix", () => {
  test("every provider and kind has an answer for every operation, and non-supported ones a reason", () => {
    for (const provider of AGENT_PLATFORMS) {
      for (const kind of COMPONENT_KINDS) {
        for (const [operation, entry] of Object.entries(
          BASELINE_CAPABILITY_SUPPORT[provider][kind],
        )) {
          if (entry.level !== "supported")
            expect(entry.reason, `${provider}/${kind}/${operation}`).toBeTruthy();
        }
      }
    }
  });

  test("plugins that Orkestrator's bridges do not load are never installable", () => {
    expect(BASELINE_CAPABILITY_SUPPORT.opencode["native-plugin"].install.level).toBe("unsupported");
    expect(BASELINE_CAPABILITY_SUPPORT.opencode["native-plugin"].install.reason).toContain(
      "strips user plugins",
    );
    expect(BASELINE_CAPABILITY_SUPPORT.pi["native-plugin"].install.level).toBe("unsupported");
    expect(BASELINE_CAPABILITY_SUPPORT.pi["native-plugin"].install.reason).toContain("excludes");
  });

  test("Claude plugins install from the approved artifact, never in a container", () => {
    const claude = BASELINE_CAPABILITY_SUPPORT.claude["native-plugin"];
    expect([claude.install.level, claude.update.level, claude.remove.level]).toEqual([
      "supported",
      "supported",
      "supported",
    ]);
    expect(claude.isolate.level).toBe("unsupported");
    // Hooks still never install on their own; inside a plugin they follow its approval.
    expect(BASELINE_CAPABILITY_SUPPORT.claude.hook.install.level).toBe("unsupported");
    const container = describeCapabilitySupport("claude", { location: "container" });
    expect(container.kinds["native-plugin"].install.level).toBe("unsupported");
  });

  test("standalone hooks are never installed for any provider", () => {
    for (const provider of AGENT_PLATFORMS) {
      expect(BASELINE_CAPABILITY_SUPPORT[provider].hook.install.level).toBe("unsupported");
    }
  });

  test("context narrows the baseline: a missing provider and a container", () => {
    const missing = describeCapabilitySupport("grok", { location: "host", available: false });
    expect(missing.kinds.skill.install.level).toBe("unsupported");
    expect(missing.kinds.skill.discover.level).toBe("supported");
    const container = describeCapabilitySupport("claude", { location: "container" });
    expect(container.kinds["native-plugin"].install.level).toBe("unsupported");
  });

  test("a provider without live inventory can only reach 'present'", () => {
    expect(
      maxVerificationLevel(describeCapabilitySupport("cursor", { location: "host" }), "skill"),
    ).toBe("present");
    expect(
      maxVerificationLevel(describeCapabilitySupport("claude", { location: "host" }), "skill"),
    ).toBe("advertised");
  });

  test("live semantics never claim a hook switches on mid-task", () => {
    const matrix = describeCapabilitySupport("claude", { location: "host" });
    expect(
      capabilityLiveSemantics({
        matrix,
        kind: "hook",
        sessionRunning: true,
        exclusive: false,
        blocked: false,
      }),
    ).toBe("new-session-required");
    expect(
      capabilityLiveSemantics({
        matrix,
        kind: "skill",
        sessionRunning: true,
        exclusive: true,
        blocked: false,
      }),
    ).toBe("cannot-enforce-without-isolated-home");
    // Delivered to the session alone: isolated, and frozen until a new session.
    expect(
      capabilityLiveSemantics({
        matrix,
        kind: "skill",
        sessionRunning: true,
        exclusive: true,
        blocked: false,
        privateDelivery: true,
      }),
    ).toBe("new-session-required");
    expect(
      capabilityLiveSemantics({
        matrix,
        kind: "mcp-server",
        sessionRunning: true,
        exclusive: false,
        blocked: false,
      }),
    ).toBe("queued-until-idle");
    expect(
      capabilityLiveSemantics({
        matrix,
        kind: "skill",
        sessionRunning: false,
        exclusive: false,
        blocked: true,
      }),
    ).toBe("blocked-by-policy");
  });
});
