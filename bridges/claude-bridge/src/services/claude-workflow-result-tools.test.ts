import { describe, expect, test } from "bun:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { WorkflowResultTurn } from "@orkestrator/protocol/workflow-results";
import {
  claudeWorkflowResultCallRefusal,
  claudeWorkflowResultTools,
  createWorkflowResultTurnHook,
  isOwnClaudeWorkflowResultCall,
} from "./claude-workflow-result-tools.js";

const activation: WorkflowResultTurn = {
  tool: "submit_a",
  resultKey: "key-a",
  slots: [
    { tool: "submit_a", resultKey: "key-a" },
    { tool: "submit_b", resultKey: "key-b" },
  ],
  extraTools: ["read_artifact"],
};
const servers = new Set(["orkestrator"]);
const tool = (name: string) => `mcp__orkestrator__${name}`;

function preToolUse(toolName: string, toolInput: unknown): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tool-1",
    session_id: "session",
    transcript_path: "/dev/null",
    cwd: "/",
  } as HookInput;
}

describe("a turn's declared workflow-result attempt", () => {
  test("lets each slot's own tools through only with that slot's key", () => {
    const own = (name: string, input: unknown) =>
      isOwnClaudeWorkflowResultCall(servers, activation, tool(name), input);
    expect(own("submit_a", { resultKey: "key-a" })).toBe(true);
    expect(own("validate_a", { resultKey: "key-a" })).toBe(true);
    expect(own("submit_b", { resultKey: "key-b" })).toBe(true);
    expect(own("get_workflow_result_status", { resultKey: "key-b" })).toBe(true);
    expect(own("read_artifact", {})).toBe(true);
    expect(own("submit_a", { resultKey: "key-b" })).toBe(false);
    expect(own("ask_human", {})).toBe(false);
    // Another server's tool of the same name, or no Orkestrator server.
    expect(
      isOwnClaudeWorkflowResultCall(servers, activation, "mcp__docs__submit_a", {
        resultKey: "key-a",
      }),
    ).toBe(false);
    expect(
      isOwnClaudeWorkflowResultCall(new Set(), activation, tool("submit_a"), {
        resultKey: "key-a",
      }),
    ).toBe(false);
  });

  test("refuses only workflow-result tools the declared attempt does not own", () => {
    const refusal = (name: string, input: unknown, turn: WorkflowResultTurn | undefined) =>
      claudeWorkflowResultCallRefusal(turn, tool(name), input);
    expect(refusal("submit_a", { resultKey: "key-a" }, activation)).toBeUndefined();
    expect(refusal("submit_a", { resultKey: "key-b" }, activation)).toContain("submit_a");
    expect(refusal("validate_b", { resultKey: "key-a" }, activation)).toBeDefined();
    expect(refusal("ask_human", {}, activation)).toBeDefined();
    expect(refusal("read_artifact", {}, activation)).toBeUndefined();
    expect(refusal("submit_fix_result", { resultKey: "key-a" }, activation)).toBeDefined();
    // Mail and other Orkestrator tools are not result tools.
    expect(refusal("send_message", {}, activation)).toBeUndefined();
    expect(refusal("get_artifact", {}, activation)).toBeUndefined();
    // A turn that declared no attempt is untouched.
    expect(refusal("submit_a", { resultKey: "key-b" }, undefined)).toBeUndefined();
    // An old kind-tool turn is not held here: a mistyped key still reaches
    // the backend, whose refusal names the attempt's own key.
    const reviewer = { tool: "submit_review_report", resultKey: "key" };
    expect(refusal("submit_review_report", { resultKey: "key" }, reviewer)).toBeUndefined();
    expect(refusal("report_finding", { resultKey: "key" }, reviewer)).toBeUndefined();
    expect(refusal("submit_review_report", { resultKey: "other" }, reviewer)).toBeUndefined();
  });

  test("the PreToolUse hook denies another slot's key in every mode", async () => {
    const hook = createWorkflowResultTurnHook(() => activation);
    const signal = new AbortController().signal;
    expect(
      await hook(preToolUse(tool("submit_a"), { resultKey: "key-a" }), "tool-1", { signal }),
    ).toEqual({});
    expect(
      await hook(preToolUse(tool("submit_a"), { resultKey: "key-b" }), "tool-1", { signal }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await hook(preToolUse("Read", { file_path: "a" }), "tool-1", { signal })).toEqual({});
    const none = createWorkflowResultTurnHook(() => undefined);
    expect(
      await none(preToolUse(tool("submit_a"), { resultKey: "key-b" }), "tool-1", { signal }),
    ).toEqual({});
  });

  test("the fixed launch list is unchanged", () => {
    expect(claudeWorkflowResultTools(servers)).toContain(tool("submit_graph_output"));
    expect(claudeWorkflowResultTools(servers)).not.toContain(tool("read_artifact"));
    expect(claudeWorkflowResultTools(new Set())).toEqual([]);
  });
});
