import { describe, expect, test } from "bun:test";
import {
  renderSuborkDeliveryBody,
  renderSuborkPrompt,
  renderSuborkRequestCarrier,
} from "@orkestrator/protocol/suborks";
import { workflowResultInstruction } from "@orkestrator/protocol/workflow-results";
import {
  offeredName,
  scriptedTurn,
  suborkAnswer,
  suborkRequest,
  targetPrompt,
  TITLE_REPLY,
} from "./suborks-fake-model-script";

const TAG = "QATAG0123ABCD";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const tools = (...names: string[]) =>
  names.map((name) => ({ type: "function", function: { name } }));

describe("the caller's /subork turn", () => {
  const carrier = renderSuborkRequestCarrier(suborkRequest(["pi", "opencode"], TAG));

  test("calls ask_agents once with the named targets and the tag", () => {
    const turn = scriptedTurn("pi", {
      messages: [{ role: "user", content: carrier }],
      tools: tools("bash", "orkestrator_ask_agents"),
    });
    expect(turn.step).toEqual({
      kind: "tool",
      name: "orkestrator_ask_agents",
      input: {
        targets: [
          { agent: "pi", name: `pi ${TAG}` },
          { agent: "opencode", name: `opencode ${TAG}` },
        ],
        prompt: targetPrompt(TAG),
        requestId: `subork-qa-${TAG}`,
      },
    });
    expect(turn.facts).toEqual({
      role: "caller",
      tag: TAG,
      turnStart: true,
      offersAskAgents: true,
    });
  });

  test("ends the turn in prose once the tool has answered", () => {
    const turn = scriptedTurn("pi", {
      messages: [
        { role: "user", content: carrier },
        { role: "assistant", content: null },
        { role: "tool", content: "handle" },
      ],
      tools: tools("mcp__orkestrator__ask_agents"),
    });
    expect(turn.step.kind).toBe("text");
    expect(turn.facts.turnStart).toBe(false);
  });

  test("is not confused with OpenCode's tool-less title request", () => {
    const turn = scriptedTurn("opencode", { messages: [{ role: "user", content: carrier }] });
    expect(turn.step).toEqual({ kind: "text", text: TITLE_REPLY });
    expect(turn.facts.role).toBe("title");
  });

  test("says so when ask_agents is not offered", () => {
    const turn = scriptedTurn("pi", {
      messages: [{ role: "user", content: carrier }],
      tools: tools("bash"),
    });
    expect(turn.step).toEqual({ kind: "text", text: "ask_agents is not offered." });
    expect(turn.facts.offersAskAgents).toBe(false);
  });
});

describe("a target's turn", () => {
  const prompt = `${renderSuborkPrompt(targetPrompt(TAG))}\n\n${workflowResultInstruction("subork-answer", KEY, { capability: "cap-1" })}`;

  test("submits its platform and the tag under the result key", () => {
    const turn = scriptedTurn("opencode", {
      messages: [{ role: "user", content: prompt }],
      tools: tools("orkestrator_submit_subork_answer", "orkestrator_validate_workflow_result"),
    });
    expect(turn.step).toEqual({
      kind: "tool",
      name: "orkestrator_submit_subork_answer",
      input: {
        resultKey: KEY,
        capability: "cap-1",
        result: { answer: suborkAnswer("opencode", TAG) },
      },
    });
    expect(turn.facts).toMatchObject({ role: "target", tag: TAG, turnStart: true });
  });

  test("submits under the newest result key on a reminder turn", () => {
    const newer = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const turn = scriptedTurn("pi", {
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "…" },
        {
          role: "user",
          content: workflowResultInstruction("subork-answer", newer, { capability: "cap-2" }),
        },
      ],
      tools: tools("submit_subork_answer"),
    });
    expect(turn.step).toMatchObject({
      kind: "tool",
      input: { resultKey: newer, capability: "cap-2" },
    });
  });

  test("answers in prose after its submission", () => {
    const turn = scriptedTurn("pi", {
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: null },
        { role: "tool", content: "ok" },
      ],
      tools: tools("submit_subork_answer"),
    });
    expect(turn.step).toEqual({ kind: "text", text: suborkAnswer("pi", TAG) });
  });
});

describe("the wake", () => {
  test("reads every answer in the delivery mail", () => {
    const body = renderSuborkDeliveryBody([
      { label: "Pi", status: "finished", text: suborkAnswer("pi", TAG) },
      { label: "OpenCode", status: "finished", text: suborkAnswer("opencode", TAG) },
    ]);
    const turn = scriptedTurn("pi", {
      messages: [{ role: "user", content: `<agent-mail from="system">\n${body}\n</agent-mail>` }],
      tools: tools("orkestrator_ask_agents"),
    });
    expect(turn.step).toEqual({ kind: "text", text: `ANSWERS-RECEIVED ${TAG} 2` });
    expect(turn.facts).toMatchObject({
      role: "wake",
      tag: TAG,
      answers: ["pi", "opencode"],
      turnStart: true,
    });
  });
});

test("offeredName finds a tool bare or behind the orkestrator server", () => {
  expect(offeredName(["ask_agents"], "ask_agents")).toBe("ask_agents");
  expect(offeredName(["orkestrator_ask_agents"], "ask_agents")).toBe("orkestrator_ask_agents");
  expect(offeredName(["mcp__orkestrator__ask_agents"], "ask_agents")).toBe(
    "mcp__orkestrator__ask_agents",
  );
  expect(offeredName(["other_ask_agents"], "ask_agents")).toBeUndefined();
});
