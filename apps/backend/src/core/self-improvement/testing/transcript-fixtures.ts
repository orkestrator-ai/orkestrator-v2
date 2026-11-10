/**
 * Synthetic Claude Code and Codex history files, in the record shapes the two
 * tools write (`~/.claude/projects/<project>/<session>.jsonl` and
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), for the insight tests.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

export type FixtureTurn =
  | { user: string; at: number; origin?: "human" | "task-notification" }
  | { assistant: string; at: number; tools?: string[]; toolError?: boolean }
  | { interrupt: true; at: number };

export function claudeJsonl(sessionId: string, cwd: string, turns: readonly FixtureTurn[]): string {
  const rows: unknown[] = [];
  for (const turn of turns) {
    const base = { sessionId, cwd, isSidechain: false, timestamp: new Date(turn.at).toISOString() };
    if ("user" in turn) {
      rows.push({
        ...base,
        type: "user",
        origin: { kind: turn.origin ?? "human" },
        promptSource: turn.origin === "task-notification" ? "system" : "typed",
        message: { role: "user", content: turn.user },
      });
    } else if ("interrupt" in turn) {
      rows.push({
        ...base,
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      });
    } else {
      rows.push({
        ...base,
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning that must never be read" },
            { type: "text", text: turn.assistant },
            ...(turn.tools ?? []).map((name) => ({
              type: "tool_use",
              name,
              input: { secret: "tool input" },
            })),
          ],
        },
      });
      if (turn.toolError) {
        rows.push({
          ...base,
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                is_error: true,
                content: "tool output that must never be read",
              },
            ],
          },
        });
      }
    }
  }
  rows.push({
    sessionId,
    cwd,
    isSidechain: true,
    type: "user",
    timestamp: new Date(turns[0]!.at).toISOString(),
    message: { role: "user", content: "a sub-agent's prompt" },
  });
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

export function codexJsonl(threadId: string, cwd: string, turns: readonly FixtureTurn[]): string {
  const first = new Date(turns[0]!.at).toISOString();
  const rows: unknown[] = [
    { timestamp: first, type: "session_meta", payload: { id: threadId, cwd, timestamp: first } },
    {
      timestamp: first,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>",
          },
        ],
      },
    },
  ];
  for (const turn of turns) {
    const timestamp = new Date(turn.at).toISOString();
    if ("user" in turn) {
      rows.push({
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: turn.user }],
        },
      });
    } else if ("interrupt" in turn) {
      rows.push({ timestamp, type: "event_msg", payload: { type: "turn_aborted" } });
    } else {
      for (const name of turn.tools ?? []) {
        rows.push({
          timestamp,
          type: "response_item",
          payload: { type: "function_call", name, arguments: "{}" },
        });
        rows.push({
          timestamp,
          type: "response_item",
          payload: { type: "function_call_output", output: "secret output" },
        });
      }
      rows.push({
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: turn.assistant }],
        },
      });
    }
  }
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** Writes a history file and dates it, so the settle and look-back rules see the right age. */
export function writeTranscript(file: string, contents: string, mtime: number): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}
