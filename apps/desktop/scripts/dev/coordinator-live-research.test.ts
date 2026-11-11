import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  DEFAULT_COORDINATOR_RESEARCH_MCP_SERVERS,
  DEFAULT_COORDINATOR_WEB_RESEARCH,
} from "@orkestrator/protocol/coordinator-web-research";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import {
  evaluateResearchScenario,
  isLibraryId,
  parseResearchReport,
  RESEARCH_REPORT_MARKER,
  RESEARCH_SCENARIO_SETTINGS,
  RESEARCH_TOOL_NAMING,
  researchApplies,
  researchScenarioPrompt,
  researchToolCalls,
} from "./coordinator-live-research.js";
import { runResearchScenario } from "./coordinator-live-research-orchestration.js";

const servers = [{ name: "context7", url: "https://mcp.context7.com/mcp" }];

/** How each platform's transcript shows a call to Context7's resolve tool. */
const RESOLVE_ROW: Record<
  Exclude<AgentPlatform, "grok">,
  { toolName: string; toolTitle?: string }
> = {
  claude: { toolName: "mcp__context7__resolve-library-id" },
  codex: { toolName: "resolve-library-id", toolTitle: "context7:resolve-library-id" },
  cursor: {
    toolName: "mcp__context7__resolve-library-id",
    toolTitle: "context7: resolve-library-id",
  },
  pi: { toolName: "mcp_context7_resolve-library-id" },
  opencode: { toolName: "context7_resolve-library-id" },
};

function assistant(
  parts: Array<Record<string, unknown>>,
  text?: string,
): CoordinatorTranscriptMessage {
  return {
    role: "assistant",
    parts: [...parts, ...(text ? [{ type: "text", content: text }] : [])],
  };
}

const failed = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((check) => !check.passed).map((check) => check.name);

const REPORT = `${RESEARCH_REPORT_MARKER} {"libraryId":"/facebook/react","called":true}`;

describe("research scenario", () => {
  test("runs under the shipped default research setting and names the first default server", () => {
    expect(RESEARCH_SCENARIO_SETTINGS.coordinatorWebResearch).toBe(
      DEFAULT_COORDINATOR_WEB_RESEARCH,
    );
    expect(DEFAULT_COORDINATOR_WEB_RESEARCH).toBe("search-and-mcp");
    expect(RESEARCH_SCENARIO_SETTINGS.coordinatorResearchMcpServers).toEqual([
      ...DEFAULT_COORDINATOR_RESEARCH_MCP_SERVERS,
    ]);
    const prompt = researchScenarioPrompt();
    expect(prompt).toContain("context7");
    expect(prompt).toContain("React");
    expect(prompt).toContain(RESEARCH_REPORT_MARKER);
  });

  test("every platform says how its research rows are attributed, and only Grok has none", () => {
    expect(Object.keys(RESEARCH_TOOL_NAMING).toSorted()).toEqual([...AGENT_PLATFORMS].toSorted());
    expect(AGENT_PLATFORMS.filter((platform) => !researchApplies(platform).applies)).toEqual([
      "grok",
    ]);
    const grok = researchApplies("grok");
    expect(grok.applies).toBe(false);
    if (!grok.applies) expect(grok.reason).toContain("no research servers");
  });

  test.each(Object.entries(RESOLVE_ROW))(
    "%s: the resolve row is attributed to the research server",
    (platform, row) => {
      const calls = researchToolCalls(
        platform as AgentPlatform,
        [assistant([{ ...row, toolState: "completed", toolArgs: { libraryName: "react" } }])],
        servers,
      );
      expect(calls).toEqual([
        expect.objectContaining({ name: row.toolName, state: "succeeded", server: "context7" }),
      ]);
    },
  );

  test("a row from another server, an Orkestrator tool or a bare prefix is not attributed", () => {
    const rows = [
      { toolName: "mcp__orkestrator__list_tickets" },
      { toolName: "mcp__context7x__resolve-library-id" },
      { toolName: "mcp__context7__" },
      { toolName: "WebSearch" },
    ];
    const calls = researchToolCalls(
      "claude",
      [assistant(rows.map((row) => ({ ...row, toolState: "completed" })))],
      servers,
    );
    expect(calls.map((call) => call.server)).toEqual([undefined, undefined, undefined, undefined]);
    // Codex is attributed by its title, never by a name that merely looks right.
    expect(
      researchToolCalls(
        "codex",
        [assistant([{ toolName: "mcp__context7__resolve-library-id", toolState: "completed" }])],
        servers,
      )[0]?.server,
    ).toBeUndefined();
    // Grok attributes nothing, whatever the row is called.
    expect(
      researchToolCalls(
        "grok",
        [assistant([{ toolName: "mcp__context7__resolve-library-id", toolState: "completed" }])],
        servers,
      )[0]?.server,
    ).toBeUndefined();
  });

  test("a research row inside a sub-agent's tools still counts", () => {
    const calls = researchToolCalls(
      "claude",
      [
        assistant([
          {
            toolName: "Task",
            toolState: "completed",
            childTools: [{ toolName: "mcp__context7__resolve-library-id", toolState: "completed" }],
          },
        ]),
      ],
      servers,
    );
    expect(calls.filter((call) => call.server === "context7")).toHaveLength(1);
  });

  test("the report: the last marker wins, and the ID must be /org/project", () => {
    expect(
      parseResearchReport(
        `quoting ${RESEARCH_REPORT_MARKER} {"libraryId":"<id>","called":false}\n${REPORT}`,
      ),
    ).toEqual({ libraryId: "/facebook/react", called: true });
    expect(parseResearchReport("no report")).toEqual({
      error: `the final answer has no ${RESEARCH_REPORT_MARKER} line`,
    });
    expect(parseResearchReport(`${RESEARCH_REPORT_MARKER} {libraryId}`)).toEqual({
      error: `the ${RESEARCH_REPORT_MARKER} line is not valid JSON`,
    });
    expect(isLibraryId("/facebook/react")).toBe(true);
    expect(isLibraryId("/websites/react_dev")).toBe(true);
    expect(isLibraryId("/vercel/next.js/v14.3.0")).toBe(true);
    expect(isLibraryId("facebook/react")).toBe(false);
    expect(isLibraryId("")).toBe(false);
    expect(isLibraryId("/react")).toBe(false);
  });

  const base = {
    servers,
    turnPhase: "idle",
    checkoutChanges: [] as string[],
    escapedInteractions: [] as const,
  };

  test("passes on an attributed, successful research row and a well-formed report", () => {
    const { checks, observed } = evaluateResearchScenario({
      ...base,
      platform: "pi",
      messages: [assistant([{ ...RESOLVE_ROW.pi, toolState: "completed" }], REPORT)],
    });
    expect(failed(checks)).toEqual([]);
    expect(observed).toMatchObject({
      researchCalls: 1,
      researchCallsSucceeded: 1,
      reportedCalled: 1,
    });
  });

  test("an answer from memory fails, however right it is", () => {
    const { checks } = evaluateResearchScenario({
      ...base,
      platform: "opencode",
      messages: [assistant([{ toolName: "read", toolState: "completed" }], REPORT)],
    });
    expect(failed(checks)).toEqual(["research-call", "research-call-succeeded"]);
    expect(checks.find((check) => check.name === "research-call")?.detail).toContain(
      "OpenCode's <server>_<tool> tool id",
    );
  });

  test("a refused research call, a page fetch, a changed checkout and an escaped approval each fail", () => {
    const { checks } = evaluateResearchScenario({
      ...base,
      platform: "claude",
      checkoutChanges: ["files +notes.md"],
      escapedInteractions: ["command-approval"],
      messages: [
        assistant(
          [
            { ...RESOLVE_ROW.claude, toolState: "denied" },
            { toolName: "WebFetch", toolState: "completed" },
          ],
          `${RESEARCH_REPORT_MARKER} {"libraryId":"","called":true}`,
        ),
      ],
    });
    expect(failed(checks)).toEqual([
      "research-call-succeeded",
      "library-id-reported",
      "no-page-fetch",
      "checkout-unchanged",
      "no-escaped-interactions",
    ]);
  });

  test("a failed turn fails with its error", () => {
    const { checks } = evaluateResearchScenario({
      ...base,
      platform: "cursor",
      turnPhase: "error",
      turnError: "provider unavailable",
      messages: [assistant([{ ...RESOLVE_ROW.cursor, toolState: "completed" }], REPORT)],
    });
    expect(checks.find((check) => check.name === "turn-finished")).toEqual({
      name: "turn-finished",
      passed: false,
      detail: "provider unavailable",
    });
  });

  test("its budget is one turn", () => {
    const budgets = coordinatorLiveBudgets({});
    expect(budgets.waits.research).toBe(budgets.turn);
  });
});

// ---------------------------------------------------------------------------
// The orchestration over a scripted command transport

// The orchestration cases spawn `git init` and hash the fixture checkout.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureCheckout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-live-research-"));
  roots.push(root);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  const result = spawnSync("git", ["init", "-q", "-b", "main"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.status !== 0) throw new Error(`git init: ${result.stderr}`);
  return root;
}

/**
 * Script only the command transport: the turn settles after the dispatch, a
 * couple of reads later, with whatever rows the script gives it.
 */
function scripted(options: {
  messages: CoordinatorTranscriptMessage[];
  phase?: string;
  error?: string;
  onDispatch?: () => Promise<void>;
  /** Interactions pending while the turn is working, as an escaped approval would be. */
  interactions?: Array<Record<string, unknown>>;
}) {
  const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
  let reads = 0;
  let dispatched = false;
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    sent.push({ command, args });
    if (command === "dispatch_native_agent_intent") {
      dispatched = true;
      await options.onDispatch?.();
      return null as T;
    }
    if (command === "resolve_native_agent_interaction") return null as T;
    if (command === "get_native_agent_projection") {
      reads += 1;
      const working = dispatched && reads <= 2;
      return {
        turn: working
          ? { phase: "working" }
          : {
              phase: dispatched ? (options.phase ?? "idle") : "idle",
              ...(options.error ? { error: options.error } : {}),
            },
        messages: dispatched && !working ? options.messages : [],
        interactions: working ? (options.interactions ?? []) : [],
      } as T;
    }
    throw new Error(`unscripted command ${command}`);
  };
  return { invoke, sent };
}

function summaryFor(platform: AgentPlatform): CoordinatorLivePlatformSummary {
  return {
    version: 1,
    platform,
    scenario: "research",
    verdict: "failed",
    startedAt: new Date().toISOString(),
  };
}

const identity = (agent: AgentPlatform) => ({
  environmentId: "coordinator-env",
  agent,
  logicalSessionKey: "coordinator-main",
});

describe("research scenario orchestration", () => {
  test("one build-mode turn naming the server, judged from its rows; the summary stays content-free", async () => {
    const checkout = await fixtureCheckout();
    const transport = scripted({
      messages: [assistant([{ ...RESOLVE_ROW.codex, toolState: "completed" }], REPORT)],
    });
    const summary = summaryFor("codex");
    const result = await runResearchScenario({
      invoke: transport.invoke,
      identity: identity("codex"),
      checkout,
      summary,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(failed(result.checks)).toEqual([]);
    const dispatches = transport.sent.filter(
      (entry) => entry.command === "dispatch_native_agent_intent",
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.args).toMatchObject({
      environmentId: "coordinator-env",
      agent: "codex",
      mode: "build",
    });
    expect(String(dispatches[0]!.args.prompt)).toContain("context7");
    expect(summary.toolCalls).toEqual([{ name: "resolve-library-id", state: "succeeded" }]);
    expect(summary.tree?.changes).toEqual([]);
    expect(summary.turn).toEqual({ phase: "idle" });
    // Neither the prompt, the report line nor the library ID reaches the summary.
    const recorded = JSON.stringify(summary);
    expect(recorded).not.toContain("/facebook/react");
    expect(recorded).not.toContain(RESEARCH_REPORT_MARKER);
  });

  test("a write into the checkout during the turn fails the case", async () => {
    const checkout = await fixtureCheckout();
    const transport = scripted({
      messages: [assistant([{ ...RESOLVE_ROW.pi, toolState: "completed" }], REPORT)],
      onDispatch: () => writeFile(path.join(checkout, "notes.md"), "written\n"),
    });
    const summary = summaryFor("pi");
    const result = await runResearchScenario({
      invoke: transport.invoke,
      identity: identity("pi"),
      checkout,
      summary,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(failed(result.checks)).toEqual(["checkout-unchanged"]);
    expect(summary.tree?.changes?.join(" ")).toContain("+notes.md");
  });

  test("a turn that answers from memory fails on the missing row", async () => {
    const checkout = await fixtureCheckout();
    const transport = scripted({ messages: [assistant([], REPORT)] });
    const result = await runResearchScenario({
      invoke: transport.invoke,
      identity: identity("claude"),
      checkout,
      summary: summaryFor("claude"),
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(failed(result.checks)).toEqual(["research-call", "research-call-succeeded"]);
  });

  test("an approval that reaches the harness during the turn is denied, recorded and fails the case", async () => {
    const checkout = await fixtureCheckout();
    const transport = scripted({
      messages: [assistant([{ ...RESOLVE_ROW.cursor, toolState: "completed" }], REPORT)],
      interactions: [
        { id: "i-1", kind: "command-approval", state: "pending", createdAt: 1, sessionId: "s" },
      ],
    });
    const summary = summaryFor("cursor");
    const result = await runResearchScenario({
      invoke: transport.invoke,
      identity: identity("cursor"),
      checkout,
      summary,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(failed(result.checks)).toEqual(["no-escaped-interactions"]);
    expect(summary.escapedInteractions).toEqual(["command-approval"]);
    // Denied once on the agent's behalf, never approved.
    const resolutions = transport.sent.filter(
      (entry) => entry.command === "resolve_native_agent_interaction",
    );
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.args).toMatchObject({
      interactionId: "i-1",
      resolution: { action: "deny" },
    });
  });
});
