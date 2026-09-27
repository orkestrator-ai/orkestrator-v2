import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { EngineItem } from "../engine/types.js";
import type { NormalizedMessage, NormalizedPart } from "../messages/types.js";
import {
  commandChangeCwd,
  commandChangeJournalPath,
  commandChangeRole,
  commandDidNotRun,
  inheritCommandChanges,
  overlayCommandChanges,
  readCommandChanges,
  recordCommandChanges,
  withCommandChanges,
} from "./command-changes.js";

const change: MeasuredWorkspaceChange = {
  additions: 2,
  deletions: 1,
  files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
};

const temporaryDirectories: string[] = [];

async function temporaryCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "command-changes-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function command(overrides: Record<string, unknown> = {}): EngineItem {
  return {
    id: "call-1",
    type: "command_execution",
    command: "ls",
    aggregated_output: "",
    status: "completed",
    ...overrides,
  } as EngineItem;
}

function bashPart(toolUseId: string): NormalizedPart {
  return { type: "tool-invocation", toolName: "bash", toolUseId, content: "ls" };
}

describe("commandChangeRole", () => {
  test("measures the agent's own commands, from either shell tool", () => {
    expect(commandChangeRole(command())).toBe("measure");
    expect(commandChangeRole(command({ source: "agent" }))).toBe("measure");
    expect(commandChangeRole(command({ source: "unifiedExecStartup" }))).toBe("measure");
  });

  test("skips user shell commands and writes to a running process", () => {
    expect(commandChangeRole(command({ source: "userShell" }))).toBeUndefined();
    expect(commandChangeRole(command({ source: "unifiedExecInteraction" }))).toBeUndefined();
  });

  test("notes edits made by other means", () => {
    expect(
      commandChangeRole({ id: "p", type: "file_change", changes: [], status: "completed" }),
    ).toBe("note");
    expect(
      commandChangeRole({
        id: "d",
        type: "dynamic_tool_call",
        tool: "apply_patch",
        arguments: {},
        content_items: [],
        status: "completed",
      }),
    ).toBe("note");
    expect(
      commandChangeRole({
        id: "m",
        type: "mcp_tool_call",
        server: "docs",
        tool: "search",
        arguments: {},
        status: "completed",
      }),
    ).toBeUndefined();
    expect(commandChangeRole({ id: "t", type: "agent_message", text: "hi" })).toBeUndefined();
  });
});

describe("commandChangeCwd", () => {
  test("prefers the command's absolute cwd and falls back to the thread's", () => {
    expect(commandChangeCwd(command({ cwd: "/repo/sub" }), "/repo")).toBe("/repo/sub");
    expect(commandChangeCwd(command({ cwd: "file:///repo/sub" }), "/repo")).toBe("/repo/sub");
    expect(commandChangeCwd(command({ cwd: "sub" }), "/repo")).toBe("/repo");
    expect(commandChangeCwd(command(), "/repo")).toBe("/repo");
  });
});

test("commandDidNotRun recognises a failure without an exit code", () => {
  expect(commandDidNotRun(command({ status: "failed" }))).toBe(true);
  expect(commandDidNotRun(command({ status: "failed", exit_code: 1 }))).toBe(false);
  expect(commandDidNotRun(command({ status: "completed" }))).toBe(false);
});

describe("withCommandChanges", () => {
  test("replaces only the call's tool rows", () => {
    const text: NormalizedPart = { type: "text", content: "hi" };
    const parts = [text, bashPart("call-1"), bashPart("call-2")];
    const next = withCommandChanges(parts, "call-1", change);
    expect(next).not.toBe(parts);
    expect(next[0]).toBe(text);
    expect(next[1]).toEqual({ ...parts[1]!, commandChanges: change });
    expect(next[2]).toBe(parts[2]);
  });

  test("leaves parts alone for a missing or empty measurement", () => {
    const parts = [bashPart("call-1")];
    expect(withCommandChanges(parts, "call-1", undefined)).toBe(parts);
    expect(withCommandChanges(parts, "call-1", { additions: 0, deletions: 0, files: [] })).toBe(
      parts,
    );
  });
});

describe("overlayCommandChanges", () => {
  test("reaches nested sub-agent rows and reports the messages it changed", () => {
    const untouched: NormalizedMessage = {
      id: "m1",
      role: "assistant",
      content: "",
      createdAt: "2026-09-27T00:00:00.000Z",
      parts: [bashPart("call-other")],
    };
    const nested: NormalizedMessage = {
      id: "m2",
      role: "assistant",
      content: "",
      createdAt: "2026-09-27T00:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "",
          subagentActions: [bashPart("call-child")],
        },
      ],
    };
    const originalParts = nested.parts;
    const changed = overlayCommandChanges([untouched, nested], new Map([["call-child", change]]));
    expect(changed).toEqual([nested]);
    expect(nested.parts).not.toBe(originalParts);
    expect(nested.parts[0]?.subagentActions?.[0]?.commandChanges).toEqual(change);
    expect(untouched.parts[0]?.commandChanges).toBeUndefined();
  });
});

describe("journal", () => {
  test("keeps one file per thread under the bridge's sidecar directory", async () => {
    const codexHome = await temporaryCodexHome();
    expect(commandChangeJournalPath(codexHome, "thread-1")).toBe(
      join(codexHome, "orkestrator-bridge", "command-changes", "thread-1.jsonl"),
    );
    expect(commandChangeJournalPath(codexHome, "../escape")).toBe(
      join(codexHome, "orkestrator-bridge", "command-changes", ".._escape.jsonl"),
    );
    expect(commandChangeJournalPath(codexHome, "")).toBeUndefined();

    await recordCommandChanges(codexHome, "thread-1", "call-1", change);
    // Nothing worth showing is not written at all.
    await recordCommandChanges(codexHome, "thread-1", "call-2", {
      additions: 0,
      deletions: 0,
      files: [],
    });
    expect(await readCommandChanges(codexHome, "thread-1")).toEqual(new Map([["call-1", change]]));
    expect((await readCommandChanges(codexHome, "thread-2")).size).toBe(0);
  });

  test("a fork inherits its parent's measurements for the rows it kept", async () => {
    const codexHome = await temporaryCodexHome();
    await recordCommandChanges(codexHome, "parent", "call-kept", change);
    await recordCommandChanges(codexHome, "parent", "call-dropped", change);
    const messages: NormalizedMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "",
        createdAt: "2026-09-27T00:00:00.000Z",
        parts: [bashPart("call-kept")],
      },
    ];

    await inheritCommandChanges(codexHome, "parent", "fork", messages);

    expect(messages[0]?.parts[0]?.commandChanges).toEqual(change);
    expect(await readCommandChanges(codexHome, "fork")).toEqual(new Map([["call-kept", change]]));
  });
});
