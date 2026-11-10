import { describe, expect, test } from "bun:test";
import {
  isVerificationVerdict,
  parseAutoPipelineResult,
} from "@orkestrator/protocol/build-pipeline";
import { workflowResultInstruction } from "@orkestrator/protocol/workflow-results";
import {
  FAKE_DRAFT,
  FAKE_REPLY,
  FIXTURE_FILE_TEXT,
  SHELL_TOOL,
  offeredName,
  scriptedTurn,
  verificationResult,
} from "./auto-pipeline-fake-model-script";

const KEY = "0f1e2d3c-4b5a-4968-8776-655443322110";
const tools = (...names: string[]) =>
  names.map((name) => ({ type: "function", function: { name } }));
const user = (content: string) => ({ role: "user", content });

describe("Auto-pipeline fake model script", () => {
  test("the scripted draft is a valid Auto-pipeline result", () => {
    expect(() => parseAutoPipelineResult(FAKE_DRAFT)).not.toThrow();
  });

  test("a drafting turn submits once with its key and capability, then replies", () => {
    const prompt = `Draft a ticket.\n${workflowResultInstruction("auto-pipeline-draft", KEY, {
      capability: "cap-123",
    })}`;
    const first = scriptedTurn({
      messages: [user(prompt)],
      tools: tools("read", "submit_auto_pipeline_draft"),
    });
    expect(first.submits).toBe(true);
    expect(first.step).toEqual({
      kind: "tool",
      name: "submit_auto_pipeline_draft",
      input: { resultKey: KEY, capability: "cap-123", result: FAKE_DRAFT },
    });
    const after = scriptedTurn({
      messages: [user(prompt), { role: "assistant" }, { role: "tool", content: "accepted" }],
      tools: tools("submit_auto_pipeline_draft"),
    });
    expect(after.step).toEqual({ kind: "text", text: FAKE_REPLY });
    expect(after.submits).toBeUndefined();
  });

  test("a validation plan reads HEAD first and submits the SHA it read", () => {
    const prompt = `Plan validation.\n${workflowResultInstruction("validation-plan", KEY)}`;
    const offered = tools(SHELL_TOOL, "submit_validation_plan");
    expect(scriptedTurn({ messages: [user(prompt)], tools: offered }).step).toEqual({
      kind: "tool",
      name: SHELL_TOOL,
      input: { command: "git rev-parse HEAD" },
    });
    const sha = "a".repeat(40);
    const submit = scriptedTurn({
      messages: [user(prompt), { role: "assistant" }, { role: "tool", content: `${sha}\n` }],
      tools: offered,
    });
    expect(submit.step).toMatchObject({
      kind: "tool",
      name: "submit_validation_plan",
      input: { resultKey: KEY, result: { headRef: sha } },
    });
  });

  test("Verify passes every criterion the prompt lists", () => {
    const prompt = `Verify.\n<acceptance-criteria-json>\n[{"id":"ac-1","text":"One"},{"id":"ac-2","text":"Two"}]\n</acceptance-criteria-json>\n${workflowResultInstruction("verification-result", KEY)}`;
    const turn = scriptedTurn({
      messages: [user(prompt)],
      tools: tools("submit_verification_result"),
    });
    if (turn.step.kind !== "tool") throw new Error("Verify did not submit");
    const result = turn.step.input.result;
    expect(isVerificationVerdict(result)).toBe(true);
    expect(result).toMatchObject({
      complete: true,
      acceptanceCriteria: [
        { id: "ac-1", status: "passed" },
        { id: "ac-2", status: "passed" },
      ],
    });
    expect(verificationResult("no criteria")).toMatchObject({ acceptanceCriteria: [] });
  });

  test("an instruction carried in a system message is still found", () => {
    const turn = scriptedTurn({
      messages: [
        { role: "system", content: workflowResultInstruction("review-report", KEY) },
        user("Review the package."),
      ],
      tools: tools("mcp__orkestrator__submit_review_report"),
    });
    expect(turn.step).toMatchObject({
      kind: "tool",
      name: "mcp__orkestrator__submit_review_report",
      input: { resultKey: KEY },
    });
  });

  test("a result tool the runtime does not offer is reported, never called", () => {
    const turn = scriptedTurn({
      messages: [user(workflowResultInstruction("review-report", KEY))],
      tools: tools("read"),
    });
    expect(turn.step.kind).toBe("text");
    expect(turn.submits).toBeUndefined();
  });

  test("a write marker creates its file once; other prompts get a plain reply", () => {
    const prompt = "Write it. [write:notes/fixture.txt]";
    expect(scriptedTurn({ messages: [user(prompt)], tools: tools(SHELL_TOOL) }).step).toEqual({
      kind: "tool",
      name: SHELL_TOOL,
      input: {
        command: `mkdir -p 'notes' && printf '%s\\n' '${FIXTURE_FILE_TEXT}' > 'notes/fixture.txt'`,
      },
    });
    expect(
      scriptedTurn({
        messages: [user(prompt), { role: "assistant" }, { role: "tool", content: "" }],
      }).step,
    ).toEqual({ kind: "text", text: FAKE_REPLY });
    expect(scriptedTurn({ messages: [user("[write:../escape]")] }).step.kind).toBe("text");
    expect(scriptedTurn({ messages: [user("Hello")] }).step).toEqual({
      kind: "text",
      text: FAKE_REPLY,
    });
  });

  test("offered names match bare and MCP-namespaced spellings only", () => {
    expect(offeredName(["submit_fix_result"], "submit_fix_result")).toBe("submit_fix_result");
    expect(offeredName(["mcp__orkestrator__submit_fix_result"], "submit_fix_result")).toBe(
      "mcp__orkestrator__submit_fix_result",
    );
    expect(offeredName(["mcp_orkestrator_submit_fix_result"], "submit_fix_result")).toBe(
      "mcp_orkestrator_submit_fix_result",
    );
    expect(offeredName(["submit_fix_result_v2"], "submit_fix_result")).toBeUndefined();
  });
});
