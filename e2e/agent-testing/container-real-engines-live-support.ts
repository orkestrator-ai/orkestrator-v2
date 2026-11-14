/**
 * Pure helpers of the opt-in real-provider Cursor and Pi container cells
 * (`container-real-engines-live.spec.ts`, to-do 7040 (retired)): the opt-in
 * switches, and reading a shell tool call's outcome from the transcript.
 * Kept free of Playwright so `container-real-engines-live-support.test.ts`
 * covers them without a profile.
 */

/** The switch that runs the real Cursor cell (a Cursor login and a billed turn). */
export const LIVE_CURSOR_SWITCH = "ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_CURSOR";
/** An optional Cursor model id for that cell; the SDK's default otherwise. */
export const LIVE_CURSOR_MODEL = "ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_CURSOR_MODEL";
/** The Pi `provider/modelId` the real Pi cell runs on; unset skips it. */
export const LIVE_PI_MODEL = "ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_PI_MODEL";
/** How long one real turn may take, in milliseconds. */
export const LIVE_TURN_TIMEOUT = "ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_TURN_TIMEOUT_MS";

const DEFAULT_LIVE_TURN_TIMEOUT_MS = 300_000;

export type LiveContainerCellSettings = {
  cursor: { optedIn: boolean; model?: string };
  /** `problem` is set when the Pi model was given but is not `provider/modelId`. */
  pi: { optedIn: boolean; model?: string; problem?: string };
  turnTimeoutMs: number;
};

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * Pi names a model by provider and id, split on the first slash (an
 * OpenRouter id contains its own), as the Pi bridge's `models.ts` does.
 */
export function piModelProblem(model: string): string | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return `${LIVE_PI_MODEL} must be a Pi provider/modelId, for example anthropic/claude-haiku-5-5`;
  }
  return undefined;
}

export function liveContainerCellSettings(
  env: Readonly<Record<string, string | undefined>>,
): LiveContainerCellSettings {
  const piModel = trimmed(env[LIVE_PI_MODEL]);
  const timeout = Number(trimmed(env[LIVE_TURN_TIMEOUT]) ?? DEFAULT_LIVE_TURN_TIMEOUT_MS);
  const cursorModel = trimmed(env[LIVE_CURSOR_MODEL]);
  const problem = piModel ? piModelProblem(piModel) : undefined;
  return {
    cursor: {
      optedIn: env[LIVE_CURSOR_SWITCH] === "1",
      ...(cursorModel ? { model: cursorModel } : {}),
    },
    pi: {
      optedIn: piModel !== undefined,
      ...(piModel ? { model: piModel } : {}),
      ...(problem ? { problem } : {}),
    },
    turnTimeoutMs:
      Number.isFinite(timeout) && timeout >= 30_000 ? timeout : DEFAULT_LIVE_TURN_TIMEOUT_MS,
  };
}

export type ShellToolCall = {
  toolName: string;
  command: string;
  /** The card's output and error text together: a failing command has both. */
  output: string;
  state?: string;
};

const MAX_TOOL_PARTS = 200;
const MAX_TOOL_DEPTH = 8;

/**
 * Every tool card in `messages` whose tool is one of `toolNames`, including
 * cards nested under a sub-agent or a group. Bounded in depth and count.
 */
export function shellToolCalls(
  messages: ReadonlyArray<{ parts?: unknown }>,
  toolNames: readonly string[],
): ShellToolCall[] {
  const calls: ShellToolCall[] = [];
  let seen = 0;
  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_TOOL_DEPTH || seen >= MAX_TOOL_PARTS) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.toolName === "string") {
      seen += 1;
      if (toolNames.includes(record.toolName)) {
        const args =
          record.toolArgs && typeof record.toolArgs === "object"
            ? (record.toolArgs as Record<string, unknown>)
            : {};
        const command =
          typeof args.command === "string"
            ? args.command
            : typeof record.toolTitle === "string"
              ? record.toolTitle
              : "";
        const output = [record.toolOutput, record.toolError]
          .filter((text): text is string => typeof text === "string" && text.length > 0)
          .join("\n");
        calls.push({
          toolName: record.toolName,
          command,
          output,
          ...(typeof record.toolState === "string" ? { state: record.toolState } : {}),
        });
      }
    }
    for (const field of ["childTools", "subagentActions"]) visit(record[field], depth + 1);
  };
  for (const message of messages) visit(message.parts, 0);
  return calls;
}

export type CurlOutcome = { http: string; exit: number };

/** Reads `http=NNN exit=N`, what `curlCommand` prints, from a card's output. */
export function curlOutcome(output: string): CurlOutcome | undefined {
  const http = /http=(\d{3})/.exec(output)?.[1];
  const exit = /exit=(\d+)/.exec(output)?.[1];
  if (http === undefined || exit === undefined) return undefined;
  return { http, exit: Number(exit) };
}

/** The first shell call that ran `curl` against `url` and printed its outcome. */
export function curlCallFor(
  calls: readonly ShellToolCall[],
  url: string,
): (ShellToolCall & { outcome: CurlOutcome }) | undefined {
  for (const call of calls) {
    if (!call.command.includes(url)) continue;
    const outcome = curlOutcome(call.output);
    if (outcome) return { ...call, outcome };
  }
  return undefined;
}

/** Refused off the allowlist: no HTTP status and a failing curl. */
export function isRefused(outcome: CurlOutcome): boolean {
  return outcome.http === "000" && outcome.exit !== 0;
}

/** Answered: an HTTP status and a successful curl. */
export function isReached(outcome: CurlOutcome): boolean {
  return /^[1-5]\d\d$/.test(outcome.http) && outcome.exit === 0;
}

/** The instruction a real model gets: run exactly this, once, in its shell tool. */
export function shellToolPrompt(tool: string, command: string): string {
  return [
    `Use your ${tool} tool to run this exact command once, without changing it:`,
    command,
    "Then reply with the command's output and nothing else.",
  ].join("\n");
}
