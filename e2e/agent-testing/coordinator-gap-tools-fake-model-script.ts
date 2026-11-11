/**
 * The script of the coordinator gap-tools fake model
 * (`coordinator-gap-tools-fake-model.ts`, to-do 1021 (retired) tasks 1 and 4): what a
 * Pi coordinator and its Pi worker on a loopback model do with the live
 * suite's `gap-tools` scenario (`coordinator-live-gap-tools.ts`). Pure, so
 * the rules have unit tests that need no provider.
 *
 * Requests arrive in OpenAI chat-completions form, which Pi uses for a
 * provider declared with `api: "openai-completions"`.
 *
 * - The coordinator (it is offered `fork_worker`, which only a main
 *   coordinator gets): a harness turn's numbered steps, one tool call per
 *   request in order, each `<tool.field>` filled from that tool's result
 *   earlier in the turn; then one line of text. A wake (a peer-message
 *   carrier) gets one line of text, and what it said is counted.
 * - The worker (anything else that is offered tools): the launch task's one
 *   shell command through Pi's `bash` tool, then "ready"; the long turn is
 *   parked until Pi aborts the request, which is what `stop_worker_turn`
 *   must cause; anything else gets one line.
 * - A request offered no tools (a compaction summary, a title) gets one line.
 *
 * The fake decides nothing a real model would: it replays the harness's
 * steps. A pass proves the product's plumbing (the tools, their scopes and
 * node paths, the wakes), not that a model reads the tool descriptions right.
 */
import {
  fillGapPlaceholders,
  gapResultJson,
  parseGapSteps,
  GAP_LONG_TURN_MARKER,
  GAP_SHELL_MARKER,
} from "../../apps/desktop/scripts/dev/coordinator-live-gap-tools";

export type ChatMessage = { role?: unknown; content?: unknown; tool_calls?: unknown };

export type FakeStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "park" };

/** Facts about one coordinator wake prompt, counted by the server. Never its text. */
export interface WakeFacts {
  /** It says the coordinator stopped the worker's turn with stop_worker_turn. */
  stoppedByCoordinator: boolean;
}

export type Speaker = "coordinator" | "worker" | "other";

export interface ScriptedTurn {
  speaker: Speaker;
  step: FakeStep;
  /** Set on the first request of a coordinator wake turn only, so each wake counts once. */
  wake?: WakeFacts;
}

export const FAKE_REPLY = "Done.";
export const FAKE_WAKE_REPLY = "Noted.";
export const FAKE_WORKER_REPLY = "ready";

const CARRIER = "<orkestrator-peer-message";
const COMMAND = /The command: (.+)$/m;

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

/** The name the runtime offers for a tool: bare, or MCP-prefixed (`mcp_orkestrator_<tool>`). */
export function offeredName(offered: readonly string[], tool: string): string | undefined {
  return (
    offered.find((name) => name === tool) ??
    offered.find((name) => name.endsWith(`__${tool}`) || name.endsWith(`orkestrator_${tool}`))
  );
}

function lastUserIndex(list: readonly ChatMessage[]): number {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") return index;
  }
  return -1;
}

function coordinatorStep(
  prompt: string,
  results: readonly string[],
  offered: readonly string[],
): FakeStep {
  const steps = parseGapSteps(prompt);
  if (steps.length === 0 || results.length >= steps.length)
    return { kind: "text", text: FAKE_REPLY };
  const earlier = new Map<string, unknown>();
  results.forEach((result, index) => earlier.set(steps[index]!.tool, gapResultJson(result)));
  const step = steps[results.length]!;
  const input = fillGapPlaceholders(step.args, earlier);
  if (!input) return { kind: "text", text: `A value for ${step.tool} could not be filled.` };
  const name = offeredName(offered, step.tool);
  return name
    ? { kind: "tool", name, input }
    : { kind: "text", text: `The ${step.tool} tool is not offered.` };
}

function workerStep(
  prompt: string,
  results: readonly string[],
  offered: readonly string[],
): FakeStep {
  if (prompt.includes(GAP_LONG_TURN_MARKER) && results.length === 0) return { kind: "park" };
  if (prompt.includes(GAP_SHELL_MARKER)) {
    if (results.length > 0) return { kind: "text", text: FAKE_WORKER_REPLY };
    const command = COMMAND.exec(prompt)?.[1]?.trim();
    const bash = offeredName(offered, "bash");
    if (!command || !bash) return { kind: "text", text: "No shell command or no bash tool." };
    return { kind: "tool", name: bash, input: { command } };
  }
  return { kind: "text", text: FAKE_REPLY };
}

/** The next step of a request. */
export function scriptedTurn(request: { messages: unknown; tools?: unknown }): ScriptedTurn {
  const list = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : [];
  const offered = offeredTools(request.tools);
  if (offered.length === 0) return { speaker: "other", step: { kind: "text", text: FAKE_REPLY } };
  const lastUser = lastUserIndex(list);
  const prompt = messageText(list[lastUser]);
  const results = (lastUser < 0 ? [] : list.slice(lastUser + 1))
    .filter((message) => message?.role === "tool")
    .map(messageText);

  if (!offeredName(offered, "fork_worker"))
    return { speaker: "worker", step: workerStep(prompt, results, offered) };
  if (prompt.includes(CARRIER)) {
    return {
      speaker: "coordinator",
      step: { kind: "text", text: FAKE_WAKE_REPLY },
      ...(results.length === 0
        ? {
            wake: {
              stoppedByCoordinator: prompt.includes("you stopped its turn with stop_worker_turn"),
            },
          }
        : {}),
    };
  }
  return { speaker: "coordinator", step: coordinatorStep(prompt, results, offered) };
}
