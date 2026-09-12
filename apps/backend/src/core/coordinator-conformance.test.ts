import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  claudeDeniedTools,
  claudeReadOnlyAllowedTools,
  claudeReadOnlySandbox,
  isReadOnlyShellCommand,
} from "../../../../bridges/claude-bridge/src/services/read-only-policy.js";
import {
  COORDINATOR_ASYNC_CONTRACT,
  type CoordinatorProviderTier,
} from "@orkestrator/protocol/coordinator";
import { coordinatorProviderQualification } from "./coordinator-providers.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  effectiveOpenCodePolicy,
  openCodeCoordinatorAgent,
  openCodePermissionRules,
} from "./opencode-provider-helpers.js";

/**
 * The contract behind the tier a platform is advertised at.
 *
 * A platform reaches `enforced` only if its bridge actually translates the
 * coordinator policy into something the provider or the OS holds. These
 * assertions are the cheap, always-run half of that; the expensive half is the
 * real-stack read-only suite described in `docs/architecture/coordinator.md`.
 */
const coordinatorPolicy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "restricted" },
  "coordinator",
);

const host = { claudeSandbox: true };
const everyPlatform = [...AGENT_PLATFORMS];

function tierOf(platform: AgentPlatform): CoordinatorProviderTier {
  return coordinatorProviderQualification(platform, { host, enabledPlatforms: everyPlatform }).tier;
}

describe("coordinator read-only conformance", () => {
  test("the coordinator policy names capabilities, not one provider's tool names", () => {
    // Without this, every bridge but Codex silently applies an empty deny list.
    expect(coordinatorPolicy.capabilityPolicy?.deny).toEqual([
      "file.write",
      "file.patch",
      "shell.mutate",
      "network",
    ]);
    expect(coordinatorPolicy.approvals).toBe("deny");
    expect(coordinatorPolicy.projectResources).toBe(false);
    expect(coordinatorPolicy.networkAccess).toBe("restricted");
  });

  test("every enforced platform translates the policy into its own vocabulary", () => {
    const enforced = everyPlatform.filter((platform) => tierOf(platform) === "enforced");
    // If a platform is added to the enforced tier, it must appear here with a
    // translation, or this fails rather than quietly shipping a claim nothing
    // is holding up.
    expect(enforced.toSorted()).toEqual(["claude", "codex", "pi"]);

    // Claude: the translation lives in its bridge and is asserted there in
    // detail; this is the boundary check that it exists and is non-empty.
    const claudeDenied = claudeDeniedTools(coordinatorPolicy);
    expect(claudeDenied).toContain("Write");
    expect(claudeDenied).toContain("Edit");
    expect(claudeDenied).toContain("WebFetch");
    const claudeAllowed = claudeReadOnlyAllowedTools({ agentMcpServerNames: ["orkestrator"] });
    expect(claudeAllowed).not.toContain("Write");
    expect(claudeAllowed).toContain("mcp__orkestrator__*");
    expect(claudeReadOnlySandbox(coordinatorPolicy)).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
    });
  });

  test("a provider-configured platform denies, and says what it cannot hold", () => {
    expect(tierOf("opencode")).toBe("provider-configured");
    const effective = effectiveOpenCodePolicy(coordinatorPolicy);
    expect(effective.note).toBeTruthy();
    expect(openCodePermissionRules(effective)[0]).toEqual({
      permission: "*",
      pattern: "*",
      action: "deny",
    });
    expect(openCodeCoordinatorAgent(effective)).toBe("plan");
  });

  test("an advisory platform is not offered at the default safety level", () => {
    expect(tierOf("grok")).toBe("advisory");
    expect(
      coordinatorProviderQualification("grok", { host, enabledPlatforms: everyPlatform }).available,
    ).toBe(false);
  });

  test("a platform without delegation says so, so the prompt can stop promising it", () => {
    // Delegation needs both halves of the round trip: an MCP client to call
    // `launch_environment`, and a mailbox the worker's reply can be injected
    // into. Cursor and Grok have the first and lack the second.
    const withoutDelegation = everyPlatform.filter(
      (platform) =>
        !coordinatorProviderQualification(platform, { host, enabledPlatforms: everyPlatform })
          .delegation,
    );
    expect(withoutDelegation.toSorted()).toEqual(["cursor", "grok"]);
    for (const platform of withoutDelegation) {
      // Silent absence is the failure mode this guards: the caveat has to be
      // readable next to the platform being chosen.
      expect(
        coordinatorProviderQualification(platform, { host, enabledPlatforms: everyPlatform })
          .reason,
      ).toBeTruthy();
    }
    for (const platform of everyPlatform.filter(
      (candidate) => !withoutDelegation.includes(candidate),
    )) {
      expect(
        coordinatorProviderQualification(platform, { host, enabledPlatforms: everyPlatform })
          .delegation,
      ).toBe(true);
    }
  });
  test("a coordinator turn has no way to sit and wait", () => {
    const allowed = claudeReadOnlyAllowedTools({ agentMcpServerNames: ["orkestrator"] });
    // Waiting is the failure mode this whole design removes: a turn that sleeps
    // holds the conversation open, bills for the wait, and blocks the user from
    // saying anything else. Delegated work reports back by waking the
    // conversation, so nothing here needs to exist.
    for (const tool of ["Monitor", "ScheduleWakeup", "CronCreate", "CronList", "CronDelete"]) {
      expect(allowed).not.toContain(tool);
    }
    for (const command of ["sleep", "watch", "timeout"]) {
      expect(isReadOnlyShellCommand(command + " 5").allowed).toBe(false);
    }
  });

  test("the async contract is one string, so no surface can disagree about it", () => {
    // The context prompt, the tool results and the poll guard's refusal all read
    // this. Two descriptions of when a coordinator is woken is a reason to poll.
    expect(COORDINATOR_ASYNC_CONTRACT).toContain("woken");
    expect(COORDINATOR_ASYNC_CONTRACT).toContain("Do not wait, sleep, poll");
    expect(COORDINATOR_ASYNC_CONTRACT).toContain("silence means the work is still running");
  });
});
