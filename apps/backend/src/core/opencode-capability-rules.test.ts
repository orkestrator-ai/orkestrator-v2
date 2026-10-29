import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  openCodePermissionRules,
  openCodeReviewPermissionRules,
  openCodeRulesBlockNetwork,
} from "./opencode-provider-helpers.js";

type Rule = { permission: string; pattern: string; action: string };

// OpenCode's documented evaluation: simple globs, the last matching rule wins.
function actionFor(rules: readonly Rule[], permission: string, pattern = "*") {
  const glob = (candidate: string, value: string) =>
    new RegExp(
      `^${candidate
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".")}$`,
      "s",
    ).test(value);
  return rules.findLast((rule) => glob(rule.permission, permission) && glob(rule.pattern, pattern))
    ?.action;
}

const builder: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
  capabilityPolicy: {
    deny: ["git.commit", "git.push", "github.write", "subagents", "mcp:docs.search"],
  },
};

describe("OpenCode translation of graph capabilities", () => {
  test("git and GitHub denials refuse those commands and leave the rest of the shell", () => {
    const rules = openCodePermissionRules(builder);
    for (const permission of ["bash", "shell"]) {
      expect(actionFor(rules, permission, "git push")).toBe("deny");
      expect(actionFor(rules, permission, "git push origin HEAD")).toBe("deny");
      expect(actionFor(rules, permission, "git commit -m x")).toBe("deny");
      expect(actionFor(rules, permission, "gh pr create")).toBe("deny");
      expect(actionFor(rules, permission, "git status")).toBe("allow");
      expect(actionFor(rules, permission, "bun test")).toBe("allow");
    }
  });

  test("sub-agents and a named MCP server are denied by tool name", () => {
    const rules = openCodePermissionRules(builder);
    expect(actionFor(rules, "task")).toBe("deny");
    // OpenCode prefixes a server's tools with its sanitised name.
    expect(actionFor(rules, "docs_search_lookup")).toBe("deny");
    expect(actionFor(rules, "docs.search_lookup")).toBe("deny");
    expect(actionFor(rules, "context7_lookup")).toBe("allow");
  });

  test("the wire form's extended denials translate the same way", () => {
    const rules = openCodePermissionRules({
      ...builder,
      capabilityPolicy: { deny: [], extendedDeny: ["git.push", "subagents"] },
    });
    expect(actionFor(rules, "bash", "git push")).toBe("deny");
    expect(actionFor(rules, "task")).toBe("deny");
    expect(actionFor(rules, "bash", "git commit")).toBe("allow");
  });

  test("a command-pattern deny never counts as the toolset blocking the network", () => {
    const rules = openCodePermissionRules({
      ...builder,
      capabilityPolicy: { deny: ["network", "git.push"] },
    });
    // `webfetch` is denied, but every other command still runs.
    expect(actionFor(rules, "webfetch")).toBe("deny");
    expect(openCodeRulesBlockNetwork(rules)).toBe(false);
  });

  test("a reviewer's allowed reading commands do not reopen a push", () => {
    const rules = openCodeReviewPermissionRules({
      ...builder,
      capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "git.push"] },
    });
    expect(actionFor(rules, "bash", "git log --oneline")).toBe("allow");
    expect(actionFor(rules, "bash", "git push")).toBe("deny");
  });
});
