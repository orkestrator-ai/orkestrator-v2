#!/usr/bin/env bun
/**
 * The real Cursor bridge over a fake Cursor SDK, as a standalone process.
 *
 * Browser specs drive a native Cursor tab through the real backend and this
 * bridge without a credential or a network call. Only the vendor engine is
 * fake: `Agent.create`, `resume`, `list` and `listRuns` answer from a store
 * of conversations this process keeps in `FAKE_CURSOR_STORE`, so a closed
 * conversation stays listed and resumable exactly as long as the store keeps
 * it. Routes, journals, persistence, translation and close are production
 * code. Nothing in the production path knows this file exists.
 *
 * `list` reports each agent under the name it was created with (the bridge
 * always passes `Orkestrator`) and the first prompt as its `summary`.
 *
 * The store is the vendor's truth for assertions: one entry per agent, with
 * every turn it actually ran. A duplicated or lost prompt shows up there, not
 * just in the bridge's own transcript.
 *
 * Prompts:
 * - containing `HOLD`: the run stays open until it is cancelled, then ends
 *   `cancelled`. Lets a spec close a tab in the middle of a turn.
 * - anything else: answered `Answer to: <prompt>` and finished.
 *
 * Cold start: while the file `FAKE_CURSOR_CREATE_GATE` exists, `Agent.create`
 * does not return, standing in for an SDK agent that takes its time to start.
 *
 * Every SDK call on an agent is appended to `FAKE_CURSOR_LOG` as
 * `<event>:<agentId>` (`create`, `resume`, `send`, `steer`, `dispose`), for
 * ordering assertions.
 *
 * Environment: the bridge's own (`PORT`, `HOSTNAME`, `CWD`,
 * `CURSOR_BRIDGE_TOKEN`, `CURSOR_BRIDGE_STATE_DIR`, `CURSOR_BRIDGE_AUTH_FILE`)
 * plus `FAKE_CURSOR_STORE`, `FAKE_CURSOR_LOG` and `FAKE_CURSOR_CREATE_GATE`.
 * `CURSOR_API_KEY` is set here, so the bridge reads as signed in.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

process.env.CURSOR_API_KEY = "fake-engine-no-provider-requests";
// Turns the workspace snapshot probe off: there is nothing to measure.
process.env.NODE_ENV = "test";

const { setCursorMcpFingerprintForTests, useCursorAgentForTests } =
  await import("../agent-session.js");
const { useCursorSdkRuntimeForTests, useCursorLocalAgentStoreForTests } =
  await import("../sdk-runtime.js");
const { useCursorModelsForTests } = await import("../models.js");
const { useCursorCredentialRuntimeForTests } = await import("../credentials.js");
const { resetPlanAccountWindowsForTests } = await import("../plan-usage.js");
const { useCommandChangeProbeForTests } = await import("../command-changes.js");
const { start } = await import("../server.js");

type TurnStatus = "running" | "finished" | "cancelled";
interface StoredTurn {
  runId: string;
  prompt: string;
  reply?: string;
  status: TurnStatus;
  createdAt: number;
}
interface StoredAgent {
  /** The name the bridge created the agent with. */
  name: string;
  createdAt: number;
  turns: StoredTurn[];
}
type Store = { agents: Record<string, StoredAgent> };

const storePath = process.env.FAKE_CURSOR_STORE;
if (!storePath) throw new Error("FAKE_CURSOR_STORE is required");
const logPath = process.env.FAKE_CURSOR_LOG;
const createGate = process.env.FAKE_CURSOR_CREATE_GATE;

function record(event: string, agentId: string): void {
  if (logPath) appendFileSync(logPath, `${event}:${agentId}\n`);
}

async function gateOpen(): Promise<void> {
  while (createGate && existsSync(createGate)) await Bun.sleep(20);
}

function load(): Store {
  if (!existsSync(storePath!)) return { agents: {} };
  return JSON.parse(readFileSync(storePath!, "utf8")) as Store;
}

function save(store: Store): void {
  writeFileSync(storePath!, JSON.stringify(store));
}

function mutate(change: (store: Store) => void): void {
  const store = load();
  change(store);
  save(store);
}

let sequence = Date.now();
const nextId = (prefix: string) => `${prefix}-${process.pid}-${(sequence += 1)}`;

function conversationOf(turn: StoredTurn) {
  return [
    {
      type: "conversationTurn",
      turn: {
        userMessage: { text: turn.prompt },
        steps: turn.reply ? [{ type: "assistantMessage", message: { text: turn.reply } }] : [],
      },
    },
  ];
}

/** A finished run as `listRuns` reports it, for history replay on resume. */
function storedRun(turn: StoredTurn) {
  return {
    id: turn.runId,
    status: turn.status,
    createdAt: turn.createdAt,
    supports: () => true,
    unsupportedReason: () => undefined,
    conversation: async () => conversationOf(turn),
    cancel: async () => undefined,
    onDidChangeStatus: () => () => undefined,
    async *stream() {},
    wait: async () => ({ id: turn.runId, status: turn.status, result: turn.reply }),
  };
}

function agentHandle(agentId: string) {
  return {
    agentId,
    model: undefined,
    async send(
      message: { text?: string },
      options: { onDelta?: (args: { update: unknown }) => void } = {},
    ) {
      const prompt = message.text ?? "";
      record("send", agentId);
      const turn: StoredTurn = {
        runId: nextId("run"),
        prompt,
        status: "running",
        createdAt: Date.now(),
      };
      mutate((store) => {
        const agent = store.agents[agentId];
        if (!agent) throw new Error(`Unknown Cursor agent ${agentId}`);
        agent.turns.push(turn);
      });
      const settle = (status: TurnStatus, reply?: string) => {
        turn.status = status;
        if (reply) turn.reply = reply;
        mutate((store) => {
          const stored = store.agents[agentId]?.turns.find((entry) => entry.runId === turn.runId);
          if (!stored) return;
          stored.status = status;
          if (reply) stored.reply = reply;
        });
      };
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      if (!prompt.includes("HOLD")) {
        const reply = `Answer to: ${prompt}`;
        options.onDelta?.({ update: { type: "text-delta", text: reply } });
        settle("finished", reply);
        release();
      }
      return {
        id: turn.runId,
        agentId,
        status: "running" as const,
        supports: () => true,
        unsupportedReason: () => undefined,
        conversation: async () => conversationOf(turn),
        // eslint-disable-next-line require-yield
        async *stream() {
          await released;
        },
        wait: async () => {
          await released;
          return { id: turn.runId, status: turn.status, result: turn.reply };
        },
        cancel: async () => {
          if (turn.status === "running") settle("cancelled");
          release();
        },
        // Accepted into the running turn, as the SDK's live steer is. Only a
        // held turn is ever running long enough to be steered.
        steer: async () => {
          record("steer", agentId);
          return "complete_delivered" as const;
        },
        onDidChangeStatus: () => () => undefined,
      };
    },
    getUsage: async () => ({ runs: [] }),
    close: () => undefined,
    reload: async () => undefined,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    // Disposal releases the handle. The conversation stays in the store, as a
    // vendor keeps it after the SDK agent is disposed.
    [Symbol.asyncDispose]: async () => record("dispose", agentId),
  };
}

const fakeAgentApi = {
  async create(options: { name?: string } = {}) {
    const agentId = nextId("cursor-agent");
    mutate((store) => {
      store.agents[agentId] = { name: options.name ?? "", createdAt: Date.now(), turns: [] };
    });
    await gateOpen();
    record("create", agentId);
    return agentHandle(agentId);
  },
  async resume(agentId: string) {
    if (!load().agents[agentId]) throw new Error(`Unknown Cursor agent ${agentId}`);
    record("resume", agentId);
    return agentHandle(agentId);
  },
  async list() {
    return {
      items: Object.entries(load().agents)
        // An agent that never ran a turn is a warm-up, not a conversation.
        .filter(([, agent]) => agent.turns.length > 0)
        .map(([agentId, agent]) => ({
          agentId,
          // The SDK keeps the name the agent was created with; the bridge has
          // no rename. The conversation itself is described by `summary`,
          // which the vendor writes; the first prompt stands in for it.
          name: agent.name,
          summary: agent.turns[0]!.prompt,
          createdAt: agent.createdAt,
          lastModified: agent.turns.at(-1)!.createdAt,
          status: agent.turns.some((turn) => turn.status === "running") ? "running" : "finished",
        })),
    };
  },
  async listRuns(agentId: string) {
    return { items: (load().agents[agentId]?.turns ?? []).map(storedRun) };
  },
};

resetPlanAccountWindowsForTests();
useCommandChangeProbeForTests(null);
setCursorMcpFingerprintForTests(async () => "fake-engine");
useCursorSdkRuntimeForTests({
  configureStore: () => undefined,
  createPlatform: (async () => ({
    prewarmLocalWorkspace: async () => async () => undefined,
  })) as unknown as typeof import("@cursor/sdk").createAgentPlatform,
});
useCursorLocalAgentStoreForTests({
  agents: { get: async () => undefined },
  runs: { get: async () => undefined },
} as unknown as Parameters<typeof useCursorLocalAgentStoreForTests>[0]);
useCursorModelsForTests({
  list: async () => [{ id: "composer-2", displayName: "Composer 2" }],
} as unknown as typeof import("@cursor/sdk").Cursor.models);
useCursorCredentialRuntimeForTests({
  store: {
    load: async () => undefined,
    save: async () => undefined,
    clear: async () => undefined,
  },
  auth: { login: async () => undefined, logout: async () => undefined } as never,
});
useCursorAgentForTests(fakeAgentApi as unknown as Parameters<typeof useCursorAgentForTests>[0]);
await start();
