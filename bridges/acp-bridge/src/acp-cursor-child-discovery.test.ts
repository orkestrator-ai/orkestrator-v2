import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Must precede every bridge import below: `acp-context.js` resolves
// `ACP_PROVIDER` at module scope and throws without it. Keep this first.
import "./testing/unit-test-env.js";
import { temporaryDirectory } from "./acp-test-harness.js";
import {
  bindDiscoveredCursorChildren,
  cursorChildTranscriptPath,
  cursorTranscriptRoot,
  discoverCursorChildTranscriptDirectories,
  isSafeCursorAgentId,
  resetCursorChildDiscoveryCache,
} from "./acp-cursor-child-discovery.js";
import {
  hydrateCursorChildTranscripts,
  listWatchableCursorChildren,
  resetCursorTranscriptReadCache,
} from "./acp-cursor-background.js";
import { cursorChildTranscriptPrompt } from "./acp-cursor-transcript-parts.js";
import {
  CURSOR_CHILD_DISCOVERY_SKEW_MS,
  sessions,
  type SessionState,
} from "./acp-context.js";
import { syncActiveSubagentTool } from "./acp-tools.js";

const LAUNCHED_AT = "1970-01-01T00:00:00.000Z";
const LAUNCHED_AT_MS = Date.parse(LAUNCHED_AT);

function makeState(launches: Array<{ toolUseId: string; createdAt?: string; agentId?: string }>) {
  const state = {
    messages: [{
      id: "message-1",
      role: "assistant" as const,
      content: "",
      createdAt: LAUNCHED_AT,
      parts: launches.map((launch) => ({
        type: "tool-invocation" as const,
        content: "Task: Subagent task",
        sourcePartId: launch.toolUseId,
        sourceMessageId: "message-1",
        toolUseId: launch.toolUseId,
        toolName: "task",
        toolTitle: "Task: Subagent task",
        toolArgs: {},
        toolState: "pending" as const,
        agentState: "active" as const,
        createdAt: launch.createdAt ?? LAUNCHED_AT,
      })),
    }],
    revision: 0,
    status: "working" as const,
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    activeSubagentToolIds: new Set(launches.map((launch) => launch.toolUseId)),
    activeSubagentDescriptors: new Map(launches.map((launch) => [
      launch.toolUseId,
      launch.agentId ? { agentId: launch.agentId } : {},
    ])),
    subagentToolIds: new Map(),
  };
  return state;
}

async function writeChildTranscript(
  root: string,
  agentId: string,
  body: string,
): Promise<number> {
  const directory = resolve(root, agentId);
  await fs.mkdir(directory, { recursive: true });
  const file = resolve(directory, `${agentId}.jsonl`);
  await fs.writeFile(file, body);
  const stats = await fs.stat(directory);
  // Match the production fallback order instead of pretending `utimes` can
  // rewrite a filesystem's creation timestamp.
  return stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs;
}

const toolRecord = (name: string) => `${JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input: {} }] },
})}\n`;

const promptRecord = (text: string) => `${JSON.stringify({
  role: "user",
  message: { content: [{ type: "text", text }] },
})}\n`;

async function withTranscriptRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = resolve(await temporaryDirectory(), "transcripts");
  await fs.mkdir(root, { recursive: true });
  const previous = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
  process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = root;
  resetCursorChildDiscoveryCache();
  resetCursorTranscriptReadCache();
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
    else process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = previous;
  }
}

describe("Cursor child transcript discovery", () => {
  afterEach(() => {
    resetCursorChildDiscoveryCache();
    resetCursorTranscriptReadCache();
  });

  test("derives the transcript root and child path from the working directory", () => {
    const previous = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
    delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
    try {
      expect(cursorTranscriptRoot("/Users/foo/bar")).toBe(
        join(homedir(), ".cursor", "projects", "Users-foo-bar", "agent-transcripts"),
      );
      expect(cursorChildTranscriptPath("abc-123", "/Users/foo/bar")).toBe(
        join(
          homedir(),
          ".cursor",
          "projects",
          "Users-foo-bar",
          "agent-transcripts",
          "abc-123",
          "abc-123.jsonl",
        ),
      );
    } finally {
      if (previous === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
      else process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = previous;
    }
  });

  test("lists child directories oldest first and ignores unsafe names", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-early", toolRecord("Read"));
      await writeChildTranscript(root, "child-late", toolRecord("Read"));
      await fs.writeFile(resolve(root, "stray-file.jsonl"), "{}\n");
      await fs.mkdir(resolve(root, ".hidden"), { recursive: true });

      expect(isSafeCursorAgentId(".hidden")).toBe(false);
      expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId))
        .toEqual(["child-early", "child-late"]);
    });
  });

  test("binds running unnamed launches to child directories in creation order", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      await writeChildTranscript(root, "child-b", toolRecord("Grep"));
      const state = makeState([
        { toolUseId: "task-1" },
        { toolUseId: "task-2", createdAt: new Date(LAUNCHED_AT_MS + 5_000).toISOString() },
      ]);

      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(true);
      expect(state.activeSubagentDescriptors.get("task-1")).toEqual({
        agentId: "child-a",
        agentIdDiscovered: true,
      });
      expect(state.activeSubagentDescriptors.get("task-2")).toEqual({
        agentId: "child-b",
        agentIdDiscovered: true,
      });
    });
  });

  // A child cannot have started before the tool call that launched it, so an
  // older directory belongs to an earlier turn and must never be adopted.
  test("never binds a directory older than the launch", async () => {
    await withTranscriptRoot(async (root) => {
      const childCreatedAtMs = await writeChildTranscript(root, "child-old", toolRecord("Read"));
      const state = makeState([{
        toolUseId: "task-1",
        createdAt: new Date(
          childCreatedAtMs + CURSOR_CHILD_DISCOVERY_SKEW_MS + 1_000,
        ).toISOString(),
      }]);

      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(false);
      expect(state.activeSubagentDescriptors.get("task-1")).toEqual({});
    });
  });

  test("leaves a launch Cursor already named alone and does not reuse its child", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const state = makeState([
        { toolUseId: "task-1", agentId: "child-a" },
        { toolUseId: "task-2" },
      ]);

      // `child-a` is claimed by the named launch, and it is the only directory,
      // so the unnamed launch stays unbound rather than sharing it.
      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(false);
      expect(state.activeSubagentDescriptors.get("task-1")).toEqual({ agentId: "child-a" });
      expect(state.activeSubagentDescriptors.get("task-2")).toEqual({});
    });
  });

  test("skips a launch with no recorded start time", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const state = makeState([{ toolUseId: "task-1" }]);
      delete (state.messages[0]!.parts[0] as { createdAt?: string }).createdAt;

      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(false);
      expect(state.activeSubagentDescriptors.get("task-1")).toEqual({});
    });
  });

  test("projects a discovered child's activity and prompt onto its live card", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(
        root,
        "child-a",
        promptRecord("<timestamp>now</timestamp>\n<user_query>\nAudit the OpenCode surface.\n</user_query>")
          + toolRecord("Read"),
      );
      const state = makeState([{ toolUseId: "task-1" }]);

      hydrateCursorChildTranscripts(state as unknown as SessionState);

      const parts = state.messages[0]!.parts as Array<Record<string, unknown>>;
      // The opening user record carries the prompt, not projected activity, so
      // the child's first assistant record is projection record 0.
      expect(parts.map((part) => part.sourcePartId)).toEqual([
        "task-1",
        "cursor-jsonl:child-a:0:0",
      ]);
      expect(parts[1]).toMatchObject({
        type: "tool-invocation",
        toolName: "Read",
        // The child is still live, so its trailing tool has not reported yet.
        toolState: "pending",
        parentTaskUseId: "task-1",
      });
      // The card was anonymous until this: a foreground launch carries no
      // description or prompt of its own while the child runs.
      expect(parts[0]).toMatchObject({
        toolArgs: { prompt: "Audit the OpenCode surface." },
      });
    });
  });

  test("keeps a child claimed by another live session out of discovery", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const owner = makeState([{ toolUseId: "owner-task", agentId: "child-a" }]);
      const contender = makeState([{ toolUseId: "contender-task" }]);
      const sessionKey = `cursor-discovery-test:${root}`;
      const previous = sessions.get(sessionKey);
      sessions.set(sessionKey, owner as unknown as SessionState);
      try {
        expect(bindDiscoveredCursorChildren(contender as unknown as SessionState)).toBe(false);
        expect(contender.activeSubagentDescriptors.get("contender-task")).toEqual({});
      } finally {
        if (previous) sessions.set(sessionKey, previous);
        else sessions.delete(sessionKey);
      }
    });
  });

  test("invalidates the directory cache when a new child appears", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId))
        .toEqual(["child-a"]);

      await writeChildTranscript(root, "child-b", toolRecord("Grep"));
      // Filesystems have different timestamp granularity. Force a distinct root
      // mtime so this test targets the cache contract rather than the host clock.
      const rootStats = await fs.stat(root);
      await fs.utimes(root, rootStats.atime, new Date(rootStats.mtimeMs + 2_000));

      expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId))
        .toEqual(["child-a", "child-b"]);
    });
  });

  test("promotes a reported live child id to continuation-safe authority", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-discovered", toolRecord("Read"));
      await writeChildTranscript(root, "child-reported", toolRecord("Grep"));
      const state = makeState([{ toolUseId: "task-1" }]);

      hydrateCursorChildTranscripts(state as unknown as SessionState);
      expect(state.activeSubagentDescriptors.get("task-1")).toMatchObject({
        agentId: "child-discovered",
        agentIdDiscovered: true,
      });

      const launch = state.messages[0]!.parts[0]!;
      launch.toolArgs = { ...launch.toolArgs, agentId: "child-reported" };
      syncActiveSubagentTool(
        state as unknown as SessionState,
        launch,
      );

      expect(state.activeSubagentDescriptors.get("task-1")).toMatchObject({
        agentId: "child-reported",
        agentIdDiscovered: false,
      });
      expect(listWatchableCursorChildren(
        state as unknown as SessionState,
        { includeDiscovered: false },
      ).map((child) => child.agentId)).toEqual(["child-reported"]);
    });
  });

  // The inference can pair the wrong directory when a child never writes one.
  // Whatever Cursor eventually reports wins, and the superseded projection goes
  // with it rather than doubling the card's activity.
  test("re-anchors a card when the reported agentId supersedes a discovered one", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      await writeChildTranscript(
        root,
        "child-b",
        `${toolRecord("Grep")}${JSON.stringify({ type: "turn_ended", status: "success" })}\n`,
      );
      const state = makeState([{ toolUseId: "task-1" }]);

      hydrateCursorChildTranscripts(state as unknown as SessionState);
      expect((state.messages[0]!.parts as Array<Record<string, unknown>>)
        .map((part) => part.sourcePartId))
        .toEqual(["task-1", "cursor-jsonl:child-a:0:0"]);

      // Cursor reports the real child as the launch settles.
      const launch = state.messages[0]!.parts[0] as Record<string, unknown>;
      launch.toolArgs = { agentId: "child-b" };
      launch.agentState = "finished";
      launch.toolState = "success";
      state.activeSubagentToolIds.clear();
      state.activeSubagentDescriptors.clear();
      resetCursorTranscriptReadCache();

      hydrateCursorChildTranscripts(state as unknown as SessionState);

      const parts = state.messages[0]!.parts as Array<Record<string, unknown>>;
      expect(parts.map((part) => part.sourcePartId)).toEqual([
        "task-1",
        "cursor-jsonl:child-b:0:0",
      ]);
      expect(parts[1]).toMatchObject({ toolName: "Grep", toolState: "success" });
    });
  });

  test("recovers the prompt from a child's opening record", () => {
    expect(cursorChildTranscriptPrompt(promptRecord(
      "<timestamp>Sunday</timestamp>\n<user_query>\nInventory the Codex surface.\n</user_query>",
    ))).toBe("Inventory the Codex surface.");
    // No envelope: the record's own text stands, minus the timestamp.
    expect(cursorChildTranscriptPrompt(promptRecord("<timestamp>Sunday</timestamp>\nJust do it.")))
      .toBe("Just do it.");
    // A tail read that lost the head has no prompt to recover.
    expect(cursorChildTranscriptPrompt(toolRecord("Read"))).toBeUndefined();
    expect(cursorChildTranscriptPrompt("{\"role\":\"user\",\"mess")).toBeUndefined();
  });
});
