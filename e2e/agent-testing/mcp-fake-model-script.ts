/**
 * The script of the MCP qualification fake model (`mcp-fake-model.ts`, todo
 * 0039 tasks 5, 6, 7 and 13): what a compliant model does with each prompt
 * the MCP specs send. Pure, so the rules have unit tests that need no
 * provider.
 *
 * The fake calls a requested MCP tool whenever the runtime offers it, and
 * answers "unavailable" otherwise. So a probe through it tests what the
 * runtime offered and what the server logged, never a model's judgement:
 * that is the point of a fake-model run, and also its limit (it says nothing
 * about whether a real model would look).
 */
import { PROBE_UNAVAILABLE } from "./mcp-apply-live-support";

/** One tool result the request carries back since its prompt. */
export interface ToolResult {
  /** The called tool's name, when the protocol carries it back. */
  name?: string;
  text: string;
  isError?: boolean;
}

export interface FakeRequest {
  /** The user prompt this request answers (reminders removed). */
  prompt: string;
  /** Every tool name the request offers, flattened. */
  tools: readonly string[];
  /** Tool results since that prompt, oldest first. */
  results: readonly ToolResult[];
  /**
   * Codex code mode: MCP tools are not offered directly but reachable from a
   * JavaScript cell (`tools.<name>`, listed in `ALL_TOOLS`).
   */
  codeMode?: boolean;
  /**
   * Claude only: whether the CLI told the model plan mode is active for this
   * prompt (its "Plan mode is active" reminder beside the prompt). Lets the
   * warm-runtime spec see that a plan-mode toggle reached the running CLI.
   */
  planMode?: boolean;
}

export type FakeStep =
  | { kind: "text"; text: string; delayMs?: number }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "shell"; command: string }
  /** Claude's file write tool (`Write`), for the warm-runtime spec. */
  | { kind: "write"; filePath: string; content: string }
  /** A Codex code cell (JavaScript source for its `exec` tool). */
  | { kind: "code"; source: string };

/** What the code cell prints when `ALL_TOOLS` does not list the tool. */
export const CODE_NO_TOOL = "MCPQ-NO-TOOL";

/** How long the inactive spec's "busy" turn is held, so a save lands mid-turn. */
export const BUSY_TEXT_DELAY_MS = 30_000;

/** Claude's deferred-tool loader; offered instead of MCP tools when tool search is on. */
const TOOL_SEARCH = "ToolSearch";

interface ToolPrompt {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  /** The reply a successful call yields, read from the tool's output. */
  success: RegExp;
  failure: string;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The MCP call a prompt asks for, from the wording of the two MCP specs. */
export function toolPrompt(prompt: string): ToolPrompt | undefined {
  // mcp-apply-live.spec.ts (`probePrompt`).
  const live =
    /Call the MCP tool named "([^"]+)" that belongs to the MCP server named "([^"]+)", exactly once, with the argument nonce set to "([^"]+)"/.exec(
      prompt,
    );
  if (live) {
    const [, tool, server, nonce] = live as unknown as [string, string, string, string];
    return {
      server,
      tool,
      input: { nonce },
      success: new RegExp(`MCPQ-RESULT \\S+ \\S+ ${escape(nonce)}`),
      failure: PROBE_UNAVAILABLE,
    };
  }
  // mcp-apply-inactive*.spec.ts: a call that must answer.
  const inactive = /Call the MCP tool (\S+) from the (\S+) server exactly once/.exec(prompt);
  if (inactive) {
    const [, tool, server] = inactive as unknown as [string, string, string];
    return {
      server,
      tool,
      input: {},
      success: new RegExp(`pong ${escape(server)} v\\S+ \\S+`),
      failure: "The tool is not available.",
    };
  }
  // mcp-apply-inactive*.spec.ts: a removed tool, with an explicit way out.
  const absent =
    /If a tool named (probe_(\S+?)) is available to you, call it once and reply with exactly its result\. If it is not available, reply with exactly (\S+) and nothing else/.exec(
      prompt,
    );
  if (absent) {
    const [, tool, server, token] = absent as unknown as [string, string, string, string];
    return {
      server,
      tool,
      input: {},
      success: new RegExp(`pong ${escape(server)} v\\S+ \\S+`),
      failure: token,
    };
  }
  return undefined;
}

/**
 * The offered name of an MCP server's tool: Claude and Codex spell it
 * `mcp__<server>__<tool>`, the Pi bridge `mcp_<server>_<tool>`; a namespaced
 * listing flattens to a name ending in `<server>__<tool>`.
 */
export function offeredToolName(
  tools: readonly string[],
  server: string,
  tool: string,
): string | undefined {
  const sanitized = server.replace(/[^a-zA-Z0-9_-]/g, "_");
  const exact = new Set([
    `mcp__${sanitized}__${tool}`,
    `mcp_${sanitized}_${tool}`,
    `${sanitized}__${tool}`,
  ]);
  return (
    tools.find((name) => exact.has(name)) ??
    tools.find((name) => name.endsWith(`__${sanitized}__${tool}`))
  );
}

/**
 * A Codex code cell that calls an MCP tool when `ALL_TOOLS` lists it, the way
 * Codex's own `exec` description says to find a nested tool, and prints
 * `CODE_NO_TOOL` otherwise. Names are JavaScript identifiers there.
 */
export function codeCell(server: string, tool: string, input: Record<string, unknown>): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_$]/g, "_");
  return [
    `const found = ALL_TOOLS.find((tool) => tool.name === ${JSON.stringify(name)});`,
    `if (!found) { text(${JSON.stringify(CODE_NO_TOOL)}); exit(); }`,
    `text(JSON.stringify(await tools[found.name](${JSON.stringify(input)})));`,
  ].join("\n");
}

/** What a plain prompt asks to be answered with. */
export function plainReply(prompt: string): FakeStep {
  const busy =
    /Write every whole number from 1 to \d+ in words[\s\S]*?write exactly the text (\S+) and nothing else/i.exec(
      prompt,
    );
  if (busy) return { kind: "text", text: busy[1]!, delayMs: BUSY_TEXT_DELAY_MS };
  const exact = /reply with exactly ([A-Za-z0-9_-]+)/i.exec(prompt);
  if (exact) return { kind: "text", text: exact[1]! };
  return { kind: "text", text: "Done." };
}

/** The next step of a turn. */
export function scriptedStep(request: FakeRequest): FakeStep {
  const wanted = toolPrompt(request.prompt);
  if (wanted) {
    const called = request.results.filter((result) => result.name !== TOOL_SEARCH);
    if (called.length > 0) {
      const match = called
        .filter((result) => !result.isError)
        .map((result) => wanted.success.exec(result.text)?.[0])
        .find(Boolean);
      return { kind: "text", text: match ?? wanted.failure };
    }
    const name = offeredToolName(request.tools, wanted.server, wanted.tool);
    if (name) return { kind: "tool", name, input: wanted.input };
    if (request.codeMode) {
      return { kind: "code", source: codeCell(wanted.server, wanted.tool, wanted.input) };
    }
    // Claude with tool search on: load the deferred tool once, then decide.
    if (
      request.tools.includes(TOOL_SEARCH) &&
      !request.results.some((result) => result.name === TOOL_SEARCH)
    ) {
      return {
        kind: "tool",
        name: TOOL_SEARCH,
        input: { query: `select:mcp__${wanted.server}__${wanted.tool}`, max_results: 5 },
      };
    }
    return { kind: "text", text: wanted.failure };
  }
  // claude-warm-runtime-live.spec.ts: report whether plan mode reached the CLI.
  const planMarker = /Report the plan mode marker (WRM-[A-Za-z0-9-]+)/.exec(request.prompt);
  if (planMarker) {
    return { kind: "text", text: `${planMarker[1]} plan-mode=${request.planMode ? "on" : "off"}` };
  }
  // claude-warm-runtime-live.spec.ts: one file write, then WRITE-DONE.
  const write = /create the file `([^`]+)` containing exactly `([^`]+)`/.exec(request.prompt);
  if (write) {
    return request.results.length > 0
      ? {
          kind: "text",
          text: request.results.some((r) => r.isError) ? "WRITE-FAILED" : "WRITE-DONE",
        }
      : { kind: "write", filePath: write[1]!, content: write[2]! };
  }
  // mcp-apply-live.spec.ts's busy turn: one foreground command, then BUSY-DONE.
  const shell = /run the command `([^`]+)` once, in the foreground/.exec(request.prompt);
  if (shell) {
    return request.results.length > 0
      ? { kind: "text", text: "BUSY-DONE" }
      : { kind: "shell", command: shell[1]! };
  }
  return plainReply(request.prompt);
}
