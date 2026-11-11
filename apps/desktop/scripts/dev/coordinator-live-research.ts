import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  DEFAULT_COORDINATOR_RESEARCH_MCP_SERVERS,
  DEFAULT_COORDINATOR_WEB_RESEARCH,
  type CoordinatorResearchMcpServer,
} from "@orkestrator/protocol/coordinator-web-research";
import {
  escapedInteractionFailures,
  normalizeToolState,
  transcriptAssistantText,
  type CoordinatorLiveCheck,
  type CoordinatorTranscriptMessage,
  type ToolCallState,
} from "./coordinator-live.js";

/**
 * The live coordinator suite's `research` scenario (to-do 0026 task 3, retired;
 * see `docs/architecture/coordinator-read-only-decisions.md`).
 *
 * One coordinator turn under the product's default research setting asks for
 * React's Context7 library ID through the research server. A model can answer
 * that from memory, so the answer proves nothing: the evidence is a tool row in
 * the transcript attributed to the research server, which is what shows the
 * platform's exact-name allowlist admits the server's tools. Each platform
 * names a research tool its own way, listed in {@link RESEARCH_TOOL_NAMING}.
 *
 * Shared by the Node Playwright spec and the Bun tests, so nothing here may
 * use Bun APIs.
 */

export const RESEARCH_REPORT_MARKER = "COORDINATOR_LIVE_RESEARCH";

/**
 * The settings the case runs under: the shipped defaults, written explicitly
 * so a profile whose settings were changed still runs what a new install gets.
 */
export const RESEARCH_SCENARIO_SETTINGS = Object.freeze({
  coordinatorWebResearch: DEFAULT_COORDINATOR_WEB_RESEARCH,
  coordinatorResearchMcpServers: DEFAULT_COORDINATOR_RESEARCH_MCP_SERVERS.map((server) => ({
    ...server,
  })),
});

/** The research server the prompt names: the first default one (Context7). */
export const RESEARCH_SCENARIO_SERVER: CoordinatorResearchMcpServer =
  DEFAULT_COORDINATOR_RESEARCH_MCP_SERVERS[0]!;

/**
 * Where a platform's transcript row says which research server answered.
 * `field` is the tool part field read, and `prefix` what it starts with for a
 * tool of `server`. A `Record` over every platform, so a new platform fails the
 * typecheck until someone says how its research calls are attributed.
 */
export type ResearchToolNaming =
  | {
      field: "name" | "title";
      prefix: (server: string) => string;
      /** Where the name comes from, for a failure message. */
      source: string;
    }
  | { unavailable: string };

export const RESEARCH_TOOL_NAMING: Readonly<Record<AgentPlatform, ResearchToolNaming>> =
  Object.freeze({
    // The SDK's own name for an inline MCP server's tool.
    claude: {
      field: "name",
      prefix: (server: string) => `mcp__${server}__`,
      source: "the SDK's mcp__<server>__<tool> name",
    },
    // `mcpToolCallParts`: the item's bare tool name, titled `<server>:<tool>`.
    codex: {
      field: "title",
      prefix: (server: string) => `${server}:`,
      source: "the mcp_tool_call row's <server>:<tool> title",
    },
    // `hostResearchCustomTools`, unwrapped from the SDK's carrier by `renderMcp`.
    cursor: {
      field: "name",
      prefix: (server: string) => `mcp__${server}__`,
      source: "the hosted tool's mcp__<server>__<tool> name",
    },
    // `prefixedToolName` in the Pi bridge's `mcp.ts`.
    pi: {
      field: "name",
      prefix: (server: string) => `mcp_${server}_`,
      source: "the bridge's mcp_<server>_<tool> registration",
    },
    // `openCodeResearchToolIds`: OpenCode's `<server>_<tool>` tool id.
    opencode: {
      field: "name",
      prefix: (server: string) => `${server}_`,
      source: "OpenCode's <server>_<tool> tool id",
    },
    // `acp-policy.ts`: research mode is not honoured on the pinned build.
    grok: {
      unavailable:
        "Grok coordinators load no research servers: web search stays off because its open_page cannot be removed on its own, and no research MCP server is attached (D8 in coordinator-read-only-decisions.md)",
    },
  });

/** Whether the scenario applies, or why it does not. */
export function researchApplies(
  platform: AgentPlatform,
): { applies: true } | { applies: false; reason: string } {
  const naming = RESEARCH_TOOL_NAMING[platform];
  return "unavailable" in naming
    ? { applies: false, reason: naming.unavailable }
    : { applies: true };
}

export function researchScenarioPrompt(server: string = RESEARCH_SCENARIO_SERVER.name): string {
  return [
    "This is Orkestrator's research conformance check, run by its test harness on a disposable fixture checkout. The user authorises and asks for every step below.",
    `Use the ${server} research MCP server's own tool to resolve the ${server} library ID for the React library (React, the JavaScript UI library). Call the tool even if you believe you know the ID: the check is that the call works, and an answer from memory fails it. If the first call does not settle it, one more call to the same server is fine.`,
    "Do not use web search or any fetch tool, do not read or change files, do not launch environments, jobs or workers, and do not ask the user anything.",
    "",
    "Finish with exactly one line in this format, and nothing after it:",
    `${RESEARCH_REPORT_MARKER} {"libraryId":"<the library ID the tool returned>","called":<true if you called the ${server} tool in this turn, else false>}`,
    "Use an empty string for libraryId if no tool call returned one.",
  ].join("\n");
}

export interface ResearchReport {
  libraryId: string;
  called: boolean;
}

/**
 * The last report line in the agent's final text, or why there is none. Only
 * the last marker counts, so a model quoting the instruction is not misread.
 */
export function parseResearchReport(text: string): ResearchReport | { error: string } {
  const raw = [
    ...text.matchAll(new RegExp(`${RESEARCH_REPORT_MARKER}\\s*(\\{[^\\n]*\\})`, "g")),
  ].at(-1)?.[1];
  if (!raw) return { error: `the final answer has no ${RESEARCH_REPORT_MARKER} line` };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: `the ${RESEARCH_REPORT_MARKER} line is not valid JSON` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: `the ${RESEARCH_REPORT_MARKER} value is not an object` };
  }
  const record = value as Record<string, unknown>;
  return {
    libraryId: typeof record.libraryId === "string" ? record.libraryId.trim() : "",
    called: record.called === true,
  };
}

/** A Context7 library ID: `/org/project`, optionally with a version segment. */
const LIBRARY_ID = /^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;

export function isLibraryId(value: string): boolean {
  return LIBRARY_ID.test(value);
}

/** One tool row as the research verdict reads it: no arguments, no output. */
export interface ResearchToolCall {
  name: string;
  title?: string;
  state: ToolCallState;
  /** The research server the row is attributed to, when it is. */
  server?: string;
}

const MAX_TOOL_CALLS = 200;
const MAX_TOOL_DEPTH = 8;

/**
 * Every tool row in a transcript, including sub-agent and grouped tools,
 * with the research server each is attributed to under the platform's naming.
 */
export function researchToolCalls(
  platform: AgentPlatform,
  messages: readonly CoordinatorTranscriptMessage[],
  servers: readonly CoordinatorResearchMcpServer[],
): ResearchToolCall[] {
  const naming = RESEARCH_TOOL_NAMING[platform];
  const calls: ResearchToolCall[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_TOOL_DEPTH || calls.length >= MAX_TOOL_CALLS) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.toolName === "string") {
      const name = record.toolName.slice(0, 120);
      const title =
        typeof record.toolTitle === "string" ? record.toolTitle.slice(0, 160) : undefined;
      const attributed =
        "unavailable" in naming
          ? undefined
          : servers.find((server) => {
              const value = naming.field === "name" ? name : title;
              const prefix = naming.prefix(server.name);
              // A bare prefix names no tool.
              return (
                value !== undefined && value.startsWith(prefix) && value.length > prefix.length
              );
            });
      calls.push({
        name,
        ...(title !== undefined ? { title } : {}),
        state: normalizeToolState(record.toolState),
        ...(attributed ? { server: attributed.name } : {}),
      });
    }
    for (const field of ["childTools", "subagentActions"]) visit(record[field], depth + 1);
  };
  for (const message of messages) visit(message.parts, 0);
  return calls;
}

/**
 * A page fetch is never allowed to a coordinator, research setting or not.
 * Matched on the tool name with case, `_` and `-` ignored (`WebFetch`,
 * `webfetch`, `web_fetch`, `webFetch`). Codex's hosted page opens are held by
 * the bridge's `web_search = "cached"` lock and have no row of their own.
 */
function isPageFetch(name: string): boolean {
  return name.toLowerCase().replace(/[-_]/g, "").endsWith("webfetch");
}

/**
 * The scenario's verdict, judged from the transcript rows and the checkout,
 * never from the model's wording alone.
 */
export function evaluateResearchScenario(input: {
  platform: AgentPlatform;
  messages: readonly CoordinatorTranscriptMessage[];
  servers: readonly CoordinatorResearchMcpServer[];
  turnPhase: string;
  turnError?: string;
  checkoutChanges: readonly string[];
  escapedInteractions: readonly AgentInteractionKind[];
}): {
  checks: CoordinatorLiveCheck[];
  calls: ResearchToolCall[];
  observed: Record<string, number>;
} {
  const naming = RESEARCH_TOOL_NAMING[input.platform];
  const calls = researchToolCalls(input.platform, input.messages, input.servers);
  const research = calls.filter((call) => call.server !== undefined);
  const succeeded = research.filter((call) => call.state === "succeeded");
  const fetches = calls.filter((call) => isPageFetch(call.name) && call.state === "succeeded");
  const report = parseResearchReport(transcriptAssistantText(input.messages));
  const serverNames = input.servers.map((server) => server.name).join(", ") || "(none)";
  const source = "unavailable" in naming ? naming.unavailable : naming.source;
  const escaped = escapedInteractionFailures(input.escapedInteractions);
  const checks: CoordinatorLiveCheck[] = [
    {
      name: "turn-finished",
      passed: input.turnPhase !== "error",
      ...(input.turnPhase === "error"
        ? { detail: (input.turnError ?? "no error text").slice(0, 300) }
        : {}),
    },
    {
      name: "research-call",
      passed: research.length > 0,
      ...(research.length === 0
        ? {
            detail: `no tool row is attributed to a research server (${serverNames}) by ${source}; rows: ${
              calls
                .map((call) => call.name)
                .slice(0, 20)
                .join(", ") || "none"
            }`,
          }
        : {}),
    },
    {
      name: "research-call-succeeded",
      passed: succeeded.length > 0,
      ...(succeeded.length === 0 && research.length > 0
        ? {
            detail: `research rows ended ${research.map((call) => `${call.name}=${call.state}`).join(", ")}`,
          }
        : {}),
    },
    {
      name: "library-id-reported",
      passed: !("error" in report) && isLibraryId(report.libraryId),
      ...("error" in report
        ? { detail: report.error }
        : !isLibraryId(report.libraryId)
          ? { detail: "the reported libraryId is not a /org/project ID" }
          : {}),
    },
    {
      name: "no-page-fetch",
      passed: fetches.length === 0,
      ...(fetches.length > 0
        ? { detail: `page fetches completed: ${fetches.map((call) => call.name).join(", ")}` }
        : {}),
    },
    {
      name: "checkout-unchanged",
      passed: input.checkoutChanges.length === 0,
      ...(input.checkoutChanges.length > 0
        ? { detail: input.checkoutChanges.slice(0, 10).join(", ") }
        : {}),
    },
    {
      name: "no-escaped-interactions",
      passed: escaped.length === 0,
      ...(escaped.length > 0 ? { detail: escaped.join("; ") } : {}),
    },
  ];
  return {
    checks,
    calls,
    observed: {
      toolCalls: calls.length,
      researchCalls: research.length,
      researchCallsSucceeded: succeeded.length,
      reportedCalled: !("error" in report) && report.called ? 1 : 0,
    },
  };
}
