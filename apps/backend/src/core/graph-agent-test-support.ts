/**
 * A world for graph agent executor tests (item 204): a temporary store, the
 * real workflow result service and agent tools server (so agents call their
 * per-port and activation tools over MCP, as a bridge's agent would), a fake
 * provider whose "agent" follows a script per turn, and backend "processes"
 * (a run service with the agent executor installed) that a test can start,
 * crash and restart over the same store and provider. The provider outlives
 * the processes, as an environment outlives the backend. Test-only.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import type { GraphRun, GraphRunBindings } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { ProviderSessionFailedError, type ProviderSendOptions } from "./agent-provider-contract.js";
import { AgentToolsServer } from "./agent-tools.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { GraphArtifactStore } from "./graph-artifacts.js";
import { installGraphAgentExecutor, type GraphAgentWiring } from "./graph-agent-wiring.js";
import { compiledPlan } from "./graph-run-executor-test-support.js";
import { GraphRunService } from "./graph-run-service.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

export const AGENT_TEST_COMMIT = "c".repeat(40);
export const AGENT_TEST_BASE_COMMIT = "b".repeat(40);

/** The tool calls an agent can make on its turn's connection. */
export interface FakeAgentTools {
  list(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface FakeAgentTurn {
  sessionId: string;
  requestId: string;
  prompt: string;
  options: ProviderSendOptions;
  /** 1-based turn number in its session. */
  index: number;
  /** The activation's session key the session was created with. */
  sessionKey: string;
}

/** What the turn leaves behind when it ends. */
export type FakeTurnEnd =
  | "idle"
  /** A provider restart cut the turn short (`interruption: "restart"`). */
  | "restart"
  /** The session failed for a real reason. */
  | "error";

export type FakeAgentScript = (
  turn: FakeAgentTurn,
  tools: FakeAgentTools,
  provider: FakeAgentProvider,
) => Promise<FakeTurnEnd>;

interface FakeSession {
  id: string;
  key: string;
  status: "idle" | "running" | "error";
  interruptedRequestId?: string;
  turns: FakeAgentTurn[];
  /** Status reads a running turn answers before its script runs. */
  runningPolls: number;
  structured: Map<string, StructuredOutputResult<unknown>>;
  aborted: number;
  createOptions: Record<string, unknown>;
}

type RpcBody = { result?: Record<string, unknown> & { tools?: Array<{ name: string }> } };

async function rpc(
  url: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<RpcBody> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      ...(params ? { params } : {}),
    }),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`MCP ${method} answered ${response.status}`);
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? (text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length) ?? "{}")
    : text;
  return JSON.parse(payload) as RpcBody;
}

/** An MCP client for a turn's `agentMcp` connection. */
export function fakeAgentTools(connection: { url: string; token: string }): FakeAgentTools {
  return {
    list: async () =>
      ((await rpc(connection.url, connection.token, "tools/list")).result?.tools ?? []).map(
        (tool) => tool.name,
      ),
    call: async (name, args) =>
      ((await rpc(connection.url, connection.token, "tools/call", { name, arguments: args }))
        .result ?? {}) as Record<string, unknown>,
  };
}

/** The structured content of a tool result. */
export function toolContent(result: Record<string, unknown>): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

/**
 * A provider whose agent runs `script` on every turn, after `runningPolls`
 * status reads. Its dispatch journal is complete (it proves absence) unless
 * `provesAbsence` is false. Every invariant a test checks is recorded:
 * deliveries, duplicates, sends made without a durable `dispatching`.
 */
export class FakeAgentProvider {
  readonly sessions = new Map<string, FakeSession>();
  readonly byKey = new Map<string, string>();
  /** Request id → what the provider's journal holds. */
  readonly journal = new Map<string, "dispatched" | "lost">();
  readonly deliveries: string[] = [];
  duplicateDeliveries = 0;
  provesAbsence = true;
  runningPolls = 1;
  /** Called at each send: a test may refuse it or crash there. */
  beforeSend?: (turn: FakeAgentTurn) => Promise<void> | void;
  private readonly pending = new Set<Promise<void>>();
  private counter = 0;

  constructor(
    readonly agent: AgentPlatform,
    public script: FakeAgentScript,
  ) {}

  /** Waits until every running script has finished its turn. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending);
  }

  session(id: string): FakeSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`no session ${id}`);
    return session;
  }

  turns(): FakeAgentTurn[] {
    return [...this.sessions.values()].flatMap((session) => session.turns);
  }

  /** Called at each status read: a test may crash there. */
  beforeObserve?: (sessionId: string) => Promise<void> | void;

  /**
   * The provider surface the runner reads. `alive` false (the process that
   * holds this instance died) makes every call hang, as a dead backend's
   * calls never return.
   */
  asProvider(alive: () => boolean = () => true): BuildPipelineProvider {
    const gate = async () => {
      if (!alive()) await new Promise(() => {});
    };
    return {
      agent: this.agent,
      createSession: async (
        _phase: string,
        _label: string,
        options: Record<string, unknown> = {},
      ) => {
        await gate();
        const key = String(options.clientSessionKey ?? `anonymous-${++this.counter}`);
        const existing = this.byKey.get(key);
        if (existing) return existing;
        const id = `session-${++this.counter}`;
        this.byKey.set(key, id);
        this.sessions.set(id, {
          id,
          key,
          status: "idle",
          turns: [],
          runningPolls: 0,
          structured: new Map(),
          aborted: 0,
          createOptions: { ...options },
        });
        return id;
      },
      registerSession: () => {},
      send: async (sessionId: string, prompt: string, options: ProviderSendOptions) => {
        await gate();
        const session = this.session(sessionId);
        const turn: FakeAgentTurn = {
          sessionId,
          requestId: options.requestId,
          prompt,
          options,
          index: session.turns.length + 1,
          sessionKey: session.key,
        };
        await this.beforeSend?.(turn);
        if (this.journal.has(options.requestId)) {
          this.duplicateDeliveries += 1;
          return;
        }
        this.deliver(session, turn);
      },
      observeSession: async (sessionId: string) => {
        await gate();
        await this.beforeObserve?.(sessionId);
        await gate();
        const session = this.session(sessionId);
        if (session.status === "running" && session.runningPolls > 0) {
          session.runningPolls -= 1;
          return { status: "running" as const };
        }
        if (session.status === "error") {
          return {
            status: "error" as const,
            ...(session.interruptedRequestId
              ? {
                  interruption: "restart" as const,
                  interruptedRequestId: session.interruptedRequestId,
                }
              : {}),
          };
        }
        return { status: session.status };
      },
      status: async (sessionId: string) => {
        return this.session(sessionId).status;
      },
      dispatchStatus: async (_sessionId: string, requestId: string) => {
        await gate();
        const known = this.journal.get(requestId);
        if (known) return known;
        return this.provesAbsence ? ("absent" as const) : ("unknown" as const);
      },
      structured: async (sessionId: string, requestId: string) => {
        return this.session(sessionId).structured.get(requestId) ?? null;
      },
      messages: async () => {
        return [];
      },
      abort: async (sessionId: string) => {
        await gate();
        const session = this.sessions.get(sessionId);
        if (session) {
          session.aborted += 1;
          session.status = "idle";
        }
      },
    } as unknown as BuildPipelineProvider;
  }

  /** The provider received a turn: it runs once, whatever arrives later under its id. */
  deliver(session: FakeSession, turn: FakeAgentTurn): void {
    this.journal.set(turn.requestId, "dispatched");
    this.deliveries.push(turn.requestId);
    session.turns.push(turn);
    session.status = "running";
    delete session.interruptedRequestId;
    session.runningPolls = this.runningPolls;
    const tools = turn.options.agentMcp
      ? fakeAgentTools(turn.options.agentMcp)
      : {
          list: async () => [],
          call: async () => {
            throw new Error("This turn has no tool connection");
          },
        };
    const run = (async () => {
      let end: FakeTurnEnd;
      try {
        end = await this.script(turn, tools, this);
      } catch {
        end = "error";
      }
      // A later turn of the same session already took over.
      if (session.turns.at(-1) !== turn) return;
      if (end === "restart") {
        session.status = "error";
        session.interruptedRequestId = turn.requestId;
      } else {
        session.status = end === "error" ? "error" : "idle";
      }
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }
}

/** Fake Git for the environment: a fixed HEAD on `main`, a clean tree. */
export function fakeEnvironmentGit(head = AGENT_TEST_COMMIT) {
  return async (_environmentId: string, args: string[]): Promise<string> => {
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "symbolic-ref") return "main\n";
    if (args[0] === "status") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

/** One backend "process": a run service with the agent executor installed. */
export interface AgentTestProcess {
  service: GraphRunService;
  wiring: GraphAgentWiring;
  alive: boolean;
}

export interface GraphAgentWorld {
  dataDir: string;
  storage: StorageService;
  artifacts: GraphArtifactStore;
  workflowResults: WorkflowResultService;
  agentTools: AgentToolsServer;
  provider: FakeAgentProvider;
  /** Whether tool results are enabled for the provider (false: structured output). */
  toolResults: boolean;
  start(options?: { holdMs?: number }): AgentTestProcess;
  /** Abandons a process mid-flight (its pending calls never finish) and starts another. */
  restart(options?: { holdMs?: number }): AgentTestProcess;
  current(): AgentTestProcess;
  launch(
    template: GraphTemplateV1,
    inputs: Record<string, unknown>,
    roles?: GraphRunBindings["roles"],
  ): Promise<GraphRun>;
  /** Passes (each followed by the provider settling) until `done` or the bound. */
  drive(runId: string, done?: (run: GraphRun) => boolean, maxPasses?: number): Promise<GraphRun>;
  run(runId: string): Promise<GraphRun>;
  cleanup(): Promise<void>;
}

export async function graphAgentWorld(
  options: { agent?: AgentPlatform; script?: FakeAgentScript; toolResults?: boolean } = {},
): Promise<GraphAgentWorld> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-agent-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment(graphEnvironmentFixture({ worktreePath: dataDir }));
  const artifacts = new GraphArtifactStore({
    storage,
    fence: { beginMutation: () => () => undefined },
  });
  const workflowResults = new WorkflowResultService(dataDir);
  const agentTools = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
  await agentTools.start();
  const provider = new FakeAgentProvider(
    options.agent ?? "claude",
    options.script ?? (async () => "idle"),
  );
  const processes: AgentTestProcess[] = [];
  const world: GraphAgentWorld = {
    dataDir,
    storage,
    artifacts,
    workflowResults,
    agentTools,
    provider,
    toolResults: options.toolResults ?? true,
    start(startOptions = {}) {
      const process: AgentTestProcess = {
        service: undefined as never,
        wiring: undefined as never,
        alive: true,
      };
      // A dead process writes nothing more: its run-store calls hang.
      const graphRuns = new Proxy(storage.graphRuns, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (!process.alive) await new Promise(() => {});
            const result = await (value as (...inner: unknown[]) => unknown).apply(target, args);
            if (!process.alive) await new Promise(() => {});
            return result;
          };
        },
      });
      const service = new GraphRunService(
        { graphRuns },
        {
          artifacts,
          autoAdvance: false,
          observationIntervalMs: 0,
          progressIntervalMs: 0,
        },
      );
      // Driven by hand: `init` only marks the workspace locks as known.
      void service.init();
      // Declared before the wiring so its providers can see whether it died.
      process.service = service;
      const wiring = installGraphAgentExecutor({
        graphRuns: service,
        artifacts,
        storage,
        invoke: async () => {
          throw new Error("no commands in tests");
        },
        workflowResults,
        agentTools,
        toolResultsEnabled: () => world.toolResults,
        environmentGit: fakeEnvironmentGit(),
        createProvider: async () => provider.asProvider(() => process.alive),
        askHumanHoldMs: startOptions.holdMs ?? 50,
      });
      process.wiring = wiring;
      processes.push(process);
      return process;
    },
    restart(startOptions = {}) {
      const previous = processes.pop();
      // The old process is dead: its pending calls never finish, and nothing
      // of it is shut down (its locks would wait for them forever).
      if (previous) {
        previous.alive = false;
        previous.wiring.dispose();
      }
      return world.start(startOptions);
    },
    current() {
      const process = processes.at(-1);
      if (!process) throw new Error("no process started");
      return process;
    },
    async launch(template, inputs, roles) {
      const plan: CompiledGraphPlan = compiledPlan(template);
      return world.current().service.create({
        projectId: "p1",
        environmentId: "e1",
        template: { id: template.id, revision: template.revision, digest: plan.templateDigest },
        plan,
        roles:
          roles ??
          Object.fromEntries(
            plan.roles.map((role) => [role.key, { platform: provider.agent, model: "model" }]),
          ),
        inputs,
      });
    },
    async drive(
      runId,
      done = (run) => ["complete", "failed", "cancelled"].includes(run.status),
      maxPasses = 60,
    ) {
      let run = await world.run(runId);
      for (let pass = 0; pass < maxPasses && !done(run); pass++) {
        run = (await world.current().service.advanceNow(runId)) ?? run;
        await provider.settle();
        run = await world.run(runId);
      }
      return run;
    },
    async run(runId) {
      const run = await storage.graphRuns.getGraphRun(runId);
      if (!run) throw new Error(`no run ${runId}`);
      return run;
    },
    async cleanup() {
      await provider.settle().catch(() => undefined);
      for (const process of processes.splice(0)) {
        process.wiring.dispose();
        await process.service.shutdown().catch(() => undefined);
      }
      await agentTools.stop();
      workflowResults.closeStorage();
      storage.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
  return world;
}

/** The ticket run input every test template takes. */
export const TEST_TICKET = {
  title: "Add CSV export",
  kind: "feature",
  description: "Users need to take report data into spreadsheets.",
  criteria: [
    { id: "ac-1", text: "The reports page has an Export CSV button." },
    { id: "ac-2", text: "The CSV has a header row and every visible row." },
  ],
  comments: [{ text: "Match the column order on screen." }],
};

export const TEST_WORKSPACE = { branch: "main", headRef: AGENT_TEST_BASE_COMMIT, baseRef: null };

/**
 * One agent node `describe` that reads a ticket (on demand) and the run's
 * workspace, and writes a PR description and an optional decision.
 */
export function agentTestTemplate(
  overrides: {
    profile?: string;
    askHuman?: boolean;
    workspaceOutput?: boolean;
    promptBuiltIn?: string;
    ticketRender?: string;
  } = {},
): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "agent-test",
    revision: 1,
    name: "Agent test",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [
      { name: "ticket", type: "ticket@1" },
      { name: "target", type: "workspace@1" },
    ],
    outputs: [
      {
        name: "description",
        type: "pr-description@1",
        from: { node: "describe", port: "description" },
      },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "describe",
        kind: "agent",
        role: "worker",
        capabilities: { profile: (overrides.profile ?? "reviewer") as "reviewer" },
        workspaceAccess: overrides.profile === "builder" ? "write" : "read",
        prompt: overrides.promptBuiltIn
          ? { builtIn: overrides.promptBuiltIn }
          : { template: "Describe the change.\n\n{{> input.ticket}}\n\n{{> input.code}}\n" },
        ...(overrides.askHuman ? { askHuman: true } : {}),
        inputs: [
          {
            name: "ticket",
            type: "ticket@1",
            render: (overrides.ticketRender ?? "on-demand") as "on-demand",
          },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "description", type: "pr-description@1" },
          { name: "decision", type: "decision@1", choices: ["ship", "hold"], required: false },
          ...(overrides.workspaceOutput ? [{ name: "code", type: "workspace@1" }] : []),
        ],
      },
    ],
    edges: [
      { id: "ticket", from: { input: "ticket" }, to: { node: "describe", port: "ticket" } },
      { id: "code", from: { input: "target" }, to: { node: "describe", port: "code" } },
    ],
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 2 },
  } as GraphTemplateV1;
}

export const TEST_DESCRIPTION = {
  title: "Add CSV export to the reports page",
  body: "## Summary\n\n- Adds an Export CSV button\n",
};

/** The slots a turn declared: port → result key (from `workflowResultSlots`). */
export function turnSlots(turn: FakeAgentTurn): Record<string, string> {
  const slots = turn.options.workflowResultSlots ?? [];
  return Object.fromEntries(
    slots.map((slot) => [slot.tool.replace(/^submit_/, ""), slot.resultKey]),
  );
}

/** A script that submits the description (and a decision) through its port tools. */
export function submittingScript(
  values: { description?: unknown; decision?: unknown } = { description: TEST_DESCRIPTION },
): FakeAgentScript {
  return async (turn, tools) => {
    const slots = turnSlots(turn);
    if (values.description !== undefined) {
      await tools.call("submit_description", {
        resultKey: slots.description,
        result: values.description,
      });
    }
    if (values.decision !== undefined) {
      await tools.call("submit_decision", { resultKey: slots.decision, result: values.decision });
    }
    return "idle";
  };
}

export { ProviderSessionFailedError };
