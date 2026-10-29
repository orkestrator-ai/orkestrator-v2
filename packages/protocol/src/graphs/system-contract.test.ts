import { describe, expect, test } from "bun:test";
import { unattendedPolicyFrame } from "../agent-interactions.js";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import {
  SYSTEM_INSTRUCTIONS_FRAME_CLOSE,
  SYSTEM_INSTRUCTIONS_FRAME_OPEN,
} from "../review-evidence-frames.js";
import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultInstruction,
  workflowResultSlotInstruction,
  workflowResultToolName,
} from "../workflow-results.js";
import { compileGraphCapabilities, describeGraphCapabilities } from "./capability-profiles.js";
import {
  GRAPH_UNTRUSTED_EVIDENCE_INSTRUCTION,
  graphNodeGrantedActions,
  graphNodeResultSlots,
  graphOutputResultInstruction,
  graphSystemContract,
} from "./system-contract.js";
import type { GraphAgentNode } from "./template-model.js";
import { GraphTypeLibrary } from "./types.js";

const host: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

const frames = (text: string) => text.split(SYSTEM_INSTRUCTIONS_FRAME_OPEN).length - 1;

describe("workflow result instruction", () => {
  test("delegates to the slot instruction with the shared workflow tools", () => {
    for (const kind of WORKFLOW_RESULT_KINDS) {
      expect(workflowResultInstruction(kind, "key", { capability: "cap" })).toBe(
        workflowResultSlotInstruction({
          noun: kind.replaceAll("-", " "),
          submitTool: workflowResultToolName(kind),
          validateTool: WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
          statusTool: "get_workflow_result_status",
          resultKey: "key",
          capability: "cap",
          progress: "",
        }),
      );
    }
  });
});

describe("graph output result instruction", () => {
  test("one required output uses its own port tools", () => {
    const text = graphOutputResultInstruction({
      slots: [{ port: "report", type: "review-report@1", required: true, resultKey: "k" }],
    });
    expect(text).toBe(
      workflowResultSlotInstruction({
        noun: "review report",
        submitTool: "submit_report",
        validateTool: "validate_report",
        statusTool: "result_status",
        resultKey: "k",
        progress: "",
      }),
    );
    expect(text).not.toContain("submit_review_report");
  });

  test("several or optional outputs are listed one per line", () => {
    const text = graphOutputResultInstruction({
      slots: [
        { port: "decision", type: "decision@1", required: true, resultKey: "a" },
        {
          port: "brief",
          type: "design-brief@1",
          required: false,
          resultKey: "b",
          progressPath: "risks",
        },
      ],
      capability: "cap",
    });
    expect(frames(text)).toBe(1);
    expect(text).toContain("This step has 2 outputs");
    expect(text).toContain(
      '- `brief` (design brief, optional): check it with `validate_brief` and submit it with `submit_brief`, resultKey "b".',
    );
    expect(text).toContain(
      'call `result_status` with the output\'s resultKey and capability "cap"',
    );
    expect(text).toContain("`report_progress` with an output's resultKey");
    expect(text).toContain("(`brief`: `risks`)");
    const optional = graphOutputResultInstruction({
      slots: [{ port: "notes", type: "markdown@1", required: false, resultKey: "n" }],
    });
    expect(optional).toContain("This step has one output");
  });
});

describe("graph system contract", () => {
  const node: GraphAgentNode = {
    id: "review",
    kind: "agent",
    role: "reviewer",
    prompt: { template: "x" },
    capabilities: { profile: "reviewer" },
    workspaceAccess: "read",
    inputs: [{ name: "package", type: "review-package@2", render: "on-demand" }],
    outputs: [{ name: "report", type: "review-report@1" }],
  };
  const library = new GraphTypeLibrary();
  const compiled = compileGraphCapabilities({ spec: node.capabilities, environment: host });
  const actions = graphNodeGrantedActions(node, library, compiled);

  test("capabilities and evidence note, then the unattended policy, then the result instruction", () => {
    const slots = graphNodeResultSlots(node, library, actions, () => "key");
    expect(slots).toEqual([
      {
        port: "report",
        type: "review-report@1",
        required: true,
        resultKey: "key",
        progressPath: "issues",
      },
    ]);
    const contract = graphSystemContract({
      compiled,
      actions,
      slots,
      enforcement: { tier: "advisory" },
    });
    const statement = describeGraphCapabilities({
      compiled,
      actions,
      enforcement: { tier: "advisory" },
    });
    expect(contract).toBe(
      [
        `${SYSTEM_INSTRUCTIONS_FRAME_OPEN}\n${statement}\n\n${GRAPH_UNTRUSTED_EVIDENCE_INSTRUCTION}\n${SYSTEM_INSTRUCTIONS_FRAME_CLOSE}`,
        unattendedPolicyFrame(),
        graphOutputResultInstruction({ slots }),
      ].join("\n\n"),
    );
    expect(contract).toContain("You cannot push or write to GitHub");
    expect(contract).toContain("checked after you finish");
    expect(actions.readArtifact).toBe(true);
  });

  test("a node without outputs gets no result instruction", () => {
    const contract = graphSystemContract({ compiled, actions, slots: [] });
    expect(frames(contract)).toBe(2);
    expect(contract).not.toContain("submit_");
  });

  test("the evidence note never spells a frame marker", () => {
    expect(GRAPH_UNTRUSTED_EVIDENCE_INSTRUCTION).not.toContain("<orkestrator");
    expect(GRAPH_UNTRUSTED_EVIDENCE_INSTRUCTION).not.toContain("</");
  });
});
