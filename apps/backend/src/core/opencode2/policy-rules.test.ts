/**
 * The rule builders behind every OpenCode session's permissions, in OpenCode's
 * `{ permission, pattern, action }` shape (`permissions.ts` translates them).
 */
import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { resolveNativeAgentExecutionPolicy } from "../native-agent-execution-policy.js";
import {
  openCodePermissionRules,
  openCodeReviewPermissionRules,
  openCodeRulesBlockNetwork,
  openCodeUserMcpRules,
  openCodeWorkflowResultDenyPermissionRules,
  openCodeWorkflowResultPermissionRules,
  openCodeWorkflowResultToolId,
  openCodeWorkflowResultTurnProblem,
  openCodeWorkflowResultTurnTools,
} from "./policy-rules.js";

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

function userMcpPolicy(
  userMcpServers: string[] | undefined,
  options: {
    deny?: string[];
    approvals?: NativeAgentExecutionPolicy["approvals"];
    toolDeny?: string[];
  } = {},
): NativeAgentExecutionPolicy {
  return {
    id: "pipeline",
    sandbox: "none",
    approvals: options.approvals ?? "auto-approve",
    projectResources: true,
    networkAccess: "full",
    ...(options.toolDeny ? { toolPolicy: { deny: options.toolDeny } } : {}),
    capabilityPolicy: {
      deny: (options.deny ?? []) as never,
      ...(userMcpServers ? { userMcpServers } : {}),
    },
  };
}

const LISTED = [
  "docs",
  "docs_v2",
  "linear",
  "my.notes",
  "orkestrator",
  "orkestrator_workflow_result",
];

describe("openCodeUserMcpRules", () => {
  test("a granted server keeps its tools and an ungranted one loses them", () => {
    const rules = openCodePermissionRules(userMcpPolicy(["docs_v2"]), {
      configuredMcpServers: LISTED,
    });
    expect(actionFor(rules, "docs_v2_search")).toBe("allow");
    expect(actionFor(rules, "docs_search")).toBe("deny");
    expect(actionFor(rules, "linear_create_issue")).toBe("deny");
    expect(actionFor(rules, "my_notes_read")).toBe("deny");
    // Orkestrator's own servers and built-in tools are untouched.
    expect(actionFor(rules, "orkestrator_send_message")).toBe("allow");
    expect(actionFor(rules, "orkestrator_workflow_result_submit_review")).toBe("allow");
    expect(actionFor(rules, "read")).toBe("allow");
  });

  test("no grant takes every user server's tools; a denial wins over a grant", () => {
    for (const selecting of [
      userMcpPolicy([]),
      userMcpPolicy(["linear"], { deny: ["mcp:linear"] }),
    ]) {
      const rules = openCodePermissionRules(selecting, { configuredMcpServers: LISTED });
      for (const tool of ["docs_search", "docs_v2_search", "linear_create_issue"]) {
        expect(actionFor(rules, tool)).toBe("deny");
      }
    }
  });

  test("an asking policy keeps asking for granted tools; a denying one approves them", () => {
    const asking = openCodePermissionRules(userMcpPolicy(["linear"], { approvals: "ask" }), {
      configuredMcpServers: LISTED,
    });
    expect(actionFor(asking, "linear_create_issue")).toBe("ask");
    const denying = openCodePermissionRules(userMcpPolicy(["linear"], { approvals: "deny" }), {
      configuredMcpServers: LISTED,
    });
    expect(actionFor(denying, "linear_create_issue")).toBe("allow");
    expect(actionFor(denying, "bash")).toBe("deny");
  });

  test("a tool the user denied by name stays denied under a granted prefix", () => {
    const rules = openCodePermissionRules(
      userMcpPolicy(["linear"], { toolDeny: ["linear_delete"] }),
      {
        configuredMcpServers: LISTED,
      },
    );
    expect(actionFor(rules, "linear_delete")).toBe("deny");
    expect(actionFor(rules, "linear_create_issue")).toBe("allow");
  });

  test("a policy that narrows nothing adds no rule", () => {
    expect(openCodeUserMcpRules(userMcpPolicy(undefined), LISTED)).toEqual([]);
  });
});

// A graph activation on OpenCode submits every output port through the
// broker's shared `submit_graph_output`, one slot key each (plan item 204).
const GRAPH_TOOL = "submit_graph_output";
const keyA = "graph-activation-a";
const keyB = "graph-activation-b";
const slots = [
  { tool: GRAPH_TOOL, resultKey: keyA },
  { tool: GRAPH_TOOL, resultKey: keyB },
];
const progress = openCodeWorkflowResultToolId("report_progress");
const readArtifact = openCodeWorkflowResultToolId("read_artifact");
const askHuman = openCodeWorkflowResultToolId("ask_human");

function lastAction(rules: readonly { permission: string; action: string }[], tool: string) {
  return rules.findLast((rule) => rule.permission === tool)?.action;
}

describe("OpenCode graph activation tool masks", () => {
  test("hides the extra broker tools by default and in every deny rule set", () => {
    for (const tool of [progress, readArtifact, askHuman]) {
      expect(openCodeWorkflowResultTurnTools()[tool]).toBe(false);
      expect(openCodeWorkflowResultTurnTools("submit_review_report")[tool]).toBe(false);
      expect(openCodeWorkflowResultTurnTools(GRAPH_TOOL)[tool]).toBe(false);
      expect(lastAction(openCodeWorkflowResultDenyPermissionRules(), tool)).toBe("deny");
      expect(lastAction(openCodeWorkflowResultPermissionRules(GRAPH_TOOL), tool)).toBe("deny");
    }
  });

  test("enables only the extra tools a turn lists, and only with its result tool", () => {
    const tools = openCodeWorkflowResultTurnTools(GRAPH_TOOL, ["read_artifact", "report_progress"]);
    expect(tools[progress]).toBe(true);
    expect(tools[readArtifact]).toBe(true);
    expect(tools[askHuman]).toBe(false);
    expect(tools[openCodeWorkflowResultToolId(GRAPH_TOOL)]).toBe(true);
    expect(tools[openCodeWorkflowResultToolId("submit_review_report")]).toBe(false);
    expect(openCodeWorkflowResultTurnTools(undefined, ["ask_human"])[askHuman]).toBe(false);

    const rules = openCodeWorkflowResultPermissionRules(GRAPH_TOOL, ["ask_human"]);
    expect(lastAction(rules, askHuman)).toBe("allow");
    expect(lastAction(rules, progress)).toBe("deny");
    expect(lastAction(rules, readArtifact)).toBe("deny");
    expect(lastAction(rules, openCodeWorkflowResultToolId("validate_workflow_result"))).toBe(
      "allow",
    );
  });
});

describe("OpenCode graph activation turn fields", () => {
  test("accepts graph-output slots and extra tools; an old turn is unchanged", () => {
    expect(
      openCodeWorkflowResultTurnProblem({
        workflowResultTool: GRAPH_TOOL,
        workflowResultSlots: slots,
        workflowResultExtraTools: ["report_progress", "read_artifact", "ask_human"],
      }),
    ).toBeNull();
    expect(
      openCodeWorkflowResultTurnProblem({
        workflowResultTool: GRAPH_TOOL,
        workflowResultKey: keyA,
        workflowResultSlots: slots,
      }),
    ).toBeNull();
    expect(openCodeWorkflowResultTurnProblem({ workflowResultTool: "submit_review_report" })).toBe(
      null,
    );
    expect(openCodeWorkflowResultTurnProblem({})).toBeNull();
  });

  test("refuses per-port tools, foreign slot tools and malformed fields", () => {
    const refused = [
      { workflowResultTool: "submit_brief" },
      {
        workflowResultTool: "submit_brief",
        workflowResultSlots: [{ tool: "submit_brief", resultKey: keyA }],
      },
      {
        workflowResultTool: GRAPH_TOOL,
        workflowResultSlots: [slots[0]!, { tool: "submit_risks", resultKey: keyB }],
      },
      {
        workflowResultTool: "submit_review_report",
        workflowResultSlots: [{ tool: "submit_review_report", resultKey: keyA }],
      },
      { workflowResultTool: GRAPH_TOOL, workflowResultSlots: [] },
      { workflowResultTool: GRAPH_TOOL, workflowResultSlots: [slots[0]!, slots[0]!] },
      { workflowResultTool: GRAPH_TOOL, workflowResultKey: keyB, workflowResultSlots: slots },
      { workflowResultTool: GRAPH_TOOL, workflowResultExtraTools: ["send_message"] },
      { workflowResultTool: GRAPH_TOOL, workflowResultExtraTools: ["ask_human", "ask_human"] },
      { workflowResultSlots: slots },
      { workflowResultExtraTools: ["ask_human"] },
    ];
    for (const options of refused) {
      expect(openCodeWorkflowResultTurnProblem(options)).not.toBeNull();
    }
  });
});

/** OpenCode applies the last rule whose permission matches (`*` matches all). */
function exactAction(rules: readonly Rule[], permission: string) {
  return rules.findLast((rule) => rule.permission === permission || rule.permission === "*")
    ?.action;
}

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
    expect(exactAction(rules, "context7_query-docs")).toBe("allow");
    // Neither a pattern nor another server's tool under the same prefix.
    expect(rules.some((rule) => rule.permission.includes("*") && rule.permission !== "*")).toBe(
      false,
    );
    expect(exactAction(rules, "context7_x_query-docs")).toBe("deny");
    // The page fetch denial still holds.
    expect(exactAction(rules, "webfetch")).toBe("deny");
  });

  test("research tools are never allowed outside a coordinator policy", () => {
    const worker = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "restricted" },
      "interactive-native",
      { approvals: "deny" },
    );
    const rules = openCodePermissionRules(worker, { researchTools: ["context7_query-docs"] });
    expect(exactAction(rules, "context7_query-docs")).toBe("deny");
  });
});
