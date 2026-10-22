/**
 * The `FAKE_CODEX_SCRIPT=subagents` turn for `fake-codex-app-server.mjs`.
 *
 * Reproduces the multi-agent v2 shape behind the duplicate-card incident
 * (docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md, "Codex sub-agent
 * cards"): `spawn_agent` outputs carry only a task path, the parent rollout has
 * no `sub_agent_activity` records, and child thread ids reach the parent stream
 * only as live `subAgentActivity` items. A cold bridge therefore has nothing but
 * the child rollouts' `session_meta` headers to recover identity from.
 *
 * Every rollout is written the way Codex lays it out, under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`, and each
 * record lands on disk before the live item that announces it.
 *
 * The children stay running until a client connects to
 * `FAKE_CODEX_CONTROL_SOCKET` and sends `finish`. The reply `finished` is
 * written after every child and the parent turn have completed, so a test
 * steps the scenario without waiting on a clock.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Successful children, in spawn order. Names are synthetic. */
export const FAKE_SUBAGENT_CHILDREN = [
  { task: "lint_check", nickname: "Ada", role: "explorer" },
  { task: "type_check", nickname: "Grace", role: "explorer" },
  { task: "unit_check", nickname: "Linus", role: "worker" },
];
/** The spawn Codex rejects at capacity. It never gets a child thread. */
export const FAKE_SUBAGENT_REJECTED_TASK = "extra_check";
export const FAKE_SUBAGENT_LIMIT_MESSAGE = "collab spawn failed: agent thread limit reached";

function pad(value) {
  return String(value).padStart(2, "0");
}

export function rolloutPath(codexHome, threadId, createdAt = new Date()) {
  const day = join(
    codexHome,
    "sessions",
    String(createdAt.getUTCFullYear()),
    pad(createdAt.getUTCMonth() + 1),
    pad(createdAt.getUTCDate()),
  );
  mkdirSync(day, { recursive: true });
  const stamp = createdAt.toISOString().slice(0, 19).replace(/:/g, "-");
  return join(day, `rollout-${stamp}-${threadId}.jsonl`);
}

function appendRecords(path, records) {
  const timestamp = new Date().toISOString();
  appendFileSync(
    path,
    records.map((record) => JSON.stringify({ timestamp, ...record })).join("\n") + "\n",
  );
}

const response = (payload) => ({ type: "response_item", payload });
const event = (payload) => ({ type: "event_msg", payload });

function userMessageRecords(text) {
  return [
    response({ type: "message", role: "user", content: [{ type: "input_text", text }] }),
    event({ type: "user_message", message: text }),
  ];
}

function assistantMessageRecords(text, phase) {
  return [
    response({
      type: "message",
      role: "assistant",
      phase,
      content: [{ type: "output_text", text }],
    }),
    event({ type: "agent_message", phase, message: text }),
  ];
}

/**
 * Owns the sub-agent turns of one fake app-server process.
 *
 * `send` writes one JSON-RPC message to the bridge; `codexHome` is where the
 * rollouts go. Threads this process did not start (a cold restart resuming one)
 * are looked up by the caller and need no state here.
 */
export function createSubagentScenario({ send, codexHome, cwd, model }) {
  /** threadId → { path, turnId, children, pending } */
  const parents = new Map();
  const nowMs = () => Date.now();

  const notifyItem = (threadId, turnId, item) => {
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, item } });
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId, turnId, item, completedAtMs: nowMs() },
    });
  };

  const agentMessage = (threadId, turnId, id, text, phase) =>
    notifyItem(threadId, turnId, { id, type: "agentMessage", text, phase, memoryCitation: null });

  function ensureParent(threadId) {
    let parent = parents.get(threadId);
    if (!parent) {
      const path = rolloutPath(codexHome, threadId);
      appendRecords(path, [
        {
          type: "session_meta",
          payload: { id: threadId, cwd, originator: "orkestrator", source: "vscode" },
        },
      ]);
      parent = { path, turnId: null, children: [], pending: false };
      parents.set(threadId, parent);
    }
    return parent;
  }

  /**
   * A thread's rollout, for `thread/*` responses. A restarted process finds
   * the threads its predecessor wrote on disk, as Codex does.
   */
  function pathOf(threadId) {
    const known = parents.get(threadId)?.path;
    if (known) return known;
    const sessions = join(codexHome, "sessions");
    let entries = [];
    try {
      entries = readdirSync(sessions, { recursive: true });
    } catch {
      return null;
    }
    const match = entries.find((entry) => String(entry).endsWith(`-${threadId}.jsonl`));
    return match ? join(sessions, String(match)) : null;
  }

  function startTurn({ threadId, turnId, prompt }) {
    const parent = ensureParent(threadId);
    parent.turnId = turnId;
    parent.pending = true;
    appendRecords(parent.path, [
      { type: "turn_context", payload: { turn_id: turnId, cwd, model } },
      event({ type: "task_started", turn_id: turnId }),
      ...userMessageRecords(prompt),
    ]);
    agentMessage(threadId, turnId, `${turnId}-intro`, "Starting the checks.", "commentary");
    appendRecords(parent.path, assistantMessageRecords("Starting the checks.", "commentary"));

    parent.children = FAKE_SUBAGENT_CHILDREN.map((spec, index) => {
      const childId = crypto.randomUUID();
      const callId = `call_spawn_${index + 1}_${turnId}`;
      const agentPath = `/root/${spec.task}`;
      const message = `Run the ${spec.task.replace("_", " ")} and report.`;
      appendRecords(parent.path, [
        response({
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({ task_name: spec.task, message }),
        }),
      ]);
      const childPath = rolloutPath(codexHome, childId);
      appendRecords(childPath, [
        {
          type: "session_meta",
          // The header codex 0.162.1 writes for a spawned child.
          payload: {
            id: childId,
            cwd,
            originator: "orkestrator",
            agent_nickname: spec.nickname,
            agent_role: spec.role,
            agent_path: agentPath,
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: threadId,
                  depth: 1,
                  agent_path: agentPath,
                  agent_nickname: spec.nickname,
                  agent_role: spec.role,
                },
              },
            },
          },
        },
        { type: "turn_context", payload: { turn_id: `child-turn-${index + 1}`, cwd, model } },
        event({ type: "task_started" }),
        ...userMessageRecords(message),
        response({
          type: "function_call",
          name: "exec_command",
          call_id: `call_exec_${index + 1}`,
          arguments: JSON.stringify({ cmd: `echo ${spec.task}` }),
        }),
        response({
          type: "function_call_output",
          call_id: `call_exec_${index + 1}`,
          output: `${spec.task} ok`,
        }),
      ]);
      appendRecords(parent.path, [
        response({
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ task_name: agentPath }),
        }),
      ]);
      // Deliberately a different id from the spawn call: nothing may assume
      // a live activity item names the call that spawned its child.
      notifyItem(threadId, turnId, {
        id: `activity-started-${index + 1}-${turnId}`,
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: childId,
        agentPath,
        model,
        reasoningEffort: "medium",
      });
      return { ...spec, childId, childPath, agentPath, index };
    });

    const rejectedCall = `call_spawn_rejected_${turnId}`;
    appendRecords(parent.path, [
      response({
        type: "function_call",
        name: "spawn_agent",
        call_id: rejectedCall,
        arguments: JSON.stringify({
          task_name: FAKE_SUBAGENT_REJECTED_TASK,
          message: "Run one more check.",
        }),
      }),
      response({
        type: "function_call_output",
        call_id: rejectedCall,
        output: FAKE_SUBAGENT_LIMIT_MESSAGE,
      }),
    ]);
  }

  /** Completes every child, then the parent turn. Idempotent per turn. */
  function finishAll() {
    for (const [threadId, parent] of parents) {
      if (!parent.pending) continue;
      parent.pending = false;
      const turnId = parent.turnId;
      for (const child of parent.children) {
        const answer = `${child.task} passed.`;
        appendRecords(child.childPath, [
          event({ type: "agent_message", phase: "final_answer", message: answer }),
          event({ type: "task_complete", last_agent_message: answer }),
        ]);
        notifyItem(threadId, turnId, {
          id: `activity-completed-${child.index + 1}-${turnId}`,
          type: "subAgentActivity",
          kind: "completed",
          agentThreadId: child.childId,
          agentPath: child.agentPath,
          model: null,
          reasoningEffort: null,
        });
      }
      const summary = "All three checks passed; one more could not start.";
      appendRecords(parent.path, [
        ...assistantMessageRecords(summary, "final_answer"),
        event({ type: "task_complete", turn_id: turnId, last_agent_message: summary }),
      ]);
      agentMessage(threadId, turnId, `${turnId}-summary`, summary, "final_answer");
      const completedAt = Math.floor(nowMs() / 1_000);
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: completedAt,
            completedAt,
            durationMs: 0,
          },
        },
      });
    }
  }

  return { startTurn, finishAll, pathOf, isPending: (id) => parents.get(id)?.pending === true };
}

/**
 * Serves `finish` on a Unix socket. A restarted app-server reclaims the path,
 * so a stale socket from the previous process is removed first.
 */
export function listenForControl(socketPath, scenario) {
  rmSync(socketPath, { force: true });
  const server = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      if (line.trim() === "finish") {
        scenario.finishAll();
        socket.write("finished\n");
      } else {
        socket.write(`unknown ${line.trim()}\n`);
      }
    });
  });
  server.listen(socketPath);
  server.unref();
  return server;
}
