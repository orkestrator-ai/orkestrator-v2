import { describe, expect, test } from "bun:test";
import {
  resolveNativeAgentExecutionPolicy,
  SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE,
  UNAPPLIED_NETWORK_RESTRICTION_NOTE,
} from "./native-agent-execution-policy.js";
import { effectiveOpenCodePolicy, openCodePermissionRules } from "./opencode-provider-helpers.js";

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
    [host, "looped-review", "pipeline", "none", "auto-approve", false, "full"],
    [container, "looped-review", "pipeline", "container", "auto-approve", true, "restricted"],
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
    expect(resolveNativeAgentExecutionPolicy(host, "looped-review").note).toBeUndefined();
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
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "shell", pattern: "*", action: "deny" },
    ]);
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

  test("fails closed instead of weakening coordinator project isolation", () => {
    expect(() =>
      effectiveOpenCodePolicy({
        id: "coordinator-read-only",
        sandbox: "provider",
        approvals: "deny",
        projectResources: false,
        networkAccess: "restricted",
      }),
    ).toThrow("cannot enforce the coordinator project-resource boundary");
  });
});
