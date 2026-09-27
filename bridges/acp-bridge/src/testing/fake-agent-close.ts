#!/usr/bin/env bun
/**
 * A small ACP agent for the `POST /session/:id/close` suite.
 *
 * Unlike `fake-agent.ts` it mints a distinct session id per `session/new` and
 * keeps its conversations in `FAKE_CLOSE_STORE`, so `session/list` and
 * `session/load` (each served by a fresh child) report the sessions this test
 * actually created rather than canned fixture rows. Every lifecycle event a
 * close test orders on is appended to `FAKE_CLOSE_LOG` as `<pid> <event>`.
 *
 * Prompts:
 * - `HOLD`: the turn stays open until `session/cancel`, then answers
 *   `stopReason: "cancelled"` after `FAKE_CLOSE_CANCEL_DELAY_MS` (never when
 *   `FAKE_CLOSE_IGNORE_CANCEL=1`).
 * - `ASK_ALL`: like `HOLD`, after parking a permission request, a Grok
 *   question and a Grok plan approval on the client.
 * - `CRASH`: the process exits mid-turn.
 * - anything else: recorded as the conversation's turn, answered, `end_turn`.
 *
 * `session/load` waits for `FAKE_CLOSE_LOAD_HOLD_FILE` to exist when set.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;

const log = process.env.FAKE_CLOSE_LOG;
const store = process.env.FAKE_CLOSE_STORE;
const cancelDelayMs = Number(process.env.FAKE_CLOSE_CANCEL_DELAY_MS ?? "0");
const ignoreCancel = process.env.FAKE_CLOSE_IGNORE_CANCEL === "1";
const loadHoldFile = process.env.FAKE_CLOSE_LOAD_HOLD_FILE;

function record(event: string): void {
  if (log) appendFileSync(log, `${process.pid} ${event}\n`);
}

function write(value: JsonObject): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

interface StoredTurn {
  sessionId: string;
  prompt?: string;
  answer?: string;
}

function storedTurns(): StoredTurn[] {
  if (!store || !existsSync(store)) return [];
  return readFileSync(store, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredTurn);
}

function update(sessionId: string, value: JsonObject): void {
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
}

record("start");
process.once("SIGTERM", () => {
  record("stop");
  process.exit(0);
});

const reverseRequests = new Map<number, string>([
  [7001, "permission"],
  [7002, "question"],
  [7003, "plan"],
]);
let heldPrompt: { id: number; sessionId: string } | null = null;
let sessionCounter = 0;

function whenFileExists(file: string, run: () => void): void {
  const deadline = Date.now() + 30_000;
  const poll = (): void => {
    if (existsSync(file) || Date.now() > deadline) run();
    else setTimeout(poll, 20);
  };
  poll();
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line) as JsonObject;
  const params = (message.params ?? {}) as JsonObject;
  const id = message.id;

  if (typeof id === "number" && !message.method && reverseRequests.has(id)) {
    record(`reply:${reverseRequests.get(id)}:${JSON.stringify(message.result)}`);
    return;
  }
  if (message.method === "session/cancel") {
    record("cancel");
    const held = heldPrompt;
    if (!held || ignoreCancel) return;
    setTimeout(() => {
      heldPrompt = null;
      record("answered-cancelled");
      write({ jsonrpc: "2.0", id: held.id, result: { stopReason: "cancelled" } });
    }, cancelDelayMs);
    return;
  }
  if (typeof id !== "number") return;

  switch (message.method) {
    case "initialize":
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        },
      });
      return;
    case "session/new": {
      sessionCounter += 1;
      const sessionId = `close-fake-${process.pid}-${sessionCounter}`;
      if (store) appendFileSync(store, `${JSON.stringify({ sessionId })}\n`);
      write({ jsonrpc: "2.0", id, result: { sessionId } });
      return;
    }
    case "session/list": {
      const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
      const titles = new Map<string, string | undefined>();
      for (const turn of storedTurns()) {
        titles.set(turn.sessionId, turn.prompt ?? titles.get(turn.sessionId));
      }
      write({
        jsonrpc: "2.0",
        id,
        result: {
          sessions: Array.from(titles, ([sessionId, title]) => ({
            sessionId,
            cwd,
            ...(title ? { title } : {}),
          })),
        },
      });
      return;
    }
    case "session/load": {
      const sessionId = String(params.sessionId);
      record("load");
      const answer = (): void => {
        const turns = storedTurns().filter((turn) => turn.sessionId === sessionId);
        if (turns.length === 0) {
          write({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown session" } });
          return;
        }
        turns.forEach((turn, index) => {
          if (!turn.prompt) return;
          update(sessionId, {
            sessionUpdate: "user_message_chunk",
            messageId: `stored-user-${index}`,
            content: { type: "text", text: turn.prompt },
          });
          update(sessionId, {
            sessionUpdate: "agent_message_chunk",
            messageId: `stored-agent-${index}`,
            content: { type: "text", text: turn.answer ?? "" },
          });
        });
        write({ jsonrpc: "2.0", id, result: {} });
      };
      if (loadHoldFile) whenFileExists(loadHoldFile, answer);
      else answer();
      return;
    }
    case "session/prompt": {
      const sessionId = String(params.sessionId);
      const blocks = Array.isArray(params.prompt) ? (params.prompt as JsonObject[]) : [];
      const text = typeof blocks[0]?.text === "string" ? blocks[0].text : "";
      if (text === "CRASH") process.exit(9);
      if (text === "HOLD" || text === "ASK_ALL") {
        heldPrompt = { id, sessionId };
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Working" },
        });
        if (text === "ASK_ALL") {
          write({
            jsonrpc: "2.0",
            id: 7001,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: { toolCallId: "tool-permission", title: "Run the tests" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
          });
          write({
            jsonrpc: "2.0",
            id: 7002,
            method: "x.ai/ask_user_question",
            params: {
              sessionId,
              toolCallId: "tool-question",
              questions: [{ question: "Which branch?", options: [{ label: "main" }] }],
            },
          });
          write({
            jsonrpc: "2.0",
            id: 7003,
            method: "x.ai/exit_plan_mode",
            params: { sessionId, toolCallId: "tool-plan", planContent: "1. Do it" },
          });
        }
        record("held");
        return;
      }
      const answer = `Answer to: ${text}`;
      if (store) appendFileSync(store, `${JSON.stringify({ sessionId, prompt: text, answer })}\n`);
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: answer },
      });
      write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      write({ jsonrpc: "2.0", id, result: {} });
  }
});
