#!/usr/bin/env node
/**
 * A stand-in for the `codex` binary, speaking just enough of the app-server
 * protocol over stdio for an end-to-end bridge test.
 *
 * This exists so the HTTP surface can be exercised through a *real* spawned
 * process — proving the engine flag, the supervisor's spawn arguments, JSONL
 * framing over actual pipes, and the route wiring all line up. Unit tests use
 * in-memory doubles; this closes the gap between those and the live binary.
 *
 *   FAKE_CODEX_VERSION   version reported by `--version` (default 0.145.0)
 *   FAKE_CODEX_SCRIPT    `auto-complete` to finish a turn on its own;
 *                        `subagents` to run `fake-codex-subagents.mjs`, which
 *                        writes real rollouts under CODEX_HOME;
 *                        `restart` persists content-free turn identities so a
 *                        replacement child can report interrupted turns
 *   FAKE_CODEX_CONTROL_SOCKET  where the `subagents` script takes `finish`
 */
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSubagentScenario, listenForControl } from "./fake-codex-subagents.mjs";

const args = process.argv.slice(2);
const version = process.env.FAKE_CODEX_VERSION || "0.145.0";

if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

if (args[0] !== "app-server") {
  process.stderr.write(`fake-codex: unsupported invocation: ${args.join(" ")}\n`);
  process.exit(2);
}

let threadCounter = 0;
let turnCounter = 0;
/** threadId → last turn id, so notifications can reference the right turn. */
const threads = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/*
 * The sub-agent script outlives a restart: a second process resumes threads the
 * first one wrote, so its ids must not repeat (`fake-thread-1` would) and its
 * turn timestamps must be real ones the rollout records can fall inside.
 */
const subagents =
  process.env.FAKE_CODEX_SCRIPT === "subagents"
    ? createSubagentScenario({
        send,
        codexHome: process.env.CODEX_HOME || "/tmp/codex-home",
        cwd: process.cwd(),
        model: "fake-model",
      })
    : null;
if (subagents && process.env.FAKE_CODEX_CONTROL_SOCKET) {
  listenForControl(process.env.FAKE_CODEX_CONTROL_SOCKET, subagents);
}
const restartScenario = process.env.FAKE_CODEX_SCRIPT === "restart";
const restartStatePath = join(process.env.CODEX_HOME || "/tmp/codex-home", "restart-turns.json");
function savedRestartTurns() {
  try {
    return JSON.parse(readFileSync(restartStatePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
function restartTurns(threadId) {
  if (!restartScenario) return [];
  const saved = savedRestartTurns()[threadId];
  if (!saved) return [];
  return [
    {
      id: saved.turnId,
      status: threads.get(threadId) === saved.turnId ? "inProgress" : "interrupted",
      items: [{ type: "userMessage", clientId: saved.requestId }],
    },
  ];
}

const nextThreadId = () =>
  subagents || restartScenario ? crypto.randomUUID() : `fake-thread-${(threadCounter += 1)}`;
const nextTurnId = () =>
  subagents || restartScenario ? crypto.randomUUID() : `fake-turn-${(turnCounter += 1)}`;
const nowSeconds = () => (subagents ? Math.floor(Date.now() / 1_000) : 1_700_000_200);

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function threadObject(id, extra = {}) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "fake preview",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100,
    status: { type: "idle" },
    path: null,
    cwd: process.cwd(),
    cliVersion: version,
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...extra,
  };
}

let initialized = false;

const handlers = {
  "skills/list": (id) => {
    respond(id, { data: [{ cwd: process.cwd(), skills: [], errors: [] }] });
  },
  initialize: (id) => {
    if (process.env.FAKE_CODEX_SCRIPT === "no-initialize") return;
    respond(id, {
      userAgent: `orkestrator/${version} (fake; test)`,
      codexHome: process.env.CODEX_HOME || "/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "linux",
    });
  },
  "thread/start": (id, params) => {
    const threadId = nextThreadId();
    threads.set(threadId, null);
    const thread = threadObject(threadId, { cwd: params?.cwd ?? process.cwd() });
    respond(id, {
      thread,
      model: params?.model ?? "gpt-5.6-sol",
      modelProvider: "openai",
      serviceTier: params?.serviceTier ?? null,
      cwd: thread.cwd,
      instructionSources: [],
      approvalPolicy: params?.approvalPolicy ?? "never",
      approvalsReviewer: "none",
      sandbox: { type: "dangerFullAccess" },
      reasoningEffort: null,
    });
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread } });
  },
  "thread/resume": (id, params) => {
    const threadId = params?.threadId ?? nextThreadId();
    threads.set(threadId, null);
    const thread = threadObject(threadId, {
      path: subagents?.pathOf(threadId) ?? null,
      turns: restartTurns(threadId),
    });
    respond(id, {
      thread,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      serviceTier: null,
      cwd: thread.cwd,
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "none",
      sandbox: { type: "dangerFullAccess" },
      reasoningEffort: null,
    });
  },
  "thread/read": (id, params) => {
    const threadId = params?.threadId ?? "fake-thread-1";
    respond(id, {
      thread: threadObject(threadId, {
        path: subagents?.pathOf(threadId) ?? null,
        turns: restartTurns(threadId),
      }),
    });
  },
  "thread/list": (id) => respond(id, { data: [], nextCursor: null, backwardsCursor: null }),
  "thread/unsubscribe": (id) => respond(id, {}),
  "thread/name/set": (id) => respond(id, {}),
  "model/list": (id) =>
    respond(id, {
      data: [
        {
          id: "fake-model",
          model: "fake-model",
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "Fake Model",
          description: "Deterministic test model.",
          hidden: false,
          // Deliberately non-alphabetical: order is meaningful.
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "fast" },
            { reasoningEffort: "medium", description: "balanced" },
            { reasoningEffort: "high", description: "deep" },
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: true,
        },
      ],
      nextCursor: null,
    }),
  "turn/start": (id, params) => {
    const turnId = nextTurnId();
    const threadId = params?.threadId;
    threads.set(threadId, turnId);
    if (restartScenario) {
      const saved = savedRestartTurns();
      saved[threadId] = { turnId, requestId: params.clientUserMessageId };
      mkdirSync(process.env.CODEX_HOME, { recursive: true });
      writeFileSync(restartStatePath, JSON.stringify(saved));
    }
    const turn = {
      id: turnId,
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
    };
    respond(id, { turn });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn } });

    if (subagents) {
      const prompt = (params?.input ?? [])
        .map((entry) => (entry?.type === "text" ? entry.text : ""))
        .join("");
      subagents.startTurn({ threadId, turnId, prompt });
      return;
    }

    if (process.env.FAKE_CODEX_SCRIPT === "auto-complete") {
      // Stream a delta, then the authoritative item, then finish — the same
      // ordering the real binary uses.
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "item-1", delta: "partial" },
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: 1_700_000_300_000,
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "done",
            phase: null,
            memoryCitation: null,
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: { ...turn, status: "completed", completedAt: 1_700_000_300 } },
      });
    }
  },
  "turn/interrupt": (id, params) => {
    respond(id, {});
    const { threadId, turnId } = params ?? {};
    // Asynchronous by contract: the terminal event is what ends the turn.
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            items: [],
            itemsView: "full",
            status: "interrupted",
            error: null,
            startedAt: 1_700_000_200,
            completedAt: 1_700_000_250,
            durationMs: 50_000,
          },
        },
      });
    }, 10);
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (message.id === undefined) return;

  const handler = handlers[message.method];
  if (!handler) {
    fail(message.id, -32601, `unknown method ${message.method}`);
    return;
  }
  // app-server rejects ordinary requests before the handshake completes.
  if (message.method !== "initialize" && !initialized) {
    fail(message.id, -32600, "initialize/initialized handshake not complete");
    return;
  }
  handler(message.id, message.params);
});

process.stdin.on("end", () => process.exit(0));
