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
import { CURSOR_CHILD_DISCOVERY_SKEW_MS, sessions, type SessionState } from "./acp-context.js";
import { syncActiveSubagentTool } from "./acp-tools.js";

const LAUNCHED_AT = "1970-01-01T00:00:00.000Z";
const LAUNCHED_AT_MS = Date.parse(LAUNCHED_AT);

function makeState(launches: Array<{ toolUseId: string; createdAt?: string; agentId?: string }>) {
  const state = {
    messages: [
      {
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
      },
    ],
    revision: 0,
    status: "working" as const,
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    activeSubagentToolIds: new Set(launches.map((launch) => launch.toolUseId)),
    activeSubagentDescriptors: new Map(
      launches.map((launch) => [
        launch.toolUseId,
        launch.agentId ? { agentId: launch.agentId } : {},
      ]),
    ),
    subagentToolIds: new Map(),
  };
  return state;
}

function settleNamedLaunch(
  state: ReturnType<typeof makeState>,
  toolUseId: string,
  agentId: string,
): void {
  const part = state.messages[0]!.parts.find((candidate) => candidate.toolUseId === toolUseId);
  if (!part) throw new Error(`missing launch ${toolUseId}`);
  part.toolArgs = { ...part.toolArgs, agentId };
  part.agentState = "finished";
  part.toolState = "success";
  state.activeSubagentToolIds.delete(toolUseId);
  state.activeSubagentDescriptors.delete(toolUseId);
}

function addUnnamedLaunch(
  state: ReturnType<typeof makeState>,
  toolUseId: string,
  createdAt: string = LAUNCHED_AT,
): void {
  state.messages[0]!.parts.push({
    type: "tool-invocation",
    content: "Task: Subagent task",
    sourcePartId: toolUseId,
    sourceMessageId: "message-1",
    toolUseId,
    toolName: "task",
    toolTitle: "Task: Subagent task",
    toolArgs: {},
    toolState: "pending",
    agentState: "active",
    createdAt,
  });
  state.activeSubagentToolIds.add(toolUseId);
  state.activeSubagentDescriptors.set(toolUseId, {});
}

/** Pushes a part whose shape differs from the launch parts `makeState` builds. */
function addRawPart(state: ReturnType<typeof makeState>, part: Record<string, unknown>): void {
  (state.messages[0]!.parts as unknown as Array<Record<string, unknown>>).push(part);
}

/**
 * Registers states in the process-wide session registry for the duration of
 * `run`, restoring whatever was there before. `bindDiscoveredCursorChildren`
 * reads every session in that registry, so a leaked entry would follow the
 * suite into unrelated tests.
 */
function withSessions<T>(entries: Array<[string, ReturnType<typeof makeState>]>, run: () => T): T {
  const restore = entries.map(([key]) => [key, sessions.get(key)] as const);
  for (const [key, state] of entries) sessions.set(key, state as unknown as SessionState);
  try {
    return run();
  } finally {
    for (const [key, previous] of restore) {
      if (previous) sessions.set(key, previous);
      else sessions.delete(key);
    }
  }
}

async function writeChildTranscript(root: string, agentId: string, body: string): Promise<number> {
  const directory = resolve(root, agentId);
  await fs.mkdir(directory, { recursive: true });
  const file = resolve(directory, `${agentId}.jsonl`);
  await fs.writeFile(file, body);
  const stats = await fs.stat(directory);
  // Match the production fallback order instead of pretending `utimes` can
  // rewrite a filesystem's creation timestamp.
  return stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs;
}

const toolRecord = (name: string) =>
  `${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: {} }] },
  })}\n`;

const promptRecord = (text: string) =>
  `${JSON.stringify({
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
      expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId)).toEqual([
        "child-early",
        "child-late",
      ]);
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
      const state = makeState([
        {
          toolUseId: "task-1",
          createdAt: new Date(
            childCreatedAtMs + CURSOR_CHILD_DISCOVERY_SKEW_MS + 1_000,
          ).toISOString(),
        },
      ]);

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

  // A foreground Task is named only as it settles, and settling deletes the
  // live descriptor. The time floor still admits that directory for the next
  // unnamed launch, so the claimed set must keep reading `agentId` off the card.
  test("never reuses a settled child's directory for a later unnamed launch", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const state = makeState([{ toolUseId: "task-1", agentId: "child-a" }]);
      settleNamedLaunch(state, "task-1", "child-a");
      addUnnamedLaunch(state, "task-2");

      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(false);
      expect(state.activeSubagentDescriptors.get("task-2")).toEqual({});
    });
  });

  test("binds a later unnamed launch to the next directory after a settled sibling", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      await writeChildTranscript(root, "child-b", toolRecord("Grep"));
      const state = makeState([{ toolUseId: "task-1", agentId: "child-a" }]);
      settleNamedLaunch(state, "task-1", "child-a");
      addUnnamedLaunch(state, "task-2");

      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(true);
      expect(state.activeSubagentDescriptors.get("task-2")).toEqual({
        agentId: "child-b",
        agentIdDiscovered: true,
      });
    });
  });

  test("keeps a settled child from another session out of discovery", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const owner = makeState([{ toolUseId: "owner-task", agentId: "child-a" }]);
      settleNamedLaunch(owner, "owner-task", "child-a");
      const contender = makeState([{ toolUseId: "contender-task" }]);
      withSessions([[`cursor-discovery-test:${root}`, owner]], () => {
        expect(bindDiscoveredCursorChildren(contender as unknown as SessionState)).toBe(false);
        expect(contender.activeSubagentDescriptors.get("contender-task")).toEqual({});
      });
    });
  });

  // Discovery can bind a card before `cursor/task` names it. Settling then
  // drops the descriptor; the JSONL projection still names the child, and that
  // must keep the directory claimed.
  test("does not rebind a directory already projected onto a settled card", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const state = makeState([{ toolUseId: "task-1" }]);
      hydrateCursorChildTranscripts(state as unknown as SessionState);
      expect(state.activeSubagentDescriptors.get("task-1")).toMatchObject({
        agentId: "child-a",
        agentIdDiscovered: true,
      });

      const launch = state.messages[0]!.parts[0] as {
        agentState: string;
        toolState: string;
      };
      launch.agentState = "finished";
      launch.toolState = "success";
      state.activeSubagentToolIds.clear();
      state.activeSubagentDescriptors.clear();
      addUnnamedLaunch(state, "task-2");

      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(false);
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
        promptRecord(
          "<timestamp>now</timestamp>\n<user_query>\nAudit the OpenCode surface.\n</user_query>",
        ) + toolRecord("Read"),
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

  test("excludes a discovered-only child from the continuation waiter", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const state = makeState([{ toolUseId: "task-1" }]);

      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(true);
      expect(
        listWatchableCursorChildren(state as unknown as SessionState, { includeDiscovered: false }),
      ).toEqual([]);
      expect(
        listWatchableCursorChildren(state as unknown as SessionState).map((child) => child.agentId),
      ).toEqual(["child-a"]);
    });
  });

  test("keeps a child claimed by another live session out of discovery", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const owner = makeState([{ toolUseId: "owner-task", agentId: "child-a" }]);
      const contender = makeState([{ toolUseId: "contender-task" }]);
      withSessions([[`cursor-discovery-test:${root}`, owner]], () => {
        expect(bindDiscoveredCursorChildren(contender as unknown as SessionState)).toBe(false);
        expect(contender.activeSubagentDescriptors.get("contender-task")).toEqual({});
      });
    });
  });

  // Two tabs can launch anonymous foreground Tasks within the skew window, and
  // an unnamed peer reserves nothing by name — it has no name yet. Pairing per
  // session therefore let whichever tab polled first take the other's child, so
  // the pass has to be computed over every session's unnamed launches.
  test("does not take a peer session's directory for its own unnamed launch", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      await writeChildTranscript(root, "child-b", toolRecord("Grep"));
      const early = makeState([{ toolUseId: "peer-task" }]);
      const late = makeState([
        {
          toolUseId: "task-1",
          createdAt: new Date(LAUNCHED_AT_MS + 1_000).toISOString(),
        },
      ]);

      withSessions(
        [
          [`cursor-discovery-early:${root}`, early],
          [`cursor-discovery-late:${root}`, late],
        ],
        () => {
          // The later session polls first. The earlier peer launched first, so
          // the older directory is still its child.
          expect(bindDiscoveredCursorChildren(late as unknown as SessionState)).toBe(true);
          expect(late.activeSubagentDescriptors.get("task-1")).toEqual({
            agentId: "child-b",
            agentIdDiscovered: true,
          });
          // The peer's candidate was reserved, not written: one tab's read must
          // not mutate another tab's state.
          expect(early.activeSubagentDescriptors.get("peer-task")).toEqual({});

          // The peer's own poll re-derives the same pairing.
          expect(bindDiscoveredCursorChildren(early as unknown as SessionState)).toBe(true);
          expect(early.activeSubagentDescriptors.get("peer-task")).toEqual({
            agentId: "child-a",
            agentIdDiscovered: true,
          });
        },
      );
    });
  });

  // Only a Task card can carry a Cursor `agentId`. Reading one off every tool
  // part would also mean parsing every tool's output as JSON on a route a
  // visible tab polls twice a second.
  test("ignores an agentId on a tool call that was never a sub-agent launch", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      const state = makeState([{ toolUseId: "task-1" }]);
      addRawPart(state, {
        type: "tool-invocation",
        content: "Read",
        sourcePartId: "read-1",
        sourceMessageId: "message-1",
        toolUseId: "read-1",
        toolName: "Read",
        toolTitle: "Read",
        toolArgs: { agentId: "child-a" },
        toolState: "success",
        createdAt: LAUNCHED_AT,
      });

      expect(bindDiscoveredCursorChildren(state as unknown as SessionState)).toBe(true);
      expect(state.activeSubagentDescriptors.get("task-1")).toEqual({
        agentId: "child-a",
        agentIdDiscovered: true,
      });
    });
  });

  test("invalidates the directory cache when a new child appears", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId)).toEqual([
        "child-a",
      ]);

      await writeChildTranscript(root, "child-b", toolRecord("Grep"));
      // Filesystems have different timestamp granularity. Force a distinct root
      // mtime so this test targets the cache contract rather than the host clock.
      const rootStats = await fs.stat(root);
      await fs.utimes(root, rootStats.atime, new Date(rootStats.mtimeMs + 2_000));

      expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId)).toEqual([
        "child-a",
        "child-b",
      ]);
    });
  });

  // The cap bounds one scan's syscalls. It truncates in directory-read order,
  // before the sort, so which entries survive is deliberately unspecified —
  // only the bound is contractual.
  test("stops scanning at the entry cap", async () => {
    await withTranscriptRoot(async (root) => {
      for (const agentId of ["child-a", "child-b", "child-c"]) {
        await writeChildTranscript(root, agentId, toolRecord("Read"));
      }

      expect(discoverCursorChildTranscriptDirectories(2)).toHaveLength(2);
      // A bounded scan must not be served back to an unbounded one.
      expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId)).toEqual([
        "child-a",
        "child-b",
        "child-c",
      ]);
    });
  });

  // A root that becomes unreadable is transient. Dropping the cached list would
  // unclaim every directory in it and invite a rebind onto a live child.
  test("keeps the cached listing when the root cannot be read", async () => {
    if ((process.getuid?.() ?? 0) === 0) {
      // Mode bits do not stop root, so this branch cannot be provoked here.
      return;
    }
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(root, "child-a", toolRecord("Read"));
      expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId)).toEqual([
        "child-a",
      ]);

      // Change the root's mtime so the cache is invalidated, then take away
      // the read permission the rescan needs.
      await writeChildTranscript(root, "child-b", toolRecord("Grep"));
      const rootStats = await fs.stat(root);
      await fs.utimes(root, rootStats.atime, new Date(rootStats.mtimeMs + 2_000));
      await fs.chmod(root, 0o000);
      try {
        expect(discoverCursorChildTranscriptDirectories().map((child) => child.agentId)).toEqual([
          "child-a",
        ]);
      } finally {
        await fs.chmod(root, 0o700);
      }
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
      // A guessed id is good enough to project activity, not to hold the parent
      // turn open. The continuation waiter must not see this child yet.
      expect(
        listWatchableCursorChildren(state as unknown as SessionState, { includeDiscovered: false }),
      ).toEqual([]);
      expect(
        listWatchableCursorChildren(state as unknown as SessionState).map((child) => child.agentId),
      ).toEqual(["child-discovered"]);

      const launch = state.messages[0]!.parts[0]!;
      launch.toolArgs = { ...launch.toolArgs, agentId: "child-reported" };
      syncActiveSubagentTool(state as unknown as SessionState, launch);

      expect(state.activeSubagentDescriptors.get("task-1")).toMatchObject({
        agentId: "child-reported",
        agentIdDiscovered: false,
      });
      expect(
        listWatchableCursorChildren(state as unknown as SessionState, {
          includeDiscovered: false,
        }).map((child) => child.agentId),
      ).toEqual(["child-reported"]);
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
      expect(
        (state.messages[0]!.parts as Array<Record<string, unknown>>).map(
          (part) => part.sourcePartId,
        ),
      ).toEqual(["task-1", "cursor-jsonl:child-a:0:0"]);

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

  // The recovered prompt is a stand-in for a card Cursor has not described. A
  // prompt Cursor did report is authoritative and must survive every later read
  // of the child's transcript.
  test("never overwrites a reported prompt with one recovered from the transcript", async () => {
    await withTranscriptRoot(async (root) => {
      await writeChildTranscript(
        root,
        "child-a",
        promptRecord("<user_query>\nRecovered stand-in.\n</user_query>") + toolRecord("Read"),
      );
      const state = makeState([{ toolUseId: "task-1", agentId: "child-a" }]);
      const launch = state.messages[0]!.parts[0]!;
      launch.toolArgs = { agentId: "child-a", prompt: "The prompt Cursor reported." };

      hydrateCursorChildTranscripts(state as unknown as SessionState);
      // A second read, with the read cache dropped, is the one that would
      // re-run recovery against an already-labelled card.
      resetCursorTranscriptReadCache();
      hydrateCursorChildTranscripts(state as unknown as SessionState);

      const parts = state.messages[0]!.parts as Array<Record<string, unknown>>;
      expect(parts[0]).toMatchObject({ toolArgs: { prompt: "The prompt Cursor reported." } });
      // The child's activity still projects; only the label is left alone.
      expect(parts.map((part) => part.sourcePartId)).toEqual([
        "task-1",
        "cursor-jsonl:child-a:0:0",
      ]);
    });
  });

  test("recovers the prompt from a child's opening record", () => {
    expect(
      cursorChildTranscriptPrompt(
        promptRecord(
          "<timestamp>Sunday</timestamp>\n<user_query>\nInventory the Codex surface.\n</user_query>",
        ),
      ),
    ).toBe("Inventory the Codex surface.");
    // No envelope: the record's own text stands, minus the timestamp.
    expect(
      cursorChildTranscriptPrompt(promptRecord("<timestamp>Sunday</timestamp>\nJust do it.")),
    ).toBe("Just do it.");
    // A tail read that lost the head has no prompt to recover.
    expect(cursorChildTranscriptPrompt(toolRecord("Read"))).toBeUndefined();
    expect(cursorChildTranscriptPrompt('{"role":"user","mess')).toBeUndefined();
  });
});
