import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  claudeDeniedTools,
  claudeReadOnlyAllowedTools,
  claudeReadOnlySandbox,
  isReadOnlyShellCommand,
} from "../../../../bridges/claude-bridge/src/services/read-only-policy.js";
import {
  codexAppServerConfigOverrides,
  codexCoordinatorPolicy,
} from "../../../../bridges/codex-bridge/src/codex-config.js";
import {
  loadAcpProviderConfig,
  providerArgv,
} from "../../../../bridges/acp-bridge/src/acp-provider-config.js";
import { coordinatorProcessPolicy as grokCoordinatorPolicy } from "../../../../bridges/acp-bridge/src/acp-policy.js";
import { resolvePiMcpServers } from "../../../../bridges/pi-bridge/src/mcp-config.js";
import {
  COORDINATOR_ASYNC_CONTRACT,
  type CoordinatorProviderTier,
} from "@orkestrator/protocol/coordinator";
import {
  describeNativeAgentExecutionPolicy,
  nativeAgentPolicyDeniesNetwork,
  nativeAgentPolicyDeniesWebSearch,
} from "@orkestrator/protocol/native-agent";
import { coordinatorWebResearchEnv } from "@orkestrator/protocol/coordinator-web-research";
import {
  COORDINATOR_LIVE_PLATFORMS,
  COORDINATOR_LIVE_SCENARIOS,
} from "../../../desktop/scripts/dev/coordinator-live.js";
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
 * real-stack read-only suite described in `docs/todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md`.
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

  // The live suite is the expensive half of every claim this table makes. A
  // platform the coordinator offers, and above all one at `enforced`, has to
  // have a live entry that runs every scenario, or its tier is a claim nothing
  // ever checks against a real provider.
  test("every offered platform, enforced ones included, is on the live suite's list", () => {
    const live = new Set(COORDINATOR_LIVE_PLATFORMS.map((entry) => entry.platform));
    const offered = everyPlatform.filter(
      (platform) =>
        coordinatorProviderQualification(platform, { host, enabledPlatforms: everyPlatform })
          .available,
    );
    expect(offered.filter((platform) => !live.has(platform))).toEqual([]);
    const enforced = everyPlatform.filter((platform) => tierOf(platform) === "enforced");
    expect(enforced.length).toBeGreaterThan(0);
    for (const platform of enforced) expect(live.has(platform)).toBe(true);
    expect(COORDINATOR_LIVE_SCENARIOS).toContain("read-only");
    expect(COORDINATOR_LIVE_SCENARIOS).toContain("async");
    expect(COORDINATOR_LIVE_SCENARIOS).toContain("family");
    expect(COORDINATOR_LIVE_SCENARIOS).toContain("status");
    expect(COORDINATOR_LIVE_SCENARIOS).toContain("peer");
  });

  // Hosted web search reaches the internet from the vendor's servers, so a
  // sandbox or firewall here never sees it. A live run found a Codex
  // coordinator fetching https://example.com this way while its profile had
  // the network off. Each platform has to take these tools away itself.
  test("a denied network takes hosted web search and fetch away on every platform", () => {
    expect(nativeAgentPolicyDeniesNetwork(coordinatorPolicy)).toBe(true);
    expect(describeNativeAgentExecutionPolicy(coordinatorPolicy)).toContain(
      "web search and web fetch off",
    );

    // Codex: process configuration, read back before every thread, and the
    // bridge's own policy (what the information panel shows) names the denial.
    const codex = codexAppServerConfigOverrides({
      ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
      CODEX_BRIDGE_PERMISSION_PROFILE: "coordinator-conversation-1",
      CODEX_BRIDGE_READABLE_RUNTIME_ROOT: "/opt/orkestrator/codex",
      CWD: "/projects/example",
    });
    expect(codex.web_search).toBe('"disabled"');
    expect(nativeAgentPolicyDeniesNetwork(codexCoordinatorPolicy({}))).toBe(true);

    // Claude: both tools are denied by name, not only left off the allowlist.
    expect(claudeDeniedTools(coordinatorPolicy)).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch"]),
    );
    const claudeAllowed = claudeReadOnlyAllowedTools({ agentMcpServerNames: ["orkestrator"] });
    expect(claudeAllowed).not.toContain("WebFetch");
    expect(claudeAllowed).not.toContain("WebSearch");

    // OpenCode: named denies after every allow.
    const openCodeDenied = openCodePermissionRules(effectiveOpenCodePolicy(coordinatorPolicy))
      .filter((rule) => rule.action === "deny")
      .map((rule) => rule.permission);
    expect(openCodeDenied).toEqual(expect.arrayContaining(["webfetch", "websearch"]));

    // Grok: the CLI drops both tools; it never asks before a search.
    const grok = providerArgv(loadAcpProviderConfig({ ACP_PROVIDER: "grok" }), {
      approvals: grokCoordinatorPolicy().approvals,
      denyNetwork: nativeAgentPolicyDeniesNetwork(grokCoordinatorPolicy()),
    });
    expect(grok[0]).toBe("--disable-web-search");
    expect(grok).toContain("--no-leader");
  });

  // The research setting reopens hosted search and nothing else: commands
  // stay off the network and no platform may fetch an arbitrary page.
  test("a researching coordinator gets search, never fetch, on every platform that has it", () => {
    const research = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "restricted" },
      "coordinator",
      undefined,
      "search-and-mcp",
    );
    expect(nativeAgentPolicyDeniesNetwork(research)).toBe(true);
    expect(nativeAgentPolicyDeniesWebSearch(research)).toBe(false);
    expect(describeNativeAgentExecutionPolicy(research)).toContain(
      "no network except hosted web search, web fetch off",
    );

    // Codex: cached search only, which cannot open a page outside OpenAI's index.
    const codexEnv = {
      ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
      CODEX_BRIDGE_PERMISSION_PROFILE: "coordinator-conversation-1",
      CODEX_BRIDGE_READABLE_RUNTIME_ROOT: "/opt/orkestrator/codex",
      CWD: "/projects/example",
      ...coordinatorWebResearchEnv("search-and-mcp", [
        { name: "context7", url: "https://mcp.context7.com/mcp" },
      ]),
    };
    const codex = codexAppServerConfigOverrides(codexEnv);
    expect(codex.web_search).toBe('"cached"');
    expect(codex["mcp_servers.context7.url"]).toBe('"https://mcp.context7.com/mcp"');

    // Claude: WebSearch allowed and WebFetch still denied.
    expect(claudeDeniedTools(research)).toContain("WebFetch");
    expect(claudeDeniedTools(research)).not.toContain("WebSearch");
    expect(
      claudeReadOnlyAllowedTools({ agentMcpServerNames: ["orkestrator"], policy: research }),
    ).toContain("WebSearch");

    // OpenCode: search allowed by name, research tools by exact id, fetch
    // denied last.
    const openCode = openCodePermissionRules(effectiveOpenCodePolicy(research), {
      researchTools: ["context7_query-docs"],
    });
    expect(openCode.at(-1)).toEqual({ permission: "webfetch", pattern: "*", action: "deny" });
    expect(
      openCode.some((rule) => rule.permission === "websearch" && rule.action === "allow"),
    ).toBe(true);
    expect(
      openCode.some((rule) => rule.permission === "context7_query-docs" && rule.action === "allow"),
    ).toBe(true);

    // Grok 1.0.67's hosted search opens any page (`open_page`), and no switch
    // keeps search without it, so its coordinator stays off.
    expect(nativeAgentPolicyDeniesWebSearch(grokCoordinatorPolicy())).toBe(true);
  });

  // Research servers are remote HTTPS endpoints the launcher names. Claude and
  // Codex load them from the launch environment (above), Cursor and Pi host
  // them in the bridge (their own tests), and OpenCode registers them on its
  // server at launch. Pi resolves them only under coordinator authority.
  test("Pi resolves research servers only under the coordinator's process authority", async () => {
    const env = {
      ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
      ...coordinatorWebResearchEnv("search-and-mcp", [
        { name: "context7", url: "https://mcp.context7.com/mcp" },
      ]),
    };
    const resolve = (overrides: Record<string, string | undefined>) =>
      resolvePiMcpServers({
        agentDir: "/nonexistent/pi-agent",
        cwd: "/nonexistent/project",
        projectResources: false,
        env: { ...env, ...overrides },
      });
    expect(await resolve({})).toContainEqual({
      id: "context7",
      scope: "research",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
    });
    expect(await resolve({ ORKESTRATOR_BRIDGE_EXECUTION_POLICY: undefined })).toEqual([]);
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

  test("every native platform can complete a delegation round trip", () => {
    // Delegation needs both halves: an MCP client to call
    // `launch_environment`, and a mailbox the worker's reply can be injected
    // into. Native Claude, Codex, OpenCode, Pi, Cursor, and Grok all have both.
    // Grok can still be withheld at the default safety tier; that is
    // availability, not a missing mailbox.
    for (const platform of everyPlatform) {
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
