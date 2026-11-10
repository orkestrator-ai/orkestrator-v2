/**
 * The script of the coordinator node-mail fake model
 * (`coordinator-node-mail-fake-model.ts`, to-do 2900): what a command node's
 * Pi main coordinator ("desk") and a leaf's Pi main coordinator ("leaf") do
 * when they mail each other across a real node link. Pure, so the rules have
 * unit tests that need no provider.
 *
 * Requests arrive in OpenAI chat-completions form, which Pi uses for a
 * provider declared with `api: "openai-completions"`. The server tells the
 * script which node's Pi sent the request by the base path it was given.
 *
 * Desk:
 * - A prompt with `NODE-MAIL-QA mode=<round-trip|loop> node=<nodeId>`:
 *   `list_mailboxes` with that `nodeId` (does the leaf have a reachable
 *   coordinator?), then `send_message` with `nodeId` and `toEnvironmentId:
 *   "coordinator"` asking question 0, then one line of text.
 * - A wake carrying the leaf coordinator's answer: in `round-trip` mode, one
 *   line of text. In `loop` mode it asks the next question as a new message
 *   (not a reply), so the two coordinators keep asking each other until the
 *   command node's unattended budget holds the leaf's mail.
 * - Any other wake (the budget notice): one line of text.
 *
 * Leaf:
 * - A wake carrying questions from the command node's coordinator: one
 *   `send_message` per question with `toEnvironmentId:
 *   "command-node-coordinator"` and `replyToMessageId` set to the question's
 *   message id, then one line of text.
 *
 * Anything that is not offered `send_message` (it is not a coordinator turn)
 * gets one line of text. What each wake carried is counted as facts, never
 * its text.
 */

export type ChatMessage = { role?: unknown; content?: unknown; tool_calls?: unknown };

export type FakeStep =
  { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown> };

export type FakeNode = "desk" | "leaf";

export type QaMode = "round-trip" | "loop";

/** One mail carrier in a wake prompt, reduced to facts. Never its body. */
export interface CarrierFacts {
  /** `from.kind` of the carrier's sender. */
  fromKind: string;
  /** `from.role` for a `node` sender. */
  fromRole?: string;
  trust?: string;
  /** A question from the desk's script (`Question <n>`). */
  question?: number;
  /** An answer from the leaf's script (`LEAF-ANSWER <n>`). */
  answer?: number;
  /**
   * The receiving node framed it as the other node's coordinator: on the
   * command node "From the coordinator for this project on node …", on the
   * leaf "From the main coordinator on …, the command node …".
   */
  framedAsNodeCoordinator: boolean;
  /** The command node's framing says it answers an earlier message. */
  framedAsAnswer: boolean;
  /** The command node's loop-budget notice for the leaf coordinator's mail. */
  budgetNotice: boolean;
}

export interface ScriptedTurn {
  step: FakeStep;
  /** Set on the first request of a wake turn only, so each wake counts once. */
  wake?: CarrierFacts[];
}

export const FAKE_REPLY = "Done.";
export const FAKE_ASKED_REPLY = "Asked the leaf's coordinator.";
export const FAKE_UNREACHABLE_REPLY = "The leaf's coordinator is not reachable.";
export const FAKE_WAKE_REPLY = "Noted.";
export const FAKE_ANSWERED_REPLY = "Answered.";

export const QA_MARKER = "NODE-MAIL-QA";
export const ANSWER_TOKEN = "LEAF-ANSWER";
export const COMMAND_NODE_COORDINATOR = "command-node-coordinator";
const MARKER = /NODE-MAIL-QA mode=(round-trip|loop) node=([A-Za-z0-9_.:-]{1,200})/;
const QUESTION = /\bQuestion (\d{1,4})\b/;
const ANSWER = /\bLEAF-ANSWER (\d{1,4})\b/;
const PAYLOAD = /<orkestrator-peer-payload-json>\s*([^]*?)\s*<\/orkestrator-peer-payload-json>/g;
const MAX_CARRIERS = 50;

/** The prompt that starts a run, as the spec sends it to the desk's coordinator. */
export function qaPrompt(mode: QaMode, nodeId: string): string {
  return [
    `${QA_MARKER} mode=${mode} node=${nodeId}`,
    mode === "loop"
      ? 'Ask the leaf\'s main coordinator a question with send_message, nodeId and toEnvironmentId "coordinator". Whenever it answers, ask it another question.'
      : 'Ask the leaf\'s main coordinator one question with send_message, nodeId and toEnvironmentId "coordinator", and wait for its answer.',
  ].join("\n");
}

export function questionBody(index: number): string {
  // Names no answer token itself, so a question is never read as an answer.
  return `Question ${index} from the command node's coordinator: reply with your answer token and this question's number.`;
}

export function answerBody(index: number | undefined): string {
  return `${ANSWER_TOKEN} ${index ?? "?"}: answered by the leaf's coordinator.`;
}

export function messageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

export function offeredTools(tools: unknown): string[] {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => (tool as { function?: { name?: unknown } } | null)?.function?.name)
    .filter((name): name is string => typeof name === "string");
}

/** The name the runtime offers for an Orkestrator tool: bare, or MCP-prefixed. */
export function offeredName(offered: readonly string[], tool: string): string | undefined {
  return (
    offered.find((name) => name === tool) ??
    offered.find((name) => name.endsWith(`__${tool}`) || name.endsWith(`orkestrator_${tool}`))
  );
}

/** The first JSON object in a tool result, or undefined. */
export function resultJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return record(value);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type Carrier = { messageId?: string; facts: CarrierFacts };

/** Every mail carrier payload in a prompt, in order. */
export function carriers(prompt: string): Carrier[] {
  const found: Carrier[] = [];
  for (const match of prompt.matchAll(PAYLOAD)) {
    if (found.length >= MAX_CARRIERS) break;
    let payload: Record<string, unknown> | undefined;
    try {
      payload = record(JSON.parse(match[1]!));
    } catch {
      payload = undefined;
    }
    if (!payload) continue;
    const from = record(payload.from) ?? {};
    const body = typeof payload.body === "string" ? payload.body : "";
    const subject = typeof payload.subject === "string" ? payload.subject : "";
    const question = QUESTION.exec(body)?.[1];
    const answer = ANSWER.exec(body)?.[1];
    found.push({
      ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
      facts: {
        fromKind: typeof from.kind === "string" ? from.kind : "unknown",
        ...(typeof from.role === "string" ? { fromRole: from.role } : {}),
        ...(typeof payload.trust === "string" ? { trust: payload.trust } : {}),
        ...(question !== undefined ? { question: Number(question) } : {}),
        ...(answer !== undefined ? { answer: Number(answer) } : {}),
        framedAsNodeCoordinator:
          from.kind === "node" &&
          (body.startsWith("From the coordinator for this project on node ") ||
            body.startsWith("From the main coordinator on ")),
        framedAsAnswer: from.kind === "node" && /This answers your message \S+\./.test(body),
        budgetNotice:
          from.kind === "system" &&
          subject.includes("loop budget") &&
          body.includes("Sending another request does not reset this budget"),
      },
    });
  }
  return found;
}

function lastUserIndex(list: readonly ChatMessage[]): number {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") return index;
  }
  return -1;
}

/** The latest run marker in the conversation, and where it is. */
function latestMarker(
  list: readonly ChatMessage[],
): { mode: QaMode; nodeId: string; index: number } | undefined {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== "user") continue;
    const text = messageText(list[index]);
    // A mail carrier quoting the marker is not the user's prompt.
    if (text.includes("<orkestrator-peer-message")) continue;
    const match = MARKER.exec(text);
    if (match) return { mode: match[1] as QaMode, nodeId: match[2]!, index };
  }
  return undefined;
}

function tool(offered: readonly string[], name: string, input: Record<string, unknown>): FakeStep {
  const offeredAs = offeredName(offered, name);
  return offeredAs
    ? { kind: "tool", name: offeredAs, input }
    : { kind: "text", text: `The ${name} tool is not offered.` };
}

/** Whether a `list_mailboxes` result with `nodeId` says the leaf coordinator is reachable. */
export function reachable(result: string): boolean {
  const coordinator = record(resultJson(result)?.coordinator);
  return coordinator?.reachable === true;
}

/** The next step of a request from `node`'s Pi. */
export function scriptedTurn(
  node: FakeNode,
  request: { messages: unknown; tools?: unknown },
): ScriptedTurn {
  const list = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : [];
  const offered = offeredTools(request.tools);
  if (!offeredName(offered, "send_message")) return { step: { kind: "text", text: FAKE_REPLY } };

  const lastUser = lastUserIndex(list);
  const prompt = messageText(list[lastUser]);
  const results = (lastUser < 0 ? [] : list.slice(lastUser + 1))
    .filter((message) => message?.role === "tool")
    .map(messageText);
  const found = carriers(prompt);
  const wake = found.length > 0 && results.length === 0 ? found.map((item) => item.facts) : [];
  const withWake = (step: FakeStep): ScriptedTurn => (wake.length > 0 ? { step, wake } : { step });

  if (node === "leaf") {
    const questions = found.filter(
      (item) => item.facts.fromKind === "node" && item.facts.fromRole === "coordinator",
    );
    if (questions.length === 0) return withWake({ kind: "text", text: FAKE_REPLY });
    const next = questions[results.length];
    if (!next) return withWake({ kind: "text", text: FAKE_ANSWERED_REPLY });
    if (!next.messageId) return withWake({ kind: "text", text: "The question had no id." });
    return withWake(
      tool(offered, "send_message", {
        toEnvironmentId: COMMAND_NODE_COORDINATOR,
        replyToMessageId: next.messageId,
        requestId: `node-mail-qa-answer-${next.messageId}`.slice(0, 200),
        subject: "Node mail QA answer",
        body: answerBody(next.facts.question),
      }),
    );
  }

  const marker = latestMarker(list);
  if (found.length === 0) {
    if (!marker || marker.index !== lastUser) return { step: { kind: "text", text: FAKE_REPLY } };
    if (results.length === 0)
      return { step: tool(offered, "list_mailboxes", { nodeId: marker.nodeId }) };
    if (results.length === 1) {
      if (!reachable(results[0]!)) return { step: { kind: "text", text: FAKE_UNREACHABLE_REPLY } };
      return {
        step: tool(offered, "send_message", {
          nodeId: marker.nodeId,
          toEnvironmentId: "coordinator",
          requestId: `node-mail-qa-${marker.mode}-q0`,
          subject: "Node mail QA question",
          body: questionBody(0),
        }),
      };
    }
    return { step: { kind: "text", text: FAKE_ASKED_REPLY } };
  }

  // A wake. Only a loop run asks again, and only when an answer arrived.
  const answered = found.some((item) => item.facts.answer !== undefined);
  if (!marker || marker.mode !== "loop" || !answered)
    return withWake({ kind: "text", text: FAKE_WAKE_REPLY });
  if (results.length > 0) return { step: { kind: "text", text: FAKE_ASKED_REPLY } };
  // The next question follows every answer since the run's prompt.
  const answers = list
    .slice(marker.index + 1)
    .filter((message) => message?.role === "user")
    .flatMap((message) => carriers(messageText(message)))
    .filter((item) => item.facts.answer !== undefined).length;
  return withWake(
    tool(offered, "send_message", {
      nodeId: marker.nodeId,
      toEnvironmentId: "coordinator",
      requestId: `node-mail-qa-loop-q${answers}`,
      subject: "Node mail QA question",
      body: questionBody(answers),
    }),
  );
}
