/**
 * File-backed fake Cursor SDK used by the close-retention fixture and the
 * Docker fixture's container cells.
 *
 * A prompt with a line `FETCH <url>` makes the fake request that URL from this
 * process before it answers `Fetch <url>: HTTP <status>` or
 * `Fetch <url>: failed (<code>)`. The real SDK's local agent runs its tools
 * from the bridge process, so this is the reach a Cursor turn has from where
 * the bridge runs (in a container, behind its firewall).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { stripSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";

const FETCH_LINE = /^FETCH (\S+)$/m;
const FETCH_TIMEOUT_MS = 10_000;

/** The parts of `Agent.create`'s options a spec reads back. */
interface AgentCreateOptions {
  mode?: string;
  local?: {
    cwd?: string;
    settingSources?: unknown;
    sandboxOptions?: unknown;
    autoReview?: boolean;
  };
  tools?: unknown;
  disallowedTools?: unknown;
  mcpServers?: Record<string, unknown>;
}

export interface CreatedOptions {
  mode?: string;
  cwd?: string;
  settingSources?: unknown;
  sandboxOptions?: unknown;
  autoReview?: boolean;
  tools?: unknown;
  disallowedTools?: unknown;
  /** Names only: a server entry carries its bearer token. */
  mcpServerNames: string[];
}

/** A credential-free copy: no API key, no MCP server definitions. */
function createdOptions(options: AgentCreateOptions): CreatedOptions {
  return {
    mode: options.mode,
    cwd: options.local?.cwd,
    settingSources: options.local?.settingSources,
    sandboxOptions: options.local?.sandboxOptions,
    autoReview: options.local?.autoReview,
    tools: options.tools,
    disallowedTools: options.disallowedTools,
    mcpServerNames: Object.keys(options.mcpServers ?? {}),
  };
}

export function createFakeCursorAgentApi({
  storePath,
  logPath,
  createGate,
}: {
  storePath: string;
  logPath?: string;
  createGate?: string;
}) {
  type TurnStatus = "running" | "finished" | "cancelled";
  interface StoredTurn {
    runId: string;
    /** The user's text: what the SDK was sent, without the system-instructions frame. */
    prompt: string;
    /** Exactly what the SDK was sent. */
    sent: string;
    reply?: string;
    status: TurnStatus;
    createdAt: number;
    /**
     * Every steer this run accepted, in order, as the user's text (the frame
     * stripped). A steer the bridge delivered twice shows up twice here.
     */
    steers?: string[];
  }
  interface StoredAgent {
    /** The name the bridge created the agent with. */
    name: string;
    createdAt: number;
    /** What the bridge asked the SDK for; see {@link createdOptions}. */
    options?: CreatedOptions;
    turns: StoredTurn[];
  }
  type Store = { agents: Record<string, StoredAgent> };

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

  async function fetchReply(url: string, signal: AbortSignal): Promise<string> {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });
      await response.body?.cancel();
      return `Fetch ${url}: HTTP ${response.status}`;
    } catch (error) {
      const code =
        (error as { code?: unknown }).code ?? (error as { name?: unknown }).name ?? "error";
      return `Fetch ${url}: failed (${String(code)})`;
    }
  }

  let sequence = Date.now();
  const nextId = (prefix: string) => `${prefix}-${process.pid}-${(sequence += 1)}`;

  function conversationOf(turn: StoredTurn) {
    return [
      {
        type: "conversationTurn",
        turn: {
          userMessage: { text: turn.sent },
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
        const sent = message.text ?? "";
        const prompt = stripSystemInstructions(sent);
        record("send", agentId);
        const turn: StoredTurn = {
          runId: nextId("run"),
          prompt,
          sent,
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
        const controller = new AbortController();
        const finish = (reply: string) => {
          if (turn.status !== "running") return;
          options.onDelta?.({ update: { type: "text-delta", text: reply } });
          settle("finished", reply);
          release();
        };
        const fetchUrl = FETCH_LINE.exec(prompt)?.[1];
        if (fetchUrl) void fetchReply(fetchUrl, controller.signal).then(finish);
        else if (!prompt.includes("HOLD")) finish(`Answer to: ${prompt}`);
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
            if (turn.status === "running") {
              settle("cancelled");
              controller.abort();
            }
            release();
          },
          // Accepted into the running turn, as the SDK's live steer is. Only a
          // held turn is ever running long enough to be steered. The text is
          // kept on the turn, so a spec can count what reached the vendor.
          steer: async (text?: string) => {
            record("steer", agentId);
            const steer = stripSystemInstructions(text ?? "");
            turn.steers = [...(turn.steers ?? []), steer];
            mutate((store) => {
              const stored = store.agents[agentId]?.turns.find(
                (entry) => entry.runId === turn.runId,
              );
              if (stored) stored.steers = [...(stored.steers ?? []), steer];
            });
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

  return {
    async create(options: { name?: string } & AgentCreateOptions = {}) {
      const agentId = nextId("cursor-agent");
      mutate((store) => {
        store.agents[agentId] = {
          name: options.name ?? "",
          createdAt: Date.now(),
          options: createdOptions(options),
          turns: [],
        };
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
}
