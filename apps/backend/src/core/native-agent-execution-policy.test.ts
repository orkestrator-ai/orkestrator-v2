import { describe, expect, test } from "bun:test";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { effectiveOpenCodePolicy, openCodePermissionRules } from "./opencode-provider-helpers.js";

describe("resolveNativeAgentExecutionPolicy", () => {
  const host = { environmentType: "local" as const, networkAccessMode: "full" as const };
  const container = {
    environmentType: "containerized" as const,
    networkAccessMode: "restricted" as const,
  };

  test.each([
    [host, "interactive-native", "interactive-host", "provider", "ask", false, "full"],
    [
      container,
      "interactive-native",
      "interactive-container",
      "container",
      "auto-approve",
      true,
      "restricted",
    ],
    [host, "build-pipeline", "pipeline", "provider", "auto-approve", false, "full"],
    [container, "build-pipeline", "pipeline", "container", "auto-approve", true, "restricted"],
    [host, "looped-review", "pipeline", "provider", "auto-approve", false, "full"],
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
        networkAccess: "restricted",
      }),
    ).toEqual({
      id: "interactive-host",
      sandbox: "none",
      approvals: "deny",
      projectResources: true,
      toolPolicy: { allow: ["read"] },
      networkAccess: "restricted",
    });
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
