import { describe, expect, test } from "bun:test";
import { ProviderDispatchPreparationError } from "./native-agent-provider.js";
import {
  openCodePromptToolOptions,
  openCodeWorkflowResultDenyPermissionRules,
  openCodeWorkflowResultPermissionRules,
  openCodeWorkflowResultToolId,
  openCodeWorkflowResultTurnProblem,
  openCodeWorkflowResultTurnTools,
} from "./opencode-provider-helpers.js";
import { openCodeFake, openCodeProvider } from "./agent-provider-test-support.js";

// A graph activation on OpenCode submits every output port through the
// broker's shared `submit_graph_output`, one slot key each (plan item 204).
const GRAPH_TOOL = "submit_graph_output";
const keyA = "graph-activation-a";
const keyB = "graph-activation-b";
const slots = [
  { tool: GRAPH_TOOL, resultKey: keyA },
  { tool: GRAPH_TOOL, resultKey: keyB },
];
const agentMcp = {
  url: "http://127.0.0.1:43123/mcp",
  token: "broker-token",
  workflowResultCapability: "signed-activation-capability",
};
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

  test("a read-only prompt exposes the listed extra tools", () => {
    const options = openCodePromptToolOptions(
      { readOnly: true, workflowResultTool: GRAPH_TOOL, workflowResultExtraTools: ["ask_human"] },
      false,
    );
    expect(options.tools?.[askHuman]).toBe(true);
    expect(options.tools?.[readArtifact]).toBe(false);
    expect(options.tools?.[openCodeWorkflowResultToolId(GRAPH_TOOL)]).toBe(true);
    expect(
      openCodePromptToolOptions({ readOnly: true, workflowResultTool: GRAPH_TOOL }, false).tools?.[
        askHuman
      ],
    ).toBe(false);
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

  test("prepare refuses a per-port tool before registering the broker", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      for (const options of [
        { agentMcp, workflowResultTool: "submit_brief" },
        {
          agentMcp,
          workflowResultTool: GRAPH_TOOL,
          workflowResultSlots: [slots[0]!, { tool: "submit_risks", resultKey: keyB }],
        },
        { agentMcp, workflowResultTool: GRAPH_TOOL, workflowResultExtraTools: ["send_message"] },
      ]) {
        await expect(provider.prepareDispatch?.("owned-session", options)).rejects.toBeInstanceOf(
          ProviderDispatchPreparationError,
        );
      }
      expect(fake.mcpAddCalls).toHaveLength(0);
      await provider.prepareDispatch?.("owned-session", {
        agentMcp,
        workflowResultTool: GRAPH_TOOL,
        workflowResultSlots: slots,
        workflowResultExtraTools: ["read_artifact"],
      });
      expect(fake.mcpAddCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("a turn grants its listed extra tools and settles back to deny", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "prompt", {
        requestId: "request-1",
        agentMcp,
        workflowResultTool: GRAPH_TOOL,
        workflowResultKey: keyA,
        workflowResultSlots: slots,
        workflowResultExtraTools: ["report_progress", "ask_human"],
      });
      expect(fake.updateCalls[0]?.permission).toEqual(
        openCodeWorkflowResultPermissionRules(GRAPH_TOOL, ["report_progress", "ask_human"]),
      );
      const granted = fake.updateCalls[0]!.permission as { permission: string; action: string }[];
      expect(lastAction(granted, progress)).toBe("allow");
      expect(lastAction(granted, askHuman)).toBe("allow");
      expect(lastAction(granted, readArtifact)).toBe("deny");
      expect(fake.promptCalls).toHaveLength(1);

      await provider.send("owned-session", "ordinary prompt", { requestId: "request-2" });
      expect(fake.updateCalls[1]?.permission).toEqual(openCodeWorkflowResultDenyPermissionRules());
    } finally {
      await provider.dispose?.();
    }
  });

  test("send refuses slots that do not start with the turn's key", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await expect(
        provider.send("owned-session", "prompt", {
          requestId: "request-1",
          agentMcp,
          workflowResultTool: GRAPH_TOOL,
          workflowResultKey: keyB,
          workflowResultSlots: slots,
        }),
      ).rejects.toThrow("OpenCode workflow-result tool configuration is incomplete");
      expect(fake.mcpAddCalls).toHaveLength(0);
      expect(fake.promptCalls).toHaveLength(0);
    } finally {
      await provider.dispose?.();
    }
  });
});
