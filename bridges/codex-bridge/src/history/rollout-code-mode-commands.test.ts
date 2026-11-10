/**
 * A reload renders the commands a code-mode cell ran exactly as the live
 * stream did, under the live item's id. The first replay after live streaming
 * renames every row (`replayedRowId`); a tab that kept the reader's opened
 * tool group and place by call id keeps them only if the calls are not
 * renamed too (todo 0050, task 5).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptAppServerItem } from "../app-server/item-adapter.js";
import { itemToParts } from "../messages/normalization.js";
import type { NormalizedMessage, NormalizedPart } from "../messages/types.js";
import { clearTranscriptCache } from "../transcript-cache.js";
import { joinCommandArguments, rolloutCommandExecutionParts } from "./code-mode-commands.js";
import {
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
} from "./rollout.js";

const THREAD = "code-mode-commands-thread";
const TURN = "turn-code-mode-commands";

let root: string;
let previousCodexHome: string | undefined;
let previousCwd: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-rollout-code-mode-commands-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  previousCodexHome = process.env.CODEX_HOME;
  previousCwd = process.env.CWD;
  process.env.CODEX_HOME = root;
  process.env.CWD = "/replay/workspace";
});

afterEach(async () => {
  clearTranscriptCache();
  invalidateTranscriptCatalogCache();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCwd === undefined) delete process.env.CWD;
  else process.env.CWD = previousCwd;
  await rm(root, { recursive: true, force: true });
});

async function hydrate(records: object[]): Promise<NormalizedMessage[]> {
  await writeFile(
    join(root, "sessions", `rollout-2026-11-06T10-00-00-${THREAD}.jsonl`),
    rollout(records),
  );
  const hydrated = await hydrateMessagesFromPersistedSession(THREAD);
  expect(hydrated.transcriptStatus).toBe("complete");
  return hydrated.messages;
}

const at = (second: number) => new Date(Date.UTC(2026, 10, 6, 10, 0, second)).toISOString();
const response = (second: number, payload: Record<string, unknown>) => ({
  timestamp: at(second),
  type: "response_item",
  payload,
});
const usage = (second: number) => ({
  timestamp: at(second),
  type: "token_usage_record",
  payload: { thread_id: THREAD, turn_id: TURN, usage: { total_tokens: 2 } },
});
const execCell = (second: number, callId: string, cmd: string) =>
  response(second, {
    type: "custom_tool_call",
    status: "completed",
    call_id: callId,
    name: "exec",
    input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify({ cmd })})));`,
  });
const execOutput = (second: number, callId: string, text: string) =>
  response(second, {
    type: "custom_tool_call_output",
    call_id: callId,
    output: [{ type: "input_text", text }],
  });
/** The record codex 0.166 writes for a command a cell ran. */
const commandRecord = (second: number, id: string, cmd: string, output: string) => ({
  timestamp: at(second),
  type: "event_msg",
  payload: {
    type: "item_completed",
    thread_id: THREAD,
    turn_id: TURN,
    item: {
      type: "CommandExecution",
      id,
      process_id: "4242",
      command: ["/bin/zsh", "-lc", cmd],
      cwd: "file:///replay/workspace",
      parsed_cmd: [{ type: "read", cmd, name: "a.txt", path: "a.txt" }],
      source: "unified_exec_startup",
      status: "completed",
      aggregated_output: output,
      exit_code: 0,
      duration: { secs: 0, nanos: 12_000_000 },
    },
  },
});
/** One cell running one command, then its response's usage report and output. */
const cellRunning = (second: number, cell: string, item: string, cmd: string, output: string) => [
  execCell(second, cell, cmd),
  usage(second),
  commandRecord(second, item, cmd, output),
  execOutput(second, cell, `Script completed\n${JSON.stringify({ output })}`),
];

function rollout(records: object[]): string {
  return [
    {
      timestamp: at(0),
      type: "session_meta",
      payload: { id: THREAD, timestamp: at(0), cwd: "/replay/workspace" },
    },
    { timestamp: at(0), type: "event_msg", payload: { type: "task_started", turn_id: TURN } },
    response(1, {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Read the files." }],
    }),
    ...records,
  ]
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");
}

function toolParts(message: NormalizedMessage): NormalizedPart[] {
  return message.parts.filter((part) => part.type === "tool-invocation");
}

/** The part the live stream renders for the app-server item of the same command. */
async function liveCommandPart(id: string, cmd: string, output: string): Promise<NormalizedPart> {
  const { item } = adaptAppServerItem({
    type: "commandExecution",
    id,
    command: `/bin/zsh -lc '${cmd}'`,
    cwd: "/replay/workspace",
    processId: "4242",
    source: "unifiedExecStartup",
    status: "completed",
    commandActions: [],
    aggregatedOutput: output,
    exitCode: 0,
    durationMs: 12,
  });
  const [part] = await itemToParts(item!, "/replay/workspace");
  return part!;
}

describe("code-mode commands in a reloaded transcript", () => {
  for (const ending of [
    "active",
    "task_complete",
    "turn_aborted",
    "later-success",
    "later-failure",
  ]) {
    test(`unfinished replay command: ${ending}`, async () => {
      const record = commandRecord(2, "exec-background", "bun run dev", "listening");
      Object.assign(record.payload.item, { status: "in_progress", exit_code: null });
      const records: object[] = [
        execCell(2, "cell", "bun run dev"),
        record,
        execOutput(3, "cell", "Script completed"),
      ];
      if (ending !== "active")
        records.push({
          type: "event_msg",
          payload: {
            type: ending === "turn_aborted" ? "turn_aborted" : "task_complete",
            turn_id: TURN,
          },
        });
      if (ending.startsWith("later-")) {
        const later = commandRecord(5, "exec-background", "bun run dev", "stopped");
        if (ending === "later-failure")
          Object.assign(later.payload.item, { status: "failed", exit_code: 1 });
        records.push(later);
      }
      const messages = await hydrate(records);
      const parts = messages
        .flatMap(toolParts)
        .filter((part) => part.toolUseId === "exec-background");
      expect(parts).toHaveLength(1);
      const part = parts[0]!;
      if (ending === "active") {
        expect(part.toolState).toBe("pending");
        expect(part.toolLeftRunning).toBeUndefined();
      } else if (ending.startsWith("later-")) {
        expect(part.toolState).toBe(ending === "later-success" ? "success" : "failure");
        expect(part.toolLeftRunning).toBeUndefined();
        expect(part.toolOutput ?? part.toolError).toBe("stopped");
      } else {
        expect(part.toolState).toBeUndefined();
        expect(part.toolLeftRunning).toBe(true);
      }
    });
  }

  test("a cell's command renders as the live item did, under its id, with no exec row", async () => {
    const messages = await hydrate([
      ...cellRunning(2, "call_cell_1", "exec-11111111", "cat a.txt", "Stop 1. Next: b.txt\n"),
      response(3, {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(toolParts(messages[1]!)).toEqual([
      await liveCommandPart("exec-11111111", "cat a.txt", "Stop 1. Next: b.txt\n"),
    ]);
    expect(messages[2]!.content).toBe("Done.");
  });

  test("each response keeps its own row, holding its own command", async () => {
    const messages = await hydrate([
      ...cellRunning(2, "call_cell_1", "exec-1", "cat a.txt", "Next: b.txt\n"),
      ...cellRunning(3, "call_cell_2", "exec-2", "cat b.txt", "Next: c.txt\n"),
      ...cellRunning(4, "call_cell_3", "exec-3", "cat c.txt", "The end.\n"),
    ]);

    expect(messages.map((message) => toolParts(message).map((part) => part.toolUseId))).toEqual([
      [],
      ["exec-1"],
      ["exec-2"],
      ["exec-3"],
    ]);
    // A replay of the same rollout names every row and call alike.
    clearTranscriptCache();
    invalidateTranscriptCatalogCache();
    const again = (await hydrateMessagesFromPersistedSession(THREAD)).messages;
    expect(again.map((message) => message.id)).toEqual(messages.map((message) => message.id));
  });

  test("a direct shell call's record does not render its command a second time", async () => {
    const messages = await hydrate([
      execCell(2, "call_cell_1", "cat a.txt"),
      response(2, {
        type: "function_call",
        call_id: "call_direct_1",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls" }),
      }),
      commandRecord(2, "call_direct_1", "ls", "a.txt\n"),
      response(2, { type: "function_call_output", call_id: "call_direct_1", output: "a.txt\n" }),
      execOutput(2, "call_cell_1", "Script completed\n"),
    ]);

    const ids = messages.flatMap((message) => toolParts(message).map((part) => part.toolUseId));
    expect(ids.filter((id) => id === "call_direct_1")).toHaveLength(1);
    // The cell's own command is unrecorded here, so its row stays.
    expect(ids).toContain("call_cell_1");
  });

  test("a command it cannot pin to one cell keeps the cells' exec rows", async () => {
    const messages = await hydrate([
      execCell(2, "call_cell_1", "cat a.txt"),
      execCell(2, "call_cell_2", "cat b.txt"),
      commandRecord(3, "exec-1", "cat a.txt", "a\n"),
      execOutput(3, "call_cell_1", "Script completed\n"),
      execOutput(3, "call_cell_2", "Script completed\n"),
    ]);

    const ids = messages.flatMap((message) => toolParts(message).map((part) => part.toolUseId));
    expect(ids).toEqual(["call_cell_1", "call_cell_2"]);
  });

  test("a cell whose output reports a refusal keeps its exec row beside the command", async () => {
    const messages = await hydrate([
      execCell(2, "call_cell_1", "cat a.txt"),
      commandRecord(2, "exec-1", "cat a.txt", "a\n"),
      execOutput(2, "call_cell_1", "Script failed\nPermission denied"),
    ]);

    expect(messages.flatMap((message) => toolParts(message).map((part) => part.toolName))).toEqual([
      "exec",
      "bash",
    ]);
  });
});

describe("rolloutCommandExecutionParts", () => {
  test("only a CommandExecution record with an id and a command renders", () => {
    expect(rolloutCommandExecutionParts({ type: "McpToolCall", id: "x" })).toBeNull();
    expect(rolloutCommandExecutionParts({ type: "CommandExecution", command: ["ls"] })).toBeNull();
    expect(rolloutCommandExecutionParts({ type: "CommandExecution", id: "x" })).toBeNull();
    expect(
      rolloutCommandExecutionParts({ type: "CommandExecution", id: "x", command: ["ls", 1] }),
    ).toBeNull();
    const [failed] = rolloutCommandExecutionParts({
      type: "CommandExecution",
      id: "x",
      command: "false",
      status: "failed",
      aggregated_output: "",
    })!;
    expect(failed).toMatchObject({ toolUseId: "x", toolState: "failure", toolTitle: "false" });
  });

  test("joins arguments the way app-server reports the command line", () => {
    expect(joinCommandArguments(["/bin/zsh", "-lc", "cat trail-1/a.txt"])).toBe(
      "/bin/zsh -lc 'cat trail-1/a.txt'",
    );
    expect(joinCommandArguments(["printf", "", "it's"])).toBe(`printf '' 'it'"'"'s'`);
  });
});
