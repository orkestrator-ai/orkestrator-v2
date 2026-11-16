import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_JOURNAL_ENTRIES } from "@orkestrator/protocol/node/command-change-journal";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { EngineItem } from "../engine/types.js";
import type { NormalizedMessage, NormalizedPart } from "../messages/types.js";
import {
  adoptLoginCommandChanges,
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
  test("an added account records in the shared state and adopts its earlier badges once", async () => {
    const host = await temporaryCodexHome();
    const account = await temporaryCodexHome();
    const saved = process.env.CODEX_BRIDGE_STATE_DIR;
    const later: MeasuredWorkspaceChange = { ...change, additions: change.additions + 1 };
    const source = join(account, "orkestrator-bridge", "command-changes");
    try {
      delete process.env.CODEX_BRIDGE_STATE_DIR;
      await recordCommandChanges(account, "thread-1", "call-old", change);
      await recordCommandChanges(account, "thread-1", "call-both", change);

      process.env.CODEX_BRIDGE_STATE_DIR = join(host, "orkestrator-bridge");
      expect(commandChangeJournalPath(account, "thread-1")).toBe(
        join(host, "orkestrator-bridge", "command-changes", "thread-1.jsonl"),
      );
      await recordCommandChanges(account, "thread-1", "call-both", later);
      await recordCommandChanges(account, "thread-1", "call-new", change);
      // Reads never look at the login's own journal.
      expect((await readCommandChanges(account, "thread-1")).has("call-old")).toBe(false);

      expect(await adoptLoginCommandChanges(account, source)).toBe(1);
      const expected = new Map([
        ["call-both", later],
        ["call-new", change],
        ["call-old", change],
      ]);
      expect(await readCommandChanges(account, "thread-1")).toEqual(expected);
      expect(existsSync(source)).toBe(false);
      expect(existsSync(`${source}.adopted`)).toBe(true);
      expect(await adoptLoginCommandChanges(account, source)).toBe(0);
      expect(await readCommandChanges(account, "thread-1")).toEqual(expected);
    } finally {
      if (saved === undefined) delete process.env.CODEX_BRIDGE_STATE_DIR;
      else process.env.CODEX_BRIDGE_STATE_DIR = saved;
    }
  });

  test("adoption past the per-start limit carries on at the next start", async () => {
    const host = await temporaryCodexHome();
    const account = await temporaryCodexHome();
    const saved = process.env.CODEX_BRIDGE_STATE_DIR;
    const source = join(account, "orkestrator-bridge", "command-changes");
    const threads = ["thread-a", "thread-b", "thread-c"];
    try {
      delete process.env.CODEX_BRIDGE_STATE_DIR;
      for (const thread of threads)
        await recordCommandChanges(account, thread, `call-${thread}`, change);

      process.env.CODEX_BRIDGE_STATE_DIR = join(host, "orkestrator-bridge");
      // A limit of two stands in for MAX_ADOPTED_COMMAND_CHANGE_JOURNALS + 1 journals.
      expect(await adoptLoginCommandChanges(account, source, 2)).toBe(2);
      expect(existsSync(source)).toBe(true);
      expect((await readdir(source)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);

      expect(await adoptLoginCommandChanges(account, source, 2)).toBe(1);
      expect(existsSync(source)).toBe(false);
      expect(existsSync(`${source}.adopted`)).toBe(true);
      for (const thread of threads) {
        expect(await readCommandChanges(account, thread)).toEqual(
          new Map([[`call-${thread}`, change]]),
        );
      }
      expect(await adoptLoginCommandChanges(account, source, 2)).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.CODEX_BRIDGE_STATE_DIR;
      else process.env.CODEX_BRIDGE_STATE_DIR = saved;
    }
  });

  test("a login journal that cannot be read stays for the next start", async () => {
    const host = await temporaryCodexHome();
    const account = await temporaryCodexHome();
    const saved = process.env.CODEX_BRIDGE_STATE_DIR;
    const source = join(account, "orkestrator-bridge", "command-changes");
    const stash = join(account, "stash");
    try {
      delete process.env.CODEX_BRIDGE_STATE_DIR;
      await recordCommandChanges(account, "thread-1", "call-old", change);
      await recordCommandChanges(account, "thread-2", "call-other", change);
      // thread-1's journal becomes a link to a directory: reading it fails.
      await mkdir(stash);
      await rename(join(source, "thread-1.jsonl"), join(stash, "journal"));
      await mkdir(join(stash, "unreadable"));
      await symlink(join(stash, "unreadable"), join(source, "thread-1.jsonl"));

      process.env.CODEX_BRIDGE_STATE_DIR = join(host, "orkestrator-bridge");
      await expect(adoptLoginCommandChanges(account, source)).rejects.toThrow(/next start/);
      expect(existsSync(join(source, "thread-1.jsonl"))).toBe(true);
      expect(existsSync(`${source}.adopted`)).toBe(false);
      // The readable journal was still merged and retired.
      expect(await readCommandChanges(account, "thread-2")).toEqual(
        new Map([["call-other", change]]),
      );
      expect(existsSync(join(source, "thread-2.jsonl"))).toBe(false);

      // Once the journal reads again, the next start imports its badges.
      await rm(join(stash, "unreadable"), { recursive: true });
      await rename(join(stash, "journal"), join(stash, "unreadable"));
      expect(await adoptLoginCommandChanges(account, source)).toBe(1);
      expect(await readCommandChanges(account, "thread-1")).toEqual(
        new Map([["call-old", change]]),
      );
      expect(existsSync(source)).toBe(false);
      expect(existsSync(`${source}.adopted`)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CODEX_BRIDGE_STATE_DIR;
      else process.env.CODEX_BRIDGE_STATE_DIR = saved;
    }
  });

  test("a merge that cannot be published keeps the login journal for the next start", async () => {
    const host = await temporaryCodexHome();
    const account = await temporaryCodexHome();
    const saved = process.env.CODEX_BRIDGE_STATE_DIR;
    const source = join(account, "orkestrator-bridge", "command-changes");
    const target = join(host, "orkestrator-bridge", "command-changes");
    try {
      delete process.env.CODEX_BRIDGE_STATE_DIR;
      await recordCommandChanges(account, "thread-1", "call-old", change);

      process.env.CODEX_BRIDGE_STATE_DIR = join(host, "orkestrator-bridge");
      // The shared directory's path is taken by a file, so nothing can be written there.
      await mkdir(join(host, "orkestrator-bridge"), { recursive: true });
      await writeFile(target, "");
      await expect(adoptLoginCommandChanges(account, source)).rejects.toThrow(/next start/);
      expect(existsSync(join(source, "thread-1.jsonl"))).toBe(true);
      expect(existsSync(`${source}.adopted`)).toBe(false);

      await rm(target);
      expect(await adoptLoginCommandChanges(account, source)).toBe(1);
      expect(await readCommandChanges(account, "thread-1")).toEqual(
        new Map([["call-old", change]]),
      );
      expect(existsSync(`${source}.adopted`)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CODEX_BRIDGE_STATE_DIR;
      else process.env.CODEX_BRIDGE_STATE_DIR = saved;
    }
  });

  test("adopted measurements never evict the shared journal's own at the entry limit", async () => {
    const host = await temporaryCodexHome();
    const account = await temporaryCodexHome();
    const saved = process.env.CODEX_BRIDGE_STATE_DIR;
    const source = join(account, "orkestrator-bridge", "command-changes");
    const line = (id: string) => `${JSON.stringify({ id, change })}\n`;
    try {
      // 1,000 current measurements (the journal's limit) and five older ones.
      const target = join(host, "orkestrator-bridge", "command-changes");
      await mkdir(target, { recursive: true });
      const currentIds = Array.from(
        { length: MAX_JOURNAL_ENTRIES },
        (_, index) => `current-${index}`,
      );
      await writeFile(join(target, "thread-1.jsonl"), currentIds.map(line).join(""));
      await mkdir(source, { recursive: true });
      const olderIds = Array.from({ length: 5 }, (_, index) => `older-${index}`);
      await writeFile(join(source, "thread-1.jsonl"), olderIds.map(line).join(""));

      process.env.CODEX_BRIDGE_STATE_DIR = join(host, "orkestrator-bridge");
      expect(await adoptLoginCommandChanges(account, source)).toBe(1);
      const records = await readCommandChanges(account, "thread-1");
      expect(records.size).toBe(MAX_JOURNAL_ENTRIES);
      expect(Array.from(records.keys())).toEqual(currentIds);
      // A restart reads the same bounded journal from disk.
      const lines = (await Bun.file(join(target, "thread-1.jsonl")).text()).trim().split("\n");
      expect(lines).toHaveLength(MAX_JOURNAL_ENTRIES);
    } finally {
      if (saved === undefined) delete process.env.CODEX_BRIDGE_STATE_DIR;
      else process.env.CODEX_BRIDGE_STATE_DIR = saved;
    }
  });

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
