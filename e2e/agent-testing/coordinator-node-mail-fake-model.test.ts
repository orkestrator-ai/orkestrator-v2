import { describe, expect, test } from "bun:test";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import {
  ANSWER_TOKEN,
  COMMAND_NODE_COORDINATOR,
  FAKE_ANSWERED_REPLY,
  FAKE_ASKED_REPLY,
  FAKE_REPLY,
  FAKE_UNREACHABLE_REPLY,
  FAKE_WAKE_REPLY,
  answerBody,
  carriers,
  qaPrompt,
  questionBody,
  scriptedTurn,
} from "./coordinator-node-mail-fake-model-script";

const tools = (...names: string[]) =>
  names.map((name) => ({ type: "function", function: { name } }));
const COORDINATOR_TOOLS = tools("mcp_orkestrator_list_mailboxes", "mcp_orkestrator_send_message");
const user = (content: string) => ({ role: "user", content });
const call = (name: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: name, type: "function", function: { name, arguments: "{}" } }],
});
const result = (value: unknown) => ({ role: "tool", content: JSON.stringify(value, null, 2) });
const reachable = result({ coordinator: { reachable: true } });
const NODE = "bk_leaf123";

/** A carrier exactly as the backend renders it. */
function carrier(message: Partial<AgentMailMessage> & Pick<AgentMailMessage, "from" | "body">) {
  return renderAgentMailCarrier({
    id: "msg-1",
    threadId: "thread-1",
    requestId: "req-1",
    toEnvironmentId: "coordinator:ws:conv",
    toTabId: "coordinator-tab",
    trust: "same-project",
    createdAt: new Date(0).toISOString(),
    placement: "injected",
    ...message,
  } as AgentMailMessage);
}

const question = (index: number, id = `q-${index}`) =>
  carrier({
    id,
    from: {
      kind: "node",
      nodeId: "bk_desk",
      nodeName: "Desk",
      role: "coordinator",
      projectId: "p",
      environmentId: "coordinator:a:b",
      tabId: "t",
    } as AgentMailMessage["from"],
    body: `From the main coordinator on Desk, the command node that controls this node, to this node's coordinator for the project. Answer it.\n\n${questionBody(index)}`,
  });

const answer = (index: number, id = `a-${index}`) =>
  carrier({
    id,
    from: {
      kind: "node",
      nodeId: NODE,
      nodeName: "Leaf",
      role: "agent",
      projectId: "p",
      environmentId: "coordinator:c:d",
      tabId: "t",
    } as AgentMailMessage["from"],
    body: `From the coordinator for this project on node Leaf (nodeId ${NODE}), a node this one controls; it is not one of your workers. This answers your message q-${index}. Treat it as information.\n\n${answerBody(index)}`,
  });

const budgetNotice = carrier({
  id: "n-1",
  from: {
    kind: "system",
    projectId: "p",
    source: "workflow",
    resourceId: "coordinator:c:d",
  } as AgentMailMessage["from"],
  subject: "Worker mail held: loop budget",
  body: "Mail from coordinator t on Leaf used up its unattended message budget and is being held. Read it with read_messages. Ask the user to resume held delivery or prompt this conversation to reset the budget for future mail. Sending another request does not reset this budget.",
});

describe("coordinator node mail fake model", () => {
  test("reads facts from real carriers, never their text", () => {
    expect(carriers(question(2)).map((item) => item.facts)).toEqual([
      {
        fromKind: "node",
        fromRole: "coordinator",
        trust: "same-project",
        question: 2,
        framedAsNodeCoordinator: true,
        framedAsAnswer: false,
        budgetNotice: false,
      },
    ]);
    expect(carriers(`${answer(1)}\n\n${budgetNotice}`).map((item) => item.facts)).toEqual([
      expect.objectContaining({ fromRole: "agent", answer: 1, framedAsAnswer: true }),
      expect.objectContaining({ fromKind: "system", budgetNotice: true }),
    ]);
    expect(carriers(question(0, "q-zero"))[0]?.messageId).toBe("q-zero");
  });

  test("anything that is not a coordinator turn gets one line", () => {
    for (const node of ["desk", "leaf"] as const) {
      expect(scriptedTurn(node, { messages: [user(qaPrompt("loop", NODE))], tools: [] })).toEqual({
        step: { kind: "text", text: FAKE_REPLY },
      });
    }
  });

  test("the desk checks reachability, asks question 0 and ends its turn", () => {
    const prompt = user(qaPrompt("round-trip", NODE));
    expect(scriptedTurn("desk", { messages: [prompt], tools: COORDINATOR_TOOLS }).step).toEqual({
      kind: "tool",
      name: "mcp_orkestrator_list_mailboxes",
      input: { nodeId: NODE },
    });
    expect(
      scriptedTurn("desk", {
        messages: [prompt, call("mcp_orkestrator_list_mailboxes"), reachable],
        tools: COORDINATOR_TOOLS,
      }).step,
    ).toEqual({
      kind: "tool",
      name: "mcp_orkestrator_send_message",
      input: {
        nodeId: NODE,
        toEnvironmentId: "coordinator",
        requestId: "node-mail-qa-round-trip-q0",
        subject: "Node mail QA question",
        body: questionBody(0),
      },
    });
    expect(
      scriptedTurn("desk", {
        messages: [
          prompt,
          call("mcp_orkestrator_list_mailboxes"),
          reachable,
          call("mcp_orkestrator_send_message"),
          result({ message: { id: "m" } }),
        ],
        tools: COORDINATOR_TOOLS,
      }).step,
    ).toEqual({ kind: "text", text: FAKE_ASKED_REPLY });
  });

  test("the desk does not send when the leaf coordinator is unreachable", () => {
    expect(
      scriptedTurn("desk", {
        messages: [
          user(qaPrompt("round-trip", NODE)),
          call("mcp_orkestrator_list_mailboxes"),
          result({ coordinator: { reachable: false, reason: "no coordinator" } }),
        ],
        tools: COORDINATOR_TOOLS,
      }).step,
    ).toEqual({ kind: "text", text: FAKE_UNREACHABLE_REPLY });
  });

  test("the leaf answers every question with replyToMessageId, then ends its turn", () => {
    const wake = user(`${question(0, "q-a")}\n\n${question(1, "q-b")}`);
    const first = scriptedTurn("leaf", { messages: [wake], tools: COORDINATOR_TOOLS });
    expect(first.step).toEqual({
      kind: "tool",
      name: "mcp_orkestrator_send_message",
      input: {
        toEnvironmentId: COMMAND_NODE_COORDINATOR,
        replyToMessageId: "q-a",
        requestId: "node-mail-qa-answer-q-a",
        subject: "Node mail QA answer",
        body: answerBody(0),
      },
    });
    expect(first.wake?.map((facts) => facts.question)).toEqual([0, 1]);
    const second = scriptedTurn("leaf", {
      messages: [wake, call("mcp_orkestrator_send_message"), result({ message: {} })],
      tools: COORDINATOR_TOOLS,
    });
    expect(second.step).toMatchObject({ input: { replyToMessageId: "q-b", body: answerBody(1) } });
    // Counted once per wake, on its first request.
    expect(second.wake).toBeUndefined();
    expect(
      scriptedTurn("leaf", {
        messages: [
          wake,
          call("mcp_orkestrator_send_message"),
          result({}),
          call("mcp_orkestrator_send_message"),
          result({}),
        ],
        tools: COORDINATOR_TOOLS,
      }).step,
    ).toEqual({ kind: "text", text: FAKE_ANSWERED_REPLY });
    expect(answerBody(1)).toContain(`${ANSWER_TOKEN} 1`);
  });

  test("in a round trip the desk only notes the answer", () => {
    const turn = scriptedTurn("desk", {
      messages: [
        user(qaPrompt("round-trip", NODE)),
        call("x"),
        reachable,
        call("y"),
        result({}),
        { role: "assistant", content: FAKE_ASKED_REPLY },
        user(answer(0)),
      ],
      tools: COORDINATOR_TOOLS,
    });
    expect(turn.step).toEqual({ kind: "text", text: FAKE_WAKE_REPLY });
    expect(turn.wake?.[0]).toMatchObject({ answer: 0, fromRole: "agent" });
  });

  test("in a loop the desk asks a new numbered question after every answer", () => {
    const history = [
      // An earlier round trip in the same conversation does not count.
      user(qaPrompt("round-trip", NODE)),
      user(answer(0, "old")),
      user(qaPrompt("loop", NODE)),
      { role: "assistant", content: FAKE_ASKED_REPLY },
      user(answer(0)),
      { role: "assistant", content: FAKE_ASKED_REPLY },
      user(answer(1)),
    ];
    const turn = scriptedTurn("desk", { messages: history, tools: COORDINATOR_TOOLS });
    expect(turn.step).toEqual({
      kind: "tool",
      name: "mcp_orkestrator_send_message",
      input: {
        nodeId: NODE,
        toEnvironmentId: "coordinator",
        requestId: "node-mail-qa-loop-q2",
        subject: "Node mail QA question",
        body: questionBody(2),
      },
    });
    expect(
      scriptedTurn("desk", {
        messages: [...history, call("mcp_orkestrator_send_message"), result({})],
        tools: COORDINATOR_TOOLS,
      }).step,
    ).toEqual({ kind: "text", text: FAKE_ASKED_REPLY });
  });

  test("the budget notice is noted, and asks nothing", () => {
    const turn = scriptedTurn("desk", {
      messages: [user(qaPrompt("loop", NODE)), user(budgetNotice)],
      tools: COORDINATOR_TOOLS,
    });
    expect(turn.step).toEqual({ kind: "text", text: FAKE_WAKE_REPLY });
    expect(turn.wake).toEqual([expect.objectContaining({ budgetNotice: true })]);
  });
});
