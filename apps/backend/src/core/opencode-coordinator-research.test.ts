import { describe, expect, test } from "bun:test";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { openCodeResearchToolIds } from "./opencode-coordinator-research.js";
import { openCodePermissionRules } from "./opencode-provider-helpers.js";
import { openCodeEnvironmentDependencies } from "./opencode-provider-environment.js";

/** OpenCode applies the last rule whose permission matches (`*` matches all). */
function action(rules: ReturnType<typeof openCodePermissionRules>, permission: string) {
  return rules.findLast((rule) => rule.permission === permission || rule.permission === "*")
    ?.action;
}

describe("OpenCode coordinator research tool ids", () => {
  test("names each tool as OpenCode registers it", () => {
    expect(openCodeResearchToolIds("context7", ["resolve-library-id", "query.docs"], [])).toEqual([
      "context7_resolve-library-id",
      "context7_query_docs",
    ]);
  });

  test("leaves out a tool a longer-named project server could also produce", () => {
    // `context7_a` + `b` and `context7` + `a_b` are both `context7_a_b`.
    expect(
      openCodeResearchToolIds("context7", ["a_b", "query-docs"], ["context7_a", "docs"]),
    ).toEqual(["context7_query-docs"]);
  });
});

describe("OpenCode coordinator research permissions", () => {
  const coordinator = resolveNativeAgentExecutionPolicy(
    { environmentType: "local", networkAccessMode: "restricted" },
    "coordinator",
    undefined,
    "search-and-mcp",
  );

  test("a coordinator allows exactly its research tools, after the deny-all base", () => {
    const rules = openCodePermissionRules(coordinator, {
      researchTools: ["context7_query-docs"],
    });
    expect(action(rules, "context7_query-docs")).toBe("allow");
    // Neither a pattern nor another server's tool under the same prefix.
    expect(rules.some((rule) => rule.permission.includes("*") && rule.permission !== "*")).toBe(
      false,
    );
    expect(action(rules, "context7_x_query-docs")).toBe("deny");
    // The page fetch denial still holds.
    expect(action(rules, "webfetch")).toBe("deny");
  });

  test("research tools are never allowed outside a coordinator policy", () => {
    const worker = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "restricted" },
      "interactive-native",
      { approvals: "deny" },
    );
    const rules = openCodePermissionRules(worker, { researchTools: ["context7_query-docs"] });
    expect(action(rules, "context7_query-docs")).toBe("deny");
  });

  test("only a coordinator's provider reads research ids, empty until its launch records them", () => {
    const runtimeId = coordinatorRuntimeId("workspace-1", "conversation-1");
    const { coordinatorResearchToolIds } = openCodeEnvironmentDependencies({
      environmentId: runtimeId,
    });
    expect(coordinatorResearchToolIds?.()).toEqual([]);
    expect(
      openCodeEnvironmentDependencies({ environmentId: "env-1" }).coordinatorResearchToolIds,
    ).toBeUndefined();
  });
});
