import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  OPENCODE2_READ_ONLY_RULES,
  isOrkestratorOpenCode2McpServer,
  openCode2CreateRules,
  openCode2McpNamespace,
  openCode2SteadyRules,
  openCode2TabMcpServer,
  openCode2TurnRules,
  readOpenCode2Rules,
  toOpenCode2Rules,
} from "./permissions.js";
import type { OpenCode2PermissionRule } from "./types.js";
import { resolveNativeAgentExecutionPolicy } from "../native-agent-execution-policy.js";

/** 2.2.6's evaluation (`Permission.evaluate`): the last matching rule, else `ask`. */
function effect(rules: readonly OpenCode2PermissionRule[], action: string, resource = "*") {
  const match = (input: string, pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
      "s",
    ).test(input);
  return (
    rules.findLast((rule) => match(action, rule.action) && match(resource, rule.resource))
      ?.effect ?? "ask"
  );
}

const AUTO: NativeAgentExecutionPolicy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "automated-review",
);

describe("toOpenCode2Rules", () => {
  test("renames the ids 2.x changed and keeps the order", () => {
    expect(
      toOpenCode2Rules([
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "git push *", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
        { permission: "patch", pattern: "*", action: "deny" },
      ]),
    ).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "shell", resource: "git push *", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      // write and patch both become one `edit` rule.
      { action: "edit", resource: "*", effect: "deny" },
    ]);
  });
});

describe("session isolation", () => {
  const own = openCode2TabMcpServer("ses_a");
  const other = openCode2TabMcpServer("ses_b");

  test("each session reaches only its own tab server, never the broker", () => {
    const rules = openCode2SteadyRules(toOpenCode2Rules([]), "ses_a");
    expect(own).not.toBe(other);
    expect(own).toMatch(/^orkestrator_tab_[0-9a-f]{12}$/);
    expect(effect(rules, `${own}_send_message`)).toBe("allow");
    expect(effect(rules, `${other}_send_message`)).toBe("deny");
    expect(effect(rules, "orkestrator_workflow_result_submit_review_report")).toBe("deny");
    // Everything else is the agent's own decision.
    expect(effect(rules, "edit")).toBe("ask");
  });

  test("a new session denies every Orkestrator server until its first turn", () => {
    const rules = openCode2CreateRules([]);
    expect(effect(rules, `${own}_send_message`)).toBe("deny");
    expect(effect(rules, "orkestrator_workflow_result_submit_review_report")).toBe("deny");
  });

  test("a policy's allow-everything cannot re-open another tab", () => {
    const rules = openCode2SteadyRules(
      toOpenCode2Rules([{ permission: "*", pattern: "*", action: "allow" }]),
      "ses_a",
    );
    expect(effect(rules, `${other}_create_ticket`)).toBe("deny");
    expect(effect(rules, "edit")).toBe("allow");
  });

  test("Orkestrator's own server names are recognised", () => {
    expect(isOrkestratorOpenCode2McpServer(own)).toBe(true);
    expect(isOrkestratorOpenCode2McpServer("orkestrator_workflow_result")).toBe(true);
    expect(isOrkestratorOpenCode2McpServer("github")).toBe(false);
    expect(openCode2McpNamespace("my.server")).toBe("my_server");
  });
});

describe("turn rules", () => {
  const base = toOpenCode2Rules([{ permission: "*", pattern: "*", action: "allow" }]);

  test("a read-only turn denies every mutating 2.x tool and keeps reads", () => {
    const rules = openCode2TurnRules(base, "ses_a", { readOnly: true });
    for (const action of [
      "edit",
      "shell",
      "subagent",
      "todowrite",
      "webfetch",
      "websearch",
      "opencode_worktree_create",
    ]) {
      expect(effect(rules, action)).toBe("deny");
    }
    expect(effect(rules, "read")).toBe("allow");
    expect(effect(rules, "grep")).toBe("allow");
    expect(OPENCODE2_READ_ONLY_RULES.every((rule) => rule.effect === "deny")).toBe(true);
  });

  test("a result turn allows its own tool only, and no ask_agents", () => {
    const rules = openCode2TurnRules(base, "ses_a", {
      readOnly: true,
      workflowResultTool: "submit_review_report",
    });
    expect(effect(rules, "orkestrator_workflow_result_submit_review_report")).toBe("allow");
    expect(effect(rules, "orkestrator_workflow_result_validate_workflow_result")).toBe("allow");
    expect(effect(rules, "orkestrator_workflow_result_submit_fix_result")).toBe("deny");
    expect(effect(rules, `${openCode2TabMcpServer("ses_a")}_ask_agents`)).toBe("deny");
    expect(effect(rules, "edit")).toBe("deny");
  });

  test("a reviewer's turn replaces the base with constrained shell rules", () => {
    const rules = openCode2TurnRules(base, "ses_a", { readOnly: true, reviewPolicy: AUTO });
    expect(effect(rules, "shell", "git status")).toBe("allow");
    expect(effect(rules, "shell", "git log --oneline")).toBe("allow");
    expect(effect(rules, "shell", "git commit -m x")).toBe("deny");
    expect(effect(rules, "shell", "rm -rf .")).toBe("deny");
    expect(effect(rules, "edit")).toBe("deny");
  });

  test("an oversized rule set is refused, not truncated", () => {
    const huge = Array.from({ length: 600 }, (_, n) => ({
      action: `t${n}`,
      resource: "*",
      effect: "deny" as const,
    }));
    expect(() => openCode2SteadyRules(huge, "ses_a")).toThrow("cannot hold more than");
  });
});

describe("readOpenCode2Rules", () => {
  test("reads valid rules and refuses anything malformed", () => {
    expect(readOpenCode2Rules([{ action: "edit", resource: "*", effect: "deny" }])).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
    ]);
    expect(readOpenCode2Rules([{ action: "edit", resource: "*", effect: "maybe" }])).toBe(
      undefined,
    );
    expect(readOpenCode2Rules("nope")).toBe(undefined);
  });
});
