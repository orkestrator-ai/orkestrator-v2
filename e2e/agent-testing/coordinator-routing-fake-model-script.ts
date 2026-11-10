/**
 * The script of the coordinator routing fake model
 * (`coordinator-routing-fake-model.ts`, to-do 7545 task 4): what a Pi
 * coordinator on a loopback model does with the routing scenario's `build`
 * request, and with the status wake that follows when the harness cancels the
 * build. Pure, so the rules have unit tests that need no provider.
 *
 * Requests arrive in OpenAI chat-completions form, which Pi uses for a
 * provider declared with `api: "openai-completions"`.
 *
 * - The build request (it names `clampPercent`): `get_launch_options`, then
 *   `create_ticket` with acceptance criteria, then `start_build_pipeline` for
 *   that ticket on the saved defaults, then one line of text. The arguments
 *   come from the conversation itself: the project id from the coordinator
 *   context, the base from the launch options, the ticket id from the
 *   `create_ticket` result.
 * - A wake (a peer-message carrier): one line of text, and nothing else. What
 *   the wake said is counted (`WakeFacts`) so the spec can prove the cancelled
 *   notice reached the model's prompt with the wording the backend sends. The
 *   fake does not decide whether to restart; a real model does. A fake-model
 *   pass therefore proves the product's plumbing, not a model's obedience.
 * - Anything that is not the coordinator (it is not offered
 *   `start_build_pipeline`), which here is only the build's own Pi session:
 *   parked until its request is aborted, so the build is still running when
 *   the harness cancels it, as in a real run.
 */

export type ChatMessage = { role?: unknown; content?: unknown; tool_calls?: unknown };

export type FakeStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "park" };

/** Facts about one wake prompt, counted by the server. Never its text. */
export interface WakeFacts {
  /** The wake carries a build pipeline notice that says it was cancelled. */
  cancelled: boolean;
  /** It says a cancel the coordinator did not make is the user's decision. */
  userDecision: boolean;
  /** It tells the coordinator not to start another build unless asked. */
  noRebuild: boolean;
  /** It offers a restart, resume or new build call. */
  offersRestart: boolean;
}

export interface ScriptedTurn {
  step: FakeStep;
  /** Set on the first request of a wake turn only, so each wake counts once. */
  wake?: WakeFacts;
}

export const FAKE_REPLY = "Done.";
export const FAKE_BUILD_REPLY = "Started a build for it.";
export const FAKE_WAKE_REPLY = "Noted.";

const CARRIER = "<orkestrator-peer-message";
const BUILD_MARKER = "clampPercent";
const PROJECT_ID = /Project: [^\n]*?\(id ([A-Za-z0-9_-]{1,200})\)/;
const COMMIT = /^[0-9a-f]{40}$/i;

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

/** The name the runtime offers for an Orkestrator tool: bare, or MCP-prefixed (`mcp_orkestrator_<tool>`). */
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
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function wakeFacts(prompt: string): WakeFacts {
  return {
    cancelled: /Build pipeline[^\n]*was cancelled/.test(prompt),
    userDecision: prompt.includes("If you did not cancel it yourself, the user did"),
    noRebuild: prompt.includes("do not start another build for this ticket"),
    offersRestart: /restart_build_pipeline_step|resume_build_pipeline \{/.test(prompt),
  };
}

const ACCEPTANCE = [
  "- clampPercent returns 0 for a value below 0, the value inside 0 to 100, and 100 above 100.",
  "- The new tests and the project's existing bun test suite pass.",
].join("\n");

/** The next step of a request. */
export function scriptedTurn(request: { messages: unknown; tools?: unknown }): ScriptedTurn {
  const list = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : [];
  const offered = offeredTools(request.tools);
  const start = offeredName(offered, "start_build_pipeline");
  if (!start) return { step: { kind: "park" } };

  let lastUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const prompt = messageText(list[lastUser]);
  const results = (lastUser < 0 ? [] : list.slice(lastUser + 1))
    .filter((message) => message?.role === "tool")
    .map(messageText);

  if (prompt.includes(CARRIER)) {
    return {
      step: { kind: "text", text: FAKE_WAKE_REPLY },
      ...(results.length === 0 ? { wake: wakeFacts(prompt) } : {}),
    };
  }
  if (!prompt.includes(BUILD_MARKER)) return { step: { kind: "text", text: FAKE_REPLY } };

  const context = list
    .slice(0, lastUser + 1)
    .filter((message) => message?.role === "system" || message?.role === "user")
    .map(messageText)
    .join("\n");
  const projectId = PROJECT_ID.exec(context)?.[1];
  const title = "Add clampPercent with tests";
  const tool = (name: string, input: Record<string, unknown>): ScriptedTurn => {
    const offeredAs = offeredName(offered, name);
    return offeredAs
      ? { step: { kind: "tool", name: offeredAs, input } }
      : { step: { kind: "text", text: `The ${name} tool is not offered.` } };
  };
  if (!projectId) return { step: { kind: "text", text: "No project id in the context." } };
  if (results.length === 0) return tool("get_launch_options", { projectId });
  if (results.length === 1)
    return tool("create_ticket", {
      requestId: "routing-fake-ticket",
      projectId,
      title,
      description: prompt.slice(0, 4_000),
      acceptanceCriteria: ACCEPTANCE,
      status: "in-progress",
    });
  if (results.length === 2) {
    const base = record(resultJson(results[0]!)?.coordinatorBase);
    const ticket = record(resultJson(results[1]!)?.ticket);
    const baseBranch = typeof base?.baseBranch === "string" ? base.baseBranch : undefined;
    const baseCommit = typeof base?.baseCommit === "string" ? base.baseCommit : undefined;
    const taskId = typeof ticket?.id === "string" ? ticket.id : undefined;
    if (!baseBranch || !baseCommit || !COMMIT.test(baseCommit) || !taskId)
      return { step: { kind: "text", text: "The launch base or the ticket could not be read." } };
    return tool("start_build_pipeline", {
      requestId: "routing-fake-build",
      taskId,
      baseBranch,
      baseCommit,
      taskTitle: title,
      taskSnapshot: {
        title,
        description: prompt.slice(0, 4_000),
        acceptanceCriteria: ACCEPTANCE,
      },
    });
  }
  return { step: { kind: "text", text: FAKE_BUILD_REPLY } };
}
