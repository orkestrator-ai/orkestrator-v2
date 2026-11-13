/**
 * The script of the subork fake model (`suborks-fake-model.ts`, 4340
 * (retired) tasks 1 and 4): what a compliant model does with each request a `/subork`
 * call sends, on the caller's side and on each target's. Pure, so the rules
 * have unit tests that need no provider.
 *
 * Requests arrive in OpenAI chat-completions form, which Pi (a provider
 * declared with `api: "openai-completions"`) and OpenCode (a custom
 * `@ai-sdk/openai-compatible` provider) both send.
 *
 * - **Caller, the `/subork` carrier.** The request names its targets in a
 *   `[targets:pi,opencode]` marker and its run in a `QATAG` tag. The fake
 *   calls `ask_agents` once with those agents, a prompt carrying the tag and a
 *   `requestId` derived from it, then ends the turn in prose.
 * - **Target, a subork's turn.** Its prompt opens with the subork
 *   instructions and its result instruction names `submit_subork_answer` and
 *   a result key. The fake submits `SUBORK-ANSWER <platform> <tag>` once, then
 *   replies in prose. A later request of the same session (the runner's
 *   reminder after a restart) carries a newer result key, which wins.
 * - **A title request.** OpenCode asks its small model for a session title
 *   in a separate request that offers no tools; it gets a fixed title and is
 *   never counted as a turn.
 * - **Caller, the wake.** The delivery mail opens "Your suborks have
 *   settled". The fake replies with the tag and how many answers it read.
 *
 * Nothing here keeps a prompt: the facts it reports are tags, counts and
 * tool names.
 */

export type ChatMessage = { role?: unknown; content?: unknown };

export type FakeStep =
  { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown> };

/** The two platforms a scripted run covers: both send chat completions. */
export const SCRIPTED_PLATFORMS = ["pi", "opencode"] as const;
export type ScriptedPlatform = (typeof SCRIPTED_PLATFORMS)[number];

export const ASK_AGENTS_TOOL = "ask_agents";
export const SUBMIT_ANSWER_TOOL = "submit_subork_answer";
/** The prose a turn ends with once its tool call has been answered. */
export const FAKE_REPLY = "Done.";
/** The answer to a title request. */
export const TITLE_REPLY = "Subork QA";
/** What the delivery mail opens with (`renderSuborkDeliveryBody`). */
export const DELIVERY_OPENING = "Your suborks have settled";
/** What a subork's prompt opens with (`renderSuborkPrompt`). */
export const SUBORK_PROMPT_OPENING = "You are a subork";
const CARRIER_OPENING = "<orkestrator-subork-request>";

/** A qualification tag: `QATAG` and eight upper-case hex digits. */
export const QA_TAG = /\bQATAG[0-9A-F]{8}\b/;
const TARGETS = /\[targets:([a-z,]{1,80})\]/;
const RESULT_KEY = /resultKey "?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/g;
const CAPABILITY = /capability "([^"\s]{1,512})"/g;
const ANSWER = /SUBORK-ANSWER ([a-z]+) (QATAG[0-9A-F]{8})/g;

/** The answer a target submits: its own platform and the run's tag. */
export function suborkAnswer(platform: string, tag: string): string {
  return `SUBORK-ANSWER ${platform} ${tag}`;
}

/** The prompt the caller gives every target. */
export function targetPrompt(tag: string): string {
  return `Reply with your agent name and the tag ${tag}.`;
}

/** The `/subork` request a spec types, in words a real model also follows. */
export function suborkRequest(targets: readonly string[], tag: string): string {
  return `ask ${targets.join(" and ")} [targets:${targets.join(",")}] to reply with their agent name and the tag ${tag}`;
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

function lastMatch(pattern: RegExp, text: string): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(pattern)) found = match[1];
  return found;
}

export function offeredTools(tools: unknown): string[] {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => (tool as { function?: { name?: unknown } } | null)?.function?.name)
    .filter((name): name is string => typeof name === "string");
}

/**
 * The name a runtime offers `tool` under: bare, or prefixed by its MCP server
 * (`orkestrator_ask_agents` on OpenCode, `mcp__orkestrator__ask_agents`).
 */
export function offeredName(offered: readonly string[], tool: string): string | undefined {
  return (
    offered.find((name) => name === tool) ??
    offered.find(
      (name) =>
        name.includes("orkestrator") && (name.endsWith(`_${tool}`) || name.endsWith(`.${tool}`)),
    )
  );
}

export interface ScriptedRequest {
  messages: unknown;
  tools?: unknown;
}

/** Content-free facts about one request, for the spec's assertions. */
export interface TurnFacts {
  /** `title`: a request offering no tools, as OpenCode's own title requests are. */
  role: "caller" | "target" | "wake" | "title" | "other";
  tag?: string;
  /** The last message is the user's, so this request starts a turn. */
  turnStart: boolean;
  /** Whether `ask_agents` was offered (a subork must be refused it). */
  offersAskAgents: boolean;
  /** Wake only: the answers the mail carried, as `platform` names. */
  answers?: string[];
}

export interface ScriptedTurn {
  step: FakeStep;
  facts: TurnFacts;
}

/**
 * The next step for `platform` (the base path the request arrived on).
 */
export function scriptedTurn(platform: string, request: ScriptedRequest): ScriptedTurn {
  const list = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : [];
  let lastUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const prompt = messageText(list[lastUser]);
  const after = lastUser < 0 ? [] : list.slice(lastUser + 1);
  const toolResults = after.filter((message) => message?.role === "tool").length;
  const turnStart = lastUser >= 0 && lastUser === list.length - 1;
  const offered = offeredTools(request.tools);
  const offersAskAgents = offeredName(offered, ASK_AGENTS_TOOL) !== undefined;
  const history = list
    .slice(0, lastUser + 1)
    .filter((message) => message?.role === "system" || message?.role === "user")
    .map(messageText)
    .join("\n");

  // OpenCode names a session with a separate, tool-less request carrying the
  // same user text. It is not a turn, so it is never the caller or a target.
  if (offered.length === 0) {
    return {
      step: { kind: "text", text: TITLE_REPLY },
      facts: { role: "title", turnStart, offersAskAgents },
    };
  }

  // A subork's session: its first prompt opens with the subork instructions;
  // a reminder turn later in the same session still has them in history.
  if (history.includes(SUBORK_PROMPT_OPENING) && history.includes(SUBMIT_ANSWER_TOOL)) {
    const tag = QA_TAG.exec(history)?.[0];
    const facts: TurnFacts = {
      role: "target",
      turnStart,
      offersAskAgents,
      ...(tag ? { tag } : {}),
    };
    const resultKey = lastMatch(RESULT_KEY, history);
    const name = offeredName(offered, SUBMIT_ANSWER_TOOL);
    if (!resultKey || !name || toolResults > 0 || !tag) {
      return {
        step: { kind: "text", text: tag ? suborkAnswer(platform, tag) : FAKE_REPLY },
        facts,
      };
    }
    const capability = lastMatch(CAPABILITY, history);
    return {
      step: {
        kind: "tool",
        name,
        input: {
          resultKey,
          ...(capability ? { capability } : {}),
          result: { answer: suborkAnswer(platform, tag) },
        },
      },
      facts,
    };
  }

  // The wake: the delivery mail, whatever envelope the mailbox put round it.
  if (prompt.includes(DELIVERY_OPENING)) {
    const answers = [...prompt.matchAll(ANSWER)];
    const tag = answers[0]?.[2] ?? QA_TAG.exec(prompt)?.[0];
    return {
      step: {
        kind: "text",
        text: `ANSWERS-RECEIVED ${tag ?? "untagged"} ${answers.length}`,
      },
      facts: {
        role: "wake",
        turnStart,
        offersAskAgents,
        answers: answers.map((match) => match[1]!),
        ...(tag ? { tag } : {}),
      },
    };
  }

  // The `/subork` carrier on the caller's tab.
  if (prompt.startsWith(CARRIER_OPENING) || prompt.includes(CARRIER_OPENING)) {
    const tag = QA_TAG.exec(prompt)?.[0];
    const targets = TARGETS.exec(prompt)?.[1]?.split(",").filter(Boolean) ?? [];
    const facts: TurnFacts = {
      role: "caller",
      turnStart,
      offersAskAgents,
      ...(tag ? { tag } : {}),
    };
    const name = offeredName(offered, ASK_AGENTS_TOOL);
    if (!name) return { step: { kind: "text", text: `${ASK_AGENTS_TOOL} is not offered.` }, facts };
    if (toolResults > 0 || !tag || targets.length === 0) {
      return { step: { kind: "text", text: FAKE_REPLY }, facts };
    }
    return {
      step: {
        kind: "tool",
        name,
        input: {
          targets: targets.map((agent) => ({ agent, name: `${agent} ${tag}` })),
          prompt: targetPrompt(tag),
          requestId: `subork-qa-${tag}`,
        },
      },
      facts,
    };
  }
  return {
    step: { kind: "text", text: FAKE_REPLY },
    facts: { role: "other", turnStart, offersAskAgents },
  };
}
