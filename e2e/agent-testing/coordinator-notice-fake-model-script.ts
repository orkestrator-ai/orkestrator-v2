/**
 * The script of the coordinator notice fake model
 * (`coordinator-notice-fake-model.ts`, to-do 7542): fixture Claude accounts,
 * which of them is out of usage, what their usage reads, and what the leaf's
 * Pi coordinator does. Pure, so the rules have unit tests that need no
 * provider.
 *
 * - **Claude** (Anthropic Messages, every profile's CLI through its isolated
 *   `settings.json`). The bearer token names the fixture account. A call on a
 *   limited account that carries a run marker (`NOTICE-QA:<kind>:<run>`) is
 *   refused with the API's plan-limit error; every other call gets one line of
 *   text, so a CLI's incidental calls never fail a turn. A call whose prompt is
 *   a usage-limit notice is reduced to facts (how many sessions of each kind it
 *   lists, whether it says the machine moved first), never its text.
 * - **Pi** (OpenAI chat completions, the leaf's main coordinator). A prompt
 *   with `NOTICE-QA-LAUNCH <json>` calls `launch_environment` with that input,
 *   so a delegated worker exists; anything else gets one line of text. A wake
 *   carrying a usage-limit notice is counted, because the leaf's coordinator
 *   must never get one while a command node takes its repository's notices.
 * - **Usage** (`/api/oauth/usage`). Every account reads below its weekly
 *   limit, so a refusal is a stop the machine does not switch on (the leaf has
 *   automatic switching off anyway). The limited login shared with the command
 *   node resets sooner than the account with headroom, so automatic switching
 *   there stays on it until a notice moves it off.
 */

export type FixtureAccount = "leaf-a" | "leaf-b" | "leaf-c" | "desk-b" | "desk-h";

/**
 * Each fixture account's email. `leaf-b` and `desk-b` are one login under two
 * machines' entries (task 3); the `limited-*` logins are out of usage.
 */
export const FIXTURE_ACCOUNTS: Record<FixtureAccount, { email: string; resetDays: number }> = {
  "leaf-a": { email: "limited-a@example.com", resetDays: 2 },
  "leaf-b": { email: "limited-b@example.com", resetDays: 2 },
  "leaf-c": { email: "limited-c@example.com", resetDays: 2 },
  "desk-b": { email: "limited-b@example.com", resetDays: 2 },
  "desk-h": { email: "headroom@example.com", resetDays: 5 },
};

export const LIMITED_EMAILS: ReadonlySet<string> = new Set([
  "limited-a@example.com",
  "limited-b@example.com",
  "limited-c@example.com",
]);

export function fixtureClaudeToken(account: FixtureAccount): string {
  return `fixture-claude-notice-${account}`;
}

export function accountOfToken(authorization: string | null): FixtureAccount | undefined {
  const bearer = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  return (Object.keys(FIXTURE_ACCOUNTS) as FixtureAccount[]).find(
    (account) => fixtureClaudeToken(account) === bearer,
  );
}

export function isLimited(account: FixtureAccount | undefined): boolean {
  return account !== undefined && LIMITED_EMAILS.has(FIXTURE_ACCOUNTS[account].email);
}

export type SessionKind = "tab" | "worker" | "pipeline";
export const SESSION_KINDS: readonly SessionKind[] = ["tab", "worker", "pipeline"];

const RUN_MARKER = /NOTICE-QA:(tab|worker|pipeline):([a-z0-9-]{1,40})/;

/** A session's prompt marker, which the spec puts in each session's prompt. */
export function runMarker(kind: SessionKind, run: string): string {
  return `NOTICE-QA:${kind}:${run}`;
}

/** The run marker any user text of a Messages request carries. */
export function markerOf(userTexts: readonly string[]): { kind: SessionKind; run: string } | null {
  for (const text of userTexts) {
    const match = RUN_MARKER.exec(text);
    if (match) return { kind: match[1] as SessionKind, run: match[2]! };
  }
  return null;
}

type AnthropicBlock = { type?: unknown; text?: unknown; content?: unknown };
type AnthropicMessage = { role?: unknown; content?: unknown };

function blockTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content as AnthropicBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (block?.type === "tool_result") texts.push(...blockTexts(block.content));
  }
  return texts;
}

/** Every user-authored text of a Messages request, in order. */
export function claudeUserTexts(body: { messages?: unknown }): string[] {
  const texts: string[] = [];
  for (const message of Array.isArray(body.messages) ? (body.messages as AnthropicMessage[]) : []) {
    if (message?.role === "user") texts.push(...blockTexts(message.content));
  }
  return texts;
}

/** The last user message's text, the prompt this request answers. */
export function claudeLastUserText(body: { messages?: unknown }): string {
  const messages = Array.isArray(body.messages) ? (body.messages as AnthropicMessage[]) : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return blockTexts(messages[index]!.content).join("\n");
  }
  return "";
}

/** What a usage-limit notice in a prompt says, as counts. Never its text. */
export interface NoticeFacts {
  /** Stop lines by session kind. */
  tab: number;
  worker: number;
  pipeline: number;
  coordinator: number;
  /** "this machine moved to … before this turn". */
  movedFirst: boolean;
  /** Kept without a wake because the coordinator could not move. */
  kept: boolean;
  /** "This window already woke you once". */
  followUp: boolean;
}

const PAYLOAD = /<orkestrator-peer-payload-json>\s*([^]*?)\s*<\/orkestrator-peer-payload-json>/g;
const NOTICE_HEAD = /stopped on a usage limit on "/;

/** The bodies a prompt carries: each mail payload's, or the prompt itself. */
function bodies(prompt: string): string[] {
  const found: string[] = [];
  for (const match of prompt.matchAll(PAYLOAD)) {
    try {
      const payload = JSON.parse(match[1]!) as { body?: unknown };
      if (typeof payload.body === "string") found.push(payload.body);
    } catch {
      // Not a payload this script can read.
    }
  }
  return found.length > 0 ? found : [prompt];
}

/** The usage-limit notices a prompt carries, one entry per notice. */
export function noticeFacts(prompt: string): NoticeFacts[] {
  return bodies(prompt)
    .filter((body) => NOTICE_HEAD.test(body))
    .map((body) => {
      const lines = body.split("\n");
      const count = (prefix: string) => lines.filter((line) => line.startsWith(prefix)).length;
      return {
        tab: count("- tab "),
        worker: count("- delegated worker "),
        pipeline: count("- pipeline session "),
        coordinator: count("- coordinator "),
        movedFirst: /so this machine moved to "[^"]*" before this turn/.test(body),
        kept: body.includes("This notice is kept and no turn was started for it."),
        followUp: body.includes("This window already woke you once"),
      };
    });
}

// --- Pi (the leaf's main coordinator) ---

export type ChatMessage = { role?: unknown; content?: unknown };
export type PiStep =
  { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown> };

export const LAUNCH_MARKER = "NOTICE-QA-LAUNCH";
export const PI_REPLY = "Noted.";
export const PI_LAUNCHED_REPLY = "Launched the worker.";

function chatText(message: ChatMessage | undefined): string {
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

function offeredTools(tools: unknown): string[] {
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

/** The prompt the spec sends the leaf's coordinator to launch a delegated worker. */
export function launchPrompt(input: Record<string, unknown>): string {
  return `${LAUNCH_MARKER} ${JSON.stringify(input)}\nLaunch one delegated worker with exactly this launch_environment input.`;
}

function launchInput(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf(LAUNCH_MARKER);
  if (start < 0) return undefined;
  const line = text
    .slice(start + LAUNCH_MARKER.length)
    .split("\n")[0]!
    .trim();
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What a `launch_environment` result said, as facts: never its text beyond an error line. */
export interface LaunchOutcome {
  status?: string;
  environmentId: boolean;
  error?: string;
  /** The result's top-level keys, when it named no environment: how to read it next time. */
  shape?: string[];
  /** The tool message's structure and the result's opening, when it named no environment. */
  message?: { keys: string[]; content: string; excerpt: string };
}

function messageStructure(message: ChatMessage | undefined, text: string) {
  const content = message?.content;
  return {
    keys: message ? Object.keys(message).slice(0, 20) : [],
    content: Array.isArray(content)
      ? `array:${content.map((part) => (part as { type?: unknown })?.type ?? typeof part).join(",")}`
      : typeof content,
    excerpt: text.slice(0, 300),
  };
}

/**
 * Reads the result whether Pi hands it over as the tool's JSON, as an MCP
 * content envelope, or with its JSON escaped inside another string.
 */
export function launchOutcome(result: string): LaunchOutcome {
  const field = (name: string) =>
    new RegExp(`\\\\*"${name}\\\\*"\\s*:\\s*\\\\*"((?:[^"\\\\]|\\\\.){0,300}?)\\\\*"`).exec(
      result,
    )?.[1];
  const status = field("status");
  const environmentId = field("environmentId") !== undefined;
  const error = field("error") ?? (result.includes("{") ? undefined : result.trim() || undefined);
  let shape: string[] | undefined;
  if (!environmentId) {
    try {
      const value = JSON.parse(result) as unknown;
      if (value && typeof value === "object") shape = Object.keys(value).slice(0, 20);
    } catch {
      shape = undefined;
    }
  }
  return {
    ...(status ? { status } : {}),
    environmentId,
    ...(error ? { error: error.slice(0, 300) } : {}),
    ...(shape ? { shape } : {}),
  };
}

export interface PiTurn {
  step: PiStep;
  /** Usage-limit notices this request's prompt carried; set on a turn's first request only. */
  notices: NoticeFacts[];
  /** The launch's result, on the request that follows it. */
  launched?: LaunchOutcome;
}

/** The next step of a request from the leaf's Pi coordinator. */
export function piTurn(request: { messages: unknown; tools?: unknown }): PiTurn {
  const list = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : [];
  let lastUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const prompt = chatText(list[lastUser]);
  const toolResults =
    lastUser < 0 ? [] : list.slice(lastUser + 1).filter((m) => m?.role === "tool");
  const firstRequest = toolResults.length === 0;
  const notices = firstRequest ? noticeFacts(prompt) : [];
  const input = launchInput(prompt);
  if (!input) return { step: { kind: "text", text: PI_REPLY }, notices };
  if (!firstRequest) {
    return {
      step: { kind: "text", text: PI_LAUNCHED_REPLY },
      notices,
      launched: (() => {
        const text = chatText(toolResults.at(-1));
        const outcome = launchOutcome(text);
        return outcome.environmentId
          ? outcome
          : { ...outcome, message: messageStructure(toolResults.at(-1), text) };
      })(),
    };
  }
  const name = offeredName(offeredTools(request.tools), "launch_environment");
  return name
    ? { step: { kind: "tool", name, input }, notices }
    : { step: { kind: "text", text: "The launch_environment tool is not offered." }, notices };
}

// --- Usage ---

/** The Claude OAuth usage reading of a fixture account. */
export function claudeUsage(account: FixtureAccount, now: number): Record<string, unknown> {
  const { email, resetDays } = FIXTURE_ACCOUNTS[account];
  const weekly = LIMITED_EMAILS.has(email) ? 50 : 10;
  return {
    five_hour: { utilization: 1, resets_at: new Date(now + 5 * 3_600_000).toISOString() },
    seven_day: {
      utilization: weekly,
      resets_at: new Date(now + resetDays * 24 * 3_600_000).toISOString(),
    },
  };
}
