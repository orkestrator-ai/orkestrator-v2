import { AGENT_GOAL_TOOL_NAMES } from "@orkestrator/protocol/native-agent-goal";
import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import { describe, expect, test } from "bun:test";
import {
  CONTAINER_NETWORK_FOLLOWS_ENVIRONMENT_NOTE,
  NO_CONTAINER_ON_HOST_NOTE,
  resolveEnvironmentExecutionPolicy,
  resolveNativeAgentExecutionPolicy,
  SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE,
  UNAPPLIED_NETWORK_RESTRICTION_NOTE,
} from "./native-agent-execution-policy.js";
import {
  effectiveOpenCodePolicy,
  openCodeAgentFor,
  openCodeCoordinatorAgent,
  openCodePermissionRules,
} from "./opencode-provider-helpers.js";

describe("resolveNativeAgentExecutionPolicy", () => {
  const host = { environmentType: "local" as const, networkAccessMode: "full" as const };
  const restrictedHost = {
    environmentType: "local" as const,
    networkAccessMode: "restricted" as const,
  };
  const container = {
    environmentType: "containerized" as const,
    networkAccessMode: "restricted" as const,
  };

  test.each([
    [host, "interactive-native", "interactive-host", "none", "auto-approve", false, "full"],
    [
      container,
      "interactive-native",
      "interactive-container",
      "container",
      "auto-approve",
      true,
      "restricted",
    ],
    [host, "interactive-tmux", "interactive-host", "none", "auto-approve", false, "full"],
    [
      container,
      "interactive-tmux",
      "interactive-container",
      "container",
      "auto-approve",
      true,
      "restricted",
    ],
    [host, "build-pipeline", "pipeline", "none", "auto-approve", false, "full"],
    [container, "build-pipeline", "pipeline", "container", "auto-approve", true, "restricted"],
    [host, "automated-review", "pipeline", "none", "auto-approve", false, "full"],
    [container, "automated-review", "pipeline", "container", "auto-approve", true, "restricted"],
  ] as const)(
    "%s / %s",
    (environment, origin, id, sandbox, approvals, projectResources, networkAccess) => {
      expect(resolveNativeAgentExecutionPolicy(environment, origin)).toMatchObject({
        id,
        sandbox,
        approvals,
        projectResources,
        networkAccess,
      });
    },
  );

  test("the default host policy is unsandboxed, unattended and unrestricted", () => {
    expect(resolveNativeAgentExecutionPolicy(host, "interactive-native")).toEqual({
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "full",
    });
  });

  test("coordinator is fixed read-only and ignores overrides", () => {
    expect(
      resolveNativeAgentExecutionPolicy(host, "coordinator", {
        sandbox: "none",
        approvals: "auto-approve",
        projectResources: true,
        networkAccess: "full",
      }),
    ).toEqual({
      id: "coordinator-read-only",
      sandbox: "provider",
      approvals: "deny",
      projectResources: false,
      toolPolicy: { deny: ["write", "edit", "apply_patch", "shell"] },
      capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
      networkAccess: "restricted",
    });
  });

  test("applies an environment override without changing origin identity", () => {
    expect(
      resolveNativeAgentExecutionPolicy(host, "interactive-native", {
        sandbox: "none",
        approvals: "deny",
        projectResources: true,
        toolPolicy: { allow: ["read"] },
        networkAccess: "full",
      }),
    ).toEqual({
      id: "interactive-host",
      sandbox: "none",
      approvals: "deny",
      projectResources: true,
      toolPolicy: { allow: ["read"] },
      networkAccess: "full",
    });
  });

  test("applies a persisted per-environment override to a background workflow", () => {
    expect(
      resolveEnvironmentExecutionPolicy(
        {
          environmentType: "local",
          networkAccessMode: "full",
          agentSettings: {
            executionPolicy: {
              sandbox: "provider",
              approvals: "deny",
              projectResources: true,
              networkAccess: "restricted",
            },
          },
        },
        "automated-review",
      ),
    ).toMatchObject({
      id: "pipeline",
      sandbox: "provider",
      approvals: "deny",
      projectResources: true,
      networkAccess: "restricted",
    });
  });

  test("an override that restricts the network sandboxes the session that enforces it", () => {
    expect(
      resolveNativeAgentExecutionPolicy(host, "interactive-native", {
        networkAccess: "restricted",
      }),
    ).toEqual({
      id: "interactive-host",
      sandbox: "provider",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "restricted",
      note: SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE,
    });
  });

  test("an override cannot ask for no sandbox and a restricted network at once", () => {
    expect(
      resolveNativeAgentExecutionPolicy(host, "interactive-native", {
        sandbox: "none",
        networkAccess: "restricted",
      }),
    ).toMatchObject({ sandbox: "provider", networkAccess: "restricted" });
  });

  test("a host session keeps full network access and says the environment's is unenforceable", () => {
    expect(resolveNativeAgentExecutionPolicy(restrictedHost, "build-pipeline")).toEqual({
      id: "pipeline",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "full",
      note: UNAPPLIED_NETWORK_RESTRICTION_NOTE,
    });
  });

  test("a restricted host environment applies its restriction once a sandbox is set", () => {
    expect(
      resolveNativeAgentExecutionPolicy(restrictedHost, "interactive-native", {
        sandbox: "provider",
        networkAccess: "restricted",
      }),
    ).toEqual({
      id: "interactive-host",
      sandbox: "provider",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "restricted",
    });
  });

  test("a sandbox alone still does not apply the environment's restriction, and says so", () => {
    expect(
      resolveNativeAgentExecutionPolicy(restrictedHost, "interactive-native", {
        sandbox: "provider",
      }),
    ).toMatchObject({
      sandbox: "provider",
      networkAccess: "full",
      note: UNAPPLIED_NETWORK_RESTRICTION_NOTE,
    });
  });

  test("a container keeps its own boundary and needs no reconciliation note", () => {
    const policy = resolveNativeAgentExecutionPolicy(container, "interactive-native");
    expect(policy).toMatchObject({ sandbox: "container", networkAccess: "restricted" });
    expect(policy.note).toBeUndefined();
  });

  test("the unsandboxed default carries no note", () => {
    expect(resolveNativeAgentExecutionPolicy(host, "automated-review").note).toBeUndefined();
  });

  test("a host cannot claim a container it does not have", () => {
    expect(
      resolveNativeAgentExecutionPolicy(host, "interactive-native", { sandbox: "container" }),
    ).toMatchObject({ sandbox: "none", note: NO_CONTAINER_ON_HOST_NOTE });
  });

  test("a container stays the boundary when an override asks for no sandbox", () => {
    expect(
      resolveNativeAgentExecutionPolicy(container, "interactive-native", { sandbox: "none" }),
    ).toMatchObject({ sandbox: "container", networkAccess: "restricted" });
  });

  test("a container reports the network its firewall gives, not the override's", () => {
    // The firewall follows the environment (`commands-containers.ts`), so an
    // override cannot widen the network beyond the firewall.
    expect(
      resolveNativeAgentExecutionPolicy(container, "interactive-native", { networkAccess: "full" }),
    ).toEqual({
      id: "interactive-container",
      sandbox: "container",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "restricted",
      note: CONTAINER_NETWORK_FOLLOWS_ENVIRONMENT_NOTE,
    });
  });

  test.each([undefined, "none", "container"] as const)(
    "a full-network container retains restricted overrides with sandbox %s",
    (sandbox) => {
      expect(
        resolveNativeAgentExecutionPolicy(
          { environmentType: "containerized", networkAccessMode: "full" },
          "interactive-native",
          { ...(sandbox ? { sandbox } : {}), networkAccess: "restricted" },
        ),
      ).toMatchObject({
        sandbox: "provider",
        networkAccess: "restricted",
        containerNetworkAccess: "full",
        note: SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE,
      });
    },
  );

  test("a provider sandbox inside a container can narrow its network but not widen it", () => {
    expect(
      resolveNativeAgentExecutionPolicy(
        { environmentType: "containerized", networkAccessMode: "full" },
        "interactive-native",
        { sandbox: "provider", networkAccess: "restricted" },
      ),
    ).toMatchObject({ sandbox: "provider", networkAccess: "restricted" });
    expect(
      resolveNativeAgentExecutionPolicy(container, "interactive-native", {
        sandbox: "provider",
        networkAccess: "full",
      }),
    ).toMatchObject({ sandbox: "provider", networkAccess: "restricted" });
  });
});

describe("OpenCode execution policy translation", () => {
  test("orders deny rules after the provider-wide default so deny wins", () => {
    expect(
      openCodePermissionRules({
        id: "interactive-host",
        sandbox: "provider",
        approvals: "ask",
        projectResources: true,
        toolPolicy: { allow: ["read"], deny: ["shell"] },
        networkAccess: "restricted",
      }),
    ).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
      // A worker's mail tools never ask, so it can always report back.
      ...[...AGENT_MAIL_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES, ...AGENT_GOAL_TOOL_NAMES].map(
        (name) => ({
          permission: `orkestrator_${name}`,
          pattern: "*",
          action: "allow" as const,
        }),
      ),
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "shell", pattern: "*", action: "deny" },
    ]);
  });

  test("a deny-by-default worker still allows only its mail tools, and an explicit deny wins", () => {
    const rules = openCodePermissionRules({
      id: "interactive-host",
      sandbox: "provider",
      approvals: "deny",
      projectResources: true,
      toolPolicy: { deny: ["orkestrator_send_message"] },
      networkAccess: "restricted",
    });
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "deny" });
    const allowed = rules.filter((rule) => rule.action === "allow").map((rule) => rule.permission);
    expect(allowed).toContain("orkestrator_reply_message");
    expect(allowed).not.toContain("orkestrator_launch_environment");
    expect(rules.at(-1)).toEqual({
      permission: "orkestrator_send_message",
      pattern: "*",
      action: "deny",
    });
  });

  test("allows every permission for the unattended default policy", () => {
    expect(
      openCodePermissionRules({
        id: "interactive-host",
        sandbox: "none",
        approvals: "auto-approve",
        projectResources: false,
        networkAccess: "full",
      }),
    ).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  });

  test("a coordinator policy reports the project-resource axis it cannot honour", () => {
    const effective = effectiveOpenCodePolicy({
      id: "coordinator-read-only",
      sandbox: "provider",
      approvals: "deny",
      projectResources: false,
      capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
      networkAccess: "restricted",
    });
    // Not silently dropped: this is exactly why OpenCode is offered as
    // provider-configured rather than enforced.
    expect(effective.projectResources).toBe(true);
    expect(effective.note).toContain("project configuration");
    expect(effective.approvals).toBe("deny");
  });

  test("a coordinator denies everything but the reads it needs to be useful", () => {
    const rules = openCodePermissionRules({
      id: "coordinator-read-only",
      sandbox: "provider",
      approvals: "deny",
      projectResources: true,
      networkAccess: "restricted",
    });
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "deny" });
    const allowed = rules.filter((rule) => rule.action === "allow").map((rule) => rule.permission);
    expect(allowed).toContain("read");
    expect(allowed).toContain("grep");
    // The user's and the project's skills, loaded as text; their scripts
    // would still need `bash`.
    expect(allowed).toContain("skill");
    expect(allowed).not.toContain("edit");
    expect(allowed).not.toContain("bash");
    expect(allowed).not.toContain("write");
    // Its own mail and delegation tools, by exact OpenCode MCP tool id.
    for (const tool of ["read_messages", "get_message", "send_message", "launch_environment"]) {
      expect(allowed).toContain(`orkestrator_${tool}`);
    }
    expect(allowed.some((permission) => permission.includes("*"))).toBe(false);
  });

  test("a network denial removes OpenCode's web tools by name, last so they always lose", () => {
    const network = ["webfetch", "websearch", "codesearch"].map((permission) => ({
      permission,
      pattern: "*",
      action: "deny" as const,
    }));
    // The coordinator: its `*: deny` base already covers these, but only as a
    // side effect, and a task subagent inherits named denies from its parent.
    const coordinator = openCodePermissionRules(
      effectiveOpenCodePolicy(
        resolveNativeAgentExecutionPolicy(
          { environmentType: "local", networkAccessMode: "restricted" },
          "coordinator",
        ),
      ),
    );
    expect(coordinator.slice(-network.length)).toEqual(network);

    // An explicit allow list replaces the coordinator's read allowances, and
    // an auto-approved policy starts from `*: allow`; neither may reopen search.
    for (const policy of [
      {
        id: "coordinator-read-only" as const,
        sandbox: "provider" as const,
        approvals: "deny" as const,
        projectResources: true,
        toolPolicy: { allow: ["webfetch", "websearch"] },
        capabilityPolicy: { deny: ["network" as const] },
        networkAccess: "restricted" as const,
      },
      {
        id: "pipeline" as const,
        sandbox: "container" as const,
        approvals: "auto-approve" as const,
        projectResources: true,
        capabilityPolicy: { deny: ["network" as const] },
        networkAccess: "restricted" as const,
      },
    ]) {
      expect(openCodePermissionRules(policy).slice(-network.length)).toEqual(network);
    }

    // No capability denial, no extra rules: a container's restricted network is
    // its own firewall and keeps OpenCode's web tools.
    expect(
      openCodePermissionRules({
        id: "interactive-container",
        sandbox: "container",
        approvals: "auto-approve",
        projectResources: true,
        networkAccess: "restricted",
      }),
    ).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  });

  test("a researching coordinator may search through OpenCode but never fetch", () => {
    const policy = effectiveOpenCodePolicy(
      resolveNativeAgentExecutionPolicy(
        { environmentType: "local", networkAccessMode: "restricted" },
        "coordinator",
        undefined,
        "search-and-mcp",
      ),
    );
    expect(policy.capabilityPolicy).toEqual({
      deny: ["file.write", "file.patch", "shell.mutate", "network"],
      allow: ["web.search"],
    });
    const rules = openCodePermissionRules(policy);
    const allowed = rules.filter((rule) => rule.action === "allow").map((rule) => rule.permission);
    expect(allowed).toEqual(expect.arrayContaining(["websearch", "codesearch"]));
    expect(allowed).not.toContain("webfetch");
    // The fetch deny is still last, after every allow.
    expect(rules.at(-1)).toEqual({ permission: "webfetch", pattern: "*", action: "deny" });
    expect(rules.some((rule) => rule.permission === "websearch" && rule.action === "deny")).toBe(
      false,
    );
  });

  test("the coordinator research setting changes only the search exception", () => {
    const resolve = (mode?: "off" | "search" | "search-and-mcp") =>
      resolveNativeAgentExecutionPolicy(
        { environmentType: "local", networkAccessMode: "restricted" },
        "coordinator",
        undefined,
        mode,
      );
    // Absent keeps search off: an unread setting must not widen a coordinator.
    expect(resolve().capabilityPolicy).toEqual({
      deny: ["file.write", "file.patch", "shell.mutate", "network"],
    });
    expect(resolve("off")).toEqual(resolve());
    expect(resolve("search").capabilityPolicy?.allow).toEqual(["web.search"]);
    const { capabilityPolicy: _search, ...searchRest } = resolve("search");
    const { capabilityPolicy: _off, ...offRest } = resolve("off");
    expect(searchRest).toEqual(offRest);
  });

  test("an explicit deny still wins over the coordinator read allowances", () => {
    const rules = openCodePermissionRules({
      id: "coordinator-read-only",
      sandbox: "provider",
      approvals: "deny",
      projectResources: true,
      toolPolicy: { deny: ["read"] },
      networkAccess: "restricted",
    });
    expect(rules.at(-1)).toEqual({ permission: "read", pattern: "*", action: "deny" });
  });

  test("the coordinator runs OpenCode's read-only agent whatever the caller asked for", () => {
    expect(
      openCodeCoordinatorAgent({
        id: "coordinator-read-only",
        sandbox: "provider",
        approvals: "deny",
        projectResources: true,
        networkAccess: "restricted",
      }),
    ).toBe("plan");
    expect(
      openCodeCoordinatorAgent({
        id: "interactive-host",
        sandbox: "provider",
        approvals: "ask",
        projectResources: true,
        networkAccess: "full",
      }),
    ).toBeUndefined();
    expect(openCodeCoordinatorAgent(undefined)).toBeUndefined();
  });

  test("a slash command keeps OpenCode's own agent resolution", () => {
    const interactive = {
      id: "interactive-host" as const,
      sandbox: "provider" as const,
      approvals: "ask" as const,
      projectResources: true,
      networkAccess: "full" as const,
    };
    // Naming a fallback for a command would override one that declares its own.
    expect(openCodeAgentFor(interactive, {})).toBeUndefined();
    expect(openCodeAgentFor(interactive, {}, "build")).toBe("build");
    expect(openCodeAgentFor(interactive, { executionAgent: "reviewer" }, "build")).toBe("reviewer");
    // The coordinator override outranks anything the caller chose.
    expect(
      openCodeAgentFor(
        { ...interactive, id: "coordinator-read-only" },
        { executionAgent: "reviewer" },
        "build",
      ),
    ).toBe("plan");
  });
});
