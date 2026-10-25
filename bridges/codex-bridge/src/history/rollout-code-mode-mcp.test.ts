/**
 * A reload renders a code-mode cell's MCP calls exactly as the live stream
 * does, so the web client can anchor an artifact publication to its
 * `publish_artifact` call after a re-attach or a bridge restart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  RECORDED_PUBLISH_ARTIFACT_ARGS,
  SUCCESSFUL_PUBLISH_CONTRACT,
  publishArtifactCallContract,
  recordedArtifactCallToolResult,
} from "@orkestrator/protocol/testing/artifact-tool-fixtures";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRedactions, scrub } from "../../../../scripts/scrub-codex-recording.ts";
import type { NormalizedMessage, NormalizedPart } from "../messages/types.js";
import { replayRecording } from "../testing/replay-recording.js";
import { clearTranscriptCache } from "../transcript-cache.js";
import {
  MAX_CODE_MODE_MCP_ARGUMENT_CHARS,
  MAX_CODE_MODE_MCP_CALLS_PER_CELL,
  parseCodeModeMcpCalls,
} from "./code-mode-mcp-calls.js";
import {
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
} from "./rollout.js";

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "testing",
  "fixtures",
  "rollouts",
  "code-mode-mcp-publish.jsonl",
);
const FIXTURE_THREAD = "01960000-0000-7000-8000-0000000000b1";
const FIXTURE_TURN = "01960000-0000-7000-8000-0000000000b2";
const FIXTURE_CELL = "call_fixture_exec_0001";
const FIXTURE_ITEM = "exec-01960000-0000-7000-8000-0000000000b3";
const THREAD = "code-mode-thread";
const TURN = "turn-code-mode";

let root: string;
let previousCodexHome: string | undefined;
let previousCwd: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-rollout-code-mode-"));
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

async function hydrate(threadId: string, contents: string): Promise<NormalizedMessage[]> {
  await writeFile(
    join(root, "sessions", `rollout-2026-10-20T10-00-00-${threadId}.jsonl`),
    contents,
  );
  const hydrated = await hydrateMessagesFromPersistedSession(threadId);
  expect(hydrated.transcriptStatus).toBe("complete");
  return hydrated.messages;
}

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();
const response = (second: number, payload: Record<string, unknown>) => ({
  timestamp: at(second),
  type: "response_item",
  payload,
});
const completedItem = (second: number, item: Record<string, unknown>) => ({
  timestamp: at(second),
  type: "event_msg",
  payload: { type: "item_completed", thread_id: THREAD, turn_id: TURN, item },
});
const execCell = (second: number, callId: string, input: string) =>
  response(second, {
    type: "custom_tool_call",
    status: "completed",
    call_id: callId,
    name: "exec",
    input,
  });
const execOutput = (second: number, callId: string, text: string) =>
  response(second, {
    type: "custom_tool_call_output",
    call_id: callId,
    output: [{ type: "input_text", text }],
  });
const publishRecord = (second: number, id: string) =>
  completedItem(second, {
    type: "McpToolCall",
    id,
    server: "orkestrator",
    tool: "publish_artifact",
    arguments: { ...RECORDED_PUBLISH_ARTIFACT_ARGS },
    readOnlyHint: false,
    status: "completed",
    result: (({ content, structuredContent }) => ({ content, structuredContent }))(
      recordedArtifactCallToolResult(false),
    ),
    duration: { secs: 0, nanos: 7_000_000 },
  });

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
      content: [{ type: "input_text", text: "Publish it." }],
    }),
    ...records,
  ]
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");
}

const PUBLISH_CALL = `tools.mcp__orkestrator__publish_artifact(${JSON.stringify(
  RECORDED_PUBLISH_ARTIFACT_ARGS,
)})`;
const STRICT_PUBLISH = `text(await ${PUBLISH_CALL});\n`;

function toolParts(messages: NormalizedMessage[]): NormalizedPart[] {
  return messages.flatMap((message) =>
    message.parts.filter((part) => part.type === "tool-invocation"),
  );
}

function publishParts(messages: NormalizedMessage[]): NormalizedPart[] {
  return toolParts(messages).filter((part) => publishArtifactCallContract(part).tool !== null);
}

const SHAPE_FIELDS = [
  "type",
  "content",
  "toolName",
  "toolTitle",
  "toolArgs",
  "toolUseId",
  "toolState",
  "toolOutput",
  "toolError",
  "toolDurationMs",
] as const;

function shape(part: NormalizedPart): Partial<NormalizedPart> {
  return Object.fromEntries(
    SHAPE_FIELDS.filter((field) => part[field] !== undefined).map((field) => [field, part[field]]),
  );
}

/** The live stream for the fixture's call, as app-server sends it. */
async function livePublishPart(): Promise<NormalizedPart> {
  const recorded = recordedArtifactCallToolResult(false);
  const item = {
    id: FIXTURE_ITEM,
    type: "mcpToolCall",
    server: "orkestrator",
    tool: "publish_artifact",
    arguments: { ...RECORDED_PUBLISH_ARTIFACT_ARGS },
    readOnlyHint: false,
  };
  const notify = (method: string, params: Record<string, unknown>) =>
    JSON.stringify({ jsonrpc: "2.0", method, params });
  const summary = await replayRecording([
    notify("thread/started", { thread: { id: FIXTURE_THREAD, cwd: "/replay/workspace" } }),
    notify("turn/started", { threadId: FIXTURE_THREAD, turn: { id: FIXTURE_TURN } }),
    notify("item/started", {
      threadId: FIXTURE_THREAD,
      turnId: FIXTURE_TURN,
      item: { ...item, status: "inProgress" },
    }),
    notify("item/completed", {
      threadId: FIXTURE_THREAD,
      turnId: FIXTURE_TURN,
      item: {
        ...item,
        status: "completed",
        result: {
          content: recorded.content,
          structuredContent: recorded.structuredContent,
          _meta: null,
        },
        error: null,
        durationMs: 41,
      },
    }),
    notify("turn/completed", {
      threadId: FIXTURE_THREAD,
      turn: { id: FIXTURE_TURN, status: "completed" },
    }),
  ]);
  expect(summary.unsupportedItemTypes).toEqual([]);
  const parts = summary.turns.flatMap((turn) => turn.parts);
  expect(parts).toHaveLength(1);
  return parts[0]!;
}

describe("recorded code-mode MCP calls on reload", () => {
  test("the fixture carries no secret or identity", () => {
    const { hits, totalHits } = scrub(
      readFileSync(FIXTURE_PATH, "utf8"),
      buildRedactions({ home: "/home/user", user: "user" }),
    );
    expect(hits).toEqual({});
    expect(totalHits).toBe(0);
  });

  test("a reloaded publish call matches the live part and anchors the publication", async () => {
    const messages = await hydrate(FIXTURE_THREAD, readFileSync(FIXTURE_PATH, "utf8"));
    const live = await livePublishPart();
    const reloaded = publishParts(messages);

    expect(reloaded).toHaveLength(1);
    expect(publishArtifactCallContract(live)).toEqual({ ...SUCCESSFUL_PUBLISH_CONTRACT });
    expect(publishArtifactCallContract(reloaded[0]!)).toEqual({ ...SUCCESSFUL_PUBLISH_CONTRACT });
    expect(shape(reloaded[0]!)).toEqual(shape(live));
    expect(reloaded[0]).toMatchObject({
      toolName: "publish_artifact",
      toolTitle: "orkestrator:publish_artifact",
      toolUseId: FIXTURE_ITEM,
      toolDurationMs: 41,
    });
  });

  test("the cell that only made the call gives way to it, as live, keeping one row per response", async () => {
    const messages = await hydrate(FIXTURE_THREAD, readFileSync(FIXTURE_PATH, "utf8"));

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    // Live shows no `exec` row for a cell whose calls all streamed as items.
    expect(toolParts(messages).map((part) => part.toolUseId)).toEqual([FIXTURE_ITEM]);
    expect(toolParts(messages).some((part) => part.toolUseId === FIXTURE_CELL)).toBe(false);
    expect(messages[1]!.parts.map((part) => part.toolName)).toEqual(["publish_artifact"]);
    expect(messages[2]!.content).toBe("Published the synthetic fixture chart.");
    expect(messages.every((message) => message.turnId === FIXTURE_TURN)).toBe(true);
  });

  test("a cell that also ran other recorded work keeps its exec row beside the call", async () => {
    const messages = await hydrate(
      THREAD,
      rollout([
        execCell(2, "cell-1", `await tools.exec_command({cmd:"ls"});\n${STRICT_PUBLISH}`),
        completedItem(2, { type: "CommandExecution", id: "cmd-1", command: "ls" }),
        publishRecord(3, "exec-publish-1"),
        execOutput(3, "cell-1", "Script completed\n"),
      ]),
    );

    expect(toolParts(messages).map((part) => [part.toolName, part.toolUseId])).toEqual([
      ["exec", "cell-1"],
      ["publish_artifact", "exec-publish-1"],
    ]);
    expect(publishArtifactCallContract(publishParts(messages)[0]!)).toEqual({
      ...SUCCESSFUL_PUBLISH_CONTRACT,
    });
  });

  test("a cell whose output reports a refusal keeps its exec row, as live", async () => {
    const messages = await hydrate(
      THREAD,
      rollout([
        execCell(2, "cell-1", STRICT_PUBLISH),
        publishRecord(3, "exec-publish-1"),
        execOutput(3, "cell-1", "Script failed\nPermission denied"),
      ]),
    );

    expect(toolParts(messages).map((part) => part.toolName)).toEqual(["exec", "publish_artifact"]);
  });

  test("a direct MCP call record replaces its function_call part instead of duplicating it", async () => {
    const messages = await hydrate(
      THREAD,
      rollout([
        response(2, {
          type: "function_call",
          call_id: "call-direct-1",
          name: "publish_artifact",
          namespace: "mcp__orkestrator",
          arguments: JSON.stringify(RECORDED_PUBLISH_ARTIFACT_ARGS),
        }),
        publishRecord(2, "call-direct-1"),
        response(3, {
          type: "function_call_output",
          call_id: "call-direct-1",
          output: "ignored by the recorded outcome",
        }),
      ]),
    );

    const parts = publishParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolUseId: "call-direct-1",
      toolTitle: "orkestrator:publish_artifact",
    });
    expect(publishArtifactCallContract(parts[0]!)).toEqual({ ...SUCCESSFUL_PUBLISH_CONTRACT });
  });

  test("parallel cells a record cannot be pinned to keep their rows and show it once", async () => {
    const messages = await hydrate(
      THREAD,
      rollout([
        execCell(2, "cell-1", STRICT_PUBLISH),
        execCell(2, "cell-2", STRICT_PUBLISH),
        publishRecord(3, "exec-publish-1"),
        execOutput(3, "cell-1", "Script completed\n"),
        execOutput(3, "cell-2", "Script completed\n"),
      ]),
    );

    expect(toolParts(messages).map((part) => part.toolUseId)).toEqual([
      "cell-1",
      "cell-2",
      "exec-publish-1",
    ]);
  });
});

describe("exec-cell-only fallback", () => {
  test("a strict-JSON call is shown with its arguments but no claimed outcome", async () => {
    const messages = await hydrate(
      THREAD,
      rollout([
        execCell(2, "cell-1", STRICT_PUBLISH),
        execOutput(3, "cell-1", "Script completed\n"),
      ]),
    );

    // No item was recorded, so live would show the cell too.
    expect(toolParts(messages).map((part) => part.toolName)).toEqual(["exec", "publish_artifact"]);
    const [part] = publishParts(messages);
    expect(part).toMatchObject({
      toolName: "publish_artifact",
      toolTitle: "orkestrator:publish_artifact",
      toolArgs: { ...RECORDED_PUBLISH_ARTIFACT_ARGS },
      toolUseId: "cell-1:mcp:0",
    });
    // The source never says how the call ended.
    expect(part!.toolState).toBeUndefined();
    expect(part!.toolOutput).toBeUndefined();
    expect(publishArtifactCallContract(part!)).toEqual({
      ...SUCCESSFUL_PUBLISH_CONTRACT,
      toolState: undefined,
    });
  });

  test("a failed cell marks its source-only call failed", async () => {
    const messages = await hydrate(
      THREAD,
      rollout([
        execCell(2, "cell-1", STRICT_PUBLISH),
        execOutput(3, "cell-1", "Script failed\nError: boom"),
      ]),
    );

    expect(publishParts(messages)[0]!.toolState).toBe("failure");
  });

  test("a cell an interrupt stopped leaves no row, matching the live stream", async () => {
    // Codex 0.164's code-mode interrupt records the stop as the cell's whole
    // output, as a plain string.
    const messages = await hydrate(
      THREAD,
      rollout([
        execCell(2, "cell-1", STRICT_PUBLISH),
        response(3, {
          type: "custom_tool_call_output",
          call_id: "cell-1",
          output: "aborted by user after 1.5s",
        }),
      ]),
    );

    expect(toolParts(messages)).toEqual([]);
  });

  test("an interrupted cell that recorded other work keeps its row without claiming success", async () => {
    const messages = await hydrate(
      THREAD,
      rollout([
        execCell(2, "cell-1", 'await tools.exec_command({ cmd: "sleep 30" });'),
        completedItem(3, { type: "CommandExecution", id: "exec-sleep" }),
        response(4, {
          type: "custom_tool_call_output",
          call_id: "cell-1",
          output: "aborted by user after 1.5s",
        }),
      ]),
    );

    const [exec] = toolParts(messages);
    expect(toolParts(messages).map((part) => part.toolUseId)).toEqual(["cell-1"]);
    expect(exec!.toolState).toBeUndefined();
  });

  test("a recorded call replaces the source-only one in place, never doubling it", async () => {
    const messages = await hydrate(
      THREAD,
      rollout([
        execCell(2, "cell-1", `${STRICT_PUBLISH}${STRICT_PUBLISH}`),
        publishRecord(3, "exec-publish-1"),
        execOutput(3, "cell-1", "Script completed\n"),
      ]),
    );

    // The second source call has no record, so it did not run.
    expect(toolParts(messages).map((part) => part.toolUseId)).toEqual(["exec-publish-1"]);
  });

  test("non-JSON arguments yield no tool part", async () => {
    const big = JSON.stringify({
      ...RECORDED_PUBLISH_ARTIFACT_ARGS,
      padding: "x".repeat(MAX_CODE_MODE_MCP_ARGUMENT_CHARS),
    });
    const rejected = [
      // A JS object literal, as models usually write it.
      'await tools.mcp__orkestrator__publish_artifact({artifactId:"art_fixture0001",expectedRevision:2});',
      // An expression inside otherwise JSON-looking text.
      'await tools.mcp__orkestrator__publish_artifact({"artifactId":"art_fixture0001","expectedRevision":1+1});',
      // A template literal.
      'await tools.mcp__orkestrator__publish_artifact({"artifactId":`art_${id}`,"expectedRevision":2});',
      // A second argument.
      'await tools.mcp__orkestrator__publish_artifact({"artifactId":"art_fixture0001"}, {"expectedRevision":2});',
      // Not an object.
      'await tools.mcp__orkestrator__publish_artifact(["art_fixture0001", 2]);',
      "await tools.mcp__orkestrator__publish_artifact(args);",
      // Over the size bound.
      `await tools.mcp__orkestrator__publish_artifact(${big});`,
      // Not code: a comment and a string.
      `// ${STRICT_PUBLISH}`,
      `/* ${STRICT_PUBLISH} */`,
      `const note = ${JSON.stringify(STRICT_PUBLISH)};`,
      // Not the tools namespace.
      `await my${PUBLISH_CALL};`,
      `await other.${PUBLISH_CALL};`,
    ];
    for (const [index, source] of rejected.entries()) {
      expect({ index, calls: parseCodeModeMcpCalls(source) }).toEqual({ index, calls: [] });
    }

    const messages = await hydrate(
      THREAD,
      rollout(
        rejected.flatMap((source, index) => [
          execCell(2, `cell-${index}`, source),
          execOutput(3, `cell-${index}`, "Script completed\n"),
        ]),
      ),
    );
    expect(publishParts(messages)).toEqual([]);
    expect(toolParts(messages).every((part) => part.toolName === "exec")).toBe(true);
  });

  test("the parser reads only strict JSON, bounded per cell", () => {
    expect(
      parseCodeModeMcpCalls(
        'const a = "tools.mcp__x__y({})";\nawait tools.mcp__my_server__do_thing( {"a":[1,{"b":"}"}]} );',
      ),
    ).toEqual([{ server: "my_server", tool: "do_thing", arguments: { a: [1, { b: "}" }] } }]);
    expect(
      parseCodeModeMcpCalls(STRICT_PUBLISH.repeat(MAX_CODE_MODE_MCP_CALLS_PER_CELL + 4)),
    ).toHaveLength(MAX_CODE_MODE_MCP_CALLS_PER_CELL);
    // Every unclosed argument would otherwise rescan the next 64 KiB.
    const hostile = 'tools.mcp__a__b({"k":"'.repeat(200_000);
    const started = performance.now();
    expect(parseCodeModeMcpCalls(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
