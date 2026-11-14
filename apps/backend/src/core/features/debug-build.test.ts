import { beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import {
  DEBUG_BUILD_SCREENSHOT_FILENAME,
  DEBUG_BUILD_TRANSCRIPT_COMMENT_MAX_CHARS,
  DEBUG_BUILD_TRANSCRIPT_MAX_CHARS,
  type DebugTranscriptMessage,
} from "@orkestrator/protocol/debug-build";
import { StorageService } from "../storage.js";
import type { Environment, Project } from "../models.js";
import { FeatureBuildTasks } from "./build-tasks.js";
import { createDebugBuild, type DebugBuildPorts } from "./debug-build.js";
import {
  debugSourceTabs,
  frontTabId,
  readDebugTabTranscript,
  type DebugTabTranscript,
} from "./debug-build-transcript.js";

let runtime = { featureBuilds: new FeatureBuildTasks() };
beforeEach(() => {
  runtime = { featureBuilds: new FeatureBuildTasks() };
});

/**
 * A supervisor that admits through real storage, as the real one does: a
 * start whose admission key an active pipeline holds gets that pipeline back,
 * and a start after the pipeline completed or failed creates a new one.
 */
function fakeSupervisor(storage: StorageService) {
  const started: StartBuildPipelineInput[] = [];
  let next = 0;
  const start = async (input: StartBuildPipelineInput) => {
    started.push(input);
    next += 1;
    const id = `pipeline-${next}`;
    const record = await storage.saveBuildPipeline(
      id,
      input.projectId,
      "",
      1,
      {
        id,
        projectId: input.projectId,
        taskId: input.taskId,
        source: input.source,
        phase: "build",
        admissionKey: `kanban:${input.taskId}`,
        createdAt: new Date(Date.UTC(2026, 10, 14, 12, next)).toISOString(),
      },
      0,
    );
    return { id: record.id, environmentId: record.environmentId };
  };
  return { started, start, service: { start } as never };
}

async function setPipelinePhase(storage: StorageService, pipelineId: string, phase: string) {
  const record = (await storage.getBuildPipeline(pipelineId))!;
  await storage.saveBuildPipeline(
    record.id,
    record.projectId,
    record.environmentId,
    record.version,
    { ...(record.snapshot as Record<string, unknown>), phase },
    record.revision,
  );
}

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function withStorage(run: (storage: StorageService) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-debug-build-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: "project-1",
    name: "acme",
    gitUrl: "https://example.invalid/acme.git",
    localPath: "/tmp/acme",
    addedAt: new Date(0).toISOString(),
    order: 0,
  } as Project);
  await storage.addEnvironment({
    id: "env-source",
    projectId: "project-1",
    name: "settings-dialog",
    branch: "settings-dialog",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-11-14T09:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/acme-worktrees/settings-dialog",
  } as unknown as Environment);
  try {
    await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const transcriptMessages: DebugTranscriptMessage[] = [
  { role: "user", createdAt: null, text: "Open settings", textTruncated: false, parts: [] },
  {
    role: "assistant",
    createdAt: null,
    text: "The dialog did not open.",
    textTruncated: false,
    parts: [{ type: "tool", toolName: "Bash", status: "completed", title: "bun test" }],
  },
];
const transcript: DebugTabTranscript = {
  status: "read",
  complete: true,
  messages: transcriptMessages,
};

function ports(overrides: Partial<DebugBuildPorts> = {}): DebugBuildPorts & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    sourceTabs: async () => [
      { tabId: "tab-front", agent: "claude", title: "Main", front: true },
      { tabId: "tab-other", agent: "codex", title: null, front: false },
    ],
    readTranscript: async (_environmentId, tabId) => {
      reads.push(tabId);
      return tabId === "tab-front" ? transcript : { status: "empty" };
    },
    now: () => new Date("2026-11-14T10:00:00.000Z"),
    ...overrides,
  };
}

const screenshot = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
).toString("base64");

describe("createDebugBuild", () => {
  test("files the user's text, the source details, transcript and screenshot, and launches one pipeline", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const result = await createDebugBuild(
        {
          environmentId: "env-source",
          problem: "The settings dialog does not open from the toolbar.",
          expectedResult: "- Clicking the cog opens settings\n- Escape closes it",
          screenshot,
          requestId: "request-1",
        },
        { storage, runtime, buildPipelines: supervisor.service },
        ports(),
      );

      expect(result.projectId).toBe("project-1");
      expect(supervisor.started).toHaveLength(1);
      const task = await storage.kanban.getKanbanTask(result.taskId);
      expect(task?.title).toBe("The settings dialog does not open from the toolbar");
      expect(task?.status).toBe("in-progress");
      expect(task?.description).toContain("The settings dialog does not open from the toolbar.");
      expect(task?.description).toContain("Environment ID: `env-source`");
      expect(task?.description).toContain("Branch: `settings-dialog`");
      expect(task?.description).toContain("Captured: 2026-11-14T10:00:00.000Z");
      expect(task?.acceptanceCriteria).toContain("Clicking the cog opens settings");
      expect(task?.acceptanceCriteria).toContain("Escape closes it");
      // One transcript comment, for the tab that had a conversation.
      expect(task?.comments).toHaveLength(1);
      expect(task?.comments[0]?.text).toContain("Source transcript");
      expect(task?.comments[0]?.text).toContain("The dialog did not open.");
      expect(task?.comments[0]?.text).toContain("`Bash` (completed): bun test");
      expect(task?.images.map((image) => image.filename)).toEqual([
        DEBUG_BUILD_SCREENSHOT_FILENAME,
      ]);

      const started = supervisor.started[0]!;
      expect(started.source).toEqual({ type: "kanban", taskId: result.taskId });
      expect(started.taskSnapshot.description).toBe(task!.description);
      expect(started.taskSnapshot.comments).toHaveLength(1);
      expect(started.taskSnapshot.images).toHaveLength(1);
      // The project has a checkout and no last choice: the source's local type.
      expect(started.environmentType).toBe("local");
      // Nothing beyond the one pipeline: no environment was named for reuse.
      expect(started.existingEnvironmentId).toBeUndefined();
    });
  });

  test("leaves the screenshot out when it was unticked", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const result = await createDebugBuild(
        { environmentId: "env-source", problem: "Add a dark theme", requestId: "request-2" },
        { storage, runtime, buildPipelines: supervisor.service },
        ports(),
      );
      const task = await storage.kanban.getKanbanTask(result.taskId);
      expect(task?.images).toEqual([]);
      expect(task?.description).toContain("Screenshot: not attached.");
      expect(supervisor.started[0]?.taskSnapshot.images).toEqual([]);
      expect(task?.acceptanceCriteria).toBe(
        "- The problem or objective in the summary is resolved: Add a dark theme",
      );
    });
  });

  test("a retry with the same request returns the same ticket without duplicating attachments", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const request = {
        environmentId: "env-source",
        problem: "Crash on reload",
        screenshot,
        requestId: "request-3",
      };
      const first = await createDebugBuild(
        request,
        { storage, runtime, buildPipelines: supervisor.service },
        ports(),
      );
      const second = await createDebugBuild(
        request,
        { storage, runtime, buildPipelines: supervisor.service },
        ports({
          // The conversation moved on; the comment the first attempt wrote stays.
          readTranscript: async () => ({
            ...transcript,
            messages: [
              ...transcriptMessages,
              { role: "user", createdAt: null, text: "Later", textTruncated: false, parts: [] },
            ],
          }),
          now: () => new Date("2026-11-14T11:00:00.000Z"),
        }),
      );
      expect(second.taskId).toBe(first.taskId);
      expect(second.pipelineId).toBe(first.pipelineId);
      const task = await storage.kanban.getKanbanTask(first.taskId);
      expect(task?.comments).toHaveLength(1);
      expect(task?.comments[0]?.text).not.toContain("Later");
      expect(task?.images).toHaveLength(1);
      // The replay found the pipeline linked to the ticket; it started nothing.
      expect(supervisor.started).toHaveLength(1);
      const tasks = await storage.kanban.getKanbanTasks("project-1");
      expect(tasks).toHaveLength(1);
    });
  });

  test("refuses a key reused for a different request", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const context = { storage, runtime, buildPipelines: supervisor.service };
      await createDebugBuild(
        { environmentId: "env-source", problem: "One thing", requestId: "request-4" },
        context,
        ports(),
      );
      await expect(
        createDebugBuild(
          { environmentId: "env-source", problem: "Another thing", requestId: "request-4" },
          context,
          ports(),
        ),
      ).rejects.toThrow("already used with different arguments");
      expect(supervisor.started).toHaveLength(1);
    });
  });

  test("an unreadable transcript is reported in the ticket, not a failure", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const result = await createDebugBuild(
        { environmentId: "env-source", problem: "Something", requestId: "request-5" },
        { storage, runtime, buildPipelines: supervisor.service },
        ports({ readTranscript: async () => Promise.reject(new Error("bridge down")) }),
      );
      const task = await storage.kanban.getKanbanTask(result.taskId);
      expect(task?.comments).toEqual([]);
      expect(task?.description).toContain("transcript could not be read");
    });
  });

  test("rejects an invalid request and an unknown environment before writing anything", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const context = { storage, runtime, buildPipelines: supervisor.service };
      await expect(
        createDebugBuild(
          { environmentId: "env-source", problem: "   ", requestId: "r" },
          context,
          ports(),
        ),
      ).rejects.toThrow("Invalid debug build request");
      await expect(
        createDebugBuild(
          { environmentId: "missing", problem: "x", requestId: "r" },
          context,
          ports(),
        ),
      ).rejects.toThrow("Environment not found");
      expect(await storage.kanban.getKanbanTasks("project-1")).toEqual([]);
      expect(supervisor.started).toEqual([]);
    });
  });
});

describe("createDebugBuild replays and partial writes", () => {
  const request = {
    environmentId: "env-source",
    problem: "Crash on reload",
    requestId: "replay-1",
  };

  for (const phase of ["failed", "complete"]) {
    test(`a replay after the pipeline ${phase === "failed" ? "failed" : "completed"} returns it, launching nothing`, async () => {
      await withStorage(async (storage) => {
        const supervisor = fakeSupervisor(storage);
        const context = { storage, runtime, buildPipelines: supervisor.service };
        const first = await createDebugBuild({ ...request, screenshot }, context, ports());
        await setPipelinePhase(storage, first.pipelineId, phase);
        const replay = await createDebugBuild({ ...request, screenshot }, context, ports());
        expect(replay).toEqual(first);
        expect(supervisor.started).toHaveLength(1);
        expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
        expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(1);
      });
    });
  }

  test("a build the user started on the ticket later is not what a replay returns", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const context = { storage, runtime, buildPipelines: supervisor.service };
      const first = await createDebugBuild(request, context, ports());
      await setPipelinePhase(storage, first.pipelineId, "failed");
      // A rebuild from the board: a second pipeline on the same ticket.
      await supervisor.start({ ...supervisor.started[0]! });
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(2);
      const replay = await createDebugBuild(request, context, ports());
      expect(replay.pipelineId).toBe(first.pipelineId);
    });
  });

  test("overlapping attempts of one request share one run", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const context = { storage, runtime, buildPipelines: supervisor.service };
      const gate = deferred();
      const held = ports({
        sourceTabs: async () => {
          await gate.promise;
          return [{ tabId: "tab-front", agent: "claude", title: "Main", front: true }];
        },
      });
      const one = createDebugBuild(request, context, held);
      const two = createDebugBuild(request, context, held);
      gate.resolve();
      const [first, second] = await Promise.all([one, two]);
      expect(second).toEqual(first);
      expect(supervisor.started).toHaveLength(1);
      expect(held.reads).toEqual(["tab-front"]);
    });
  });

  test("an overlapping attempt with the same key and a different request is refused and writes nothing", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const context = { storage, runtime, buildPipelines: supervisor.service };
      const gate = deferred();
      const held = ports({
        sourceTabs: async () => {
          await gate.promise;
          return [{ tabId: "tab-front", agent: "claude", title: "Main", front: true }];
        },
      });
      const first = createDebugBuild(request, context, held);
      const other = ports();
      await expect(
        createDebugBuild(
          { ...request, problem: "Something else entirely", screenshot },
          context,
          other,
        ),
      ).rejects.toThrow("already used with different arguments");
      expect(other.reads).toEqual([]);
      gate.resolve();
      const result = await first;
      expect(supervisor.started).toHaveLength(1);
      const task = await storage.kanban.getKanbanTask(result.taskId);
      expect(task?.description).toContain("Crash on reload");
      expect(task?.description).not.toContain("Something else entirely");
      expect(task?.images).toEqual([]);
    });
  });

  test("a ticket is written with every transcript, so a retry after a later failure finishes without duplicating them", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const context = { storage, runtime, buildPipelines: supervisor.service };
      const bothTabs = ports({
        readTranscript: async () => transcript,
      });
      const kanban = storage.kanban;
      const original = kanban.addNormalizedKanbanImageForRequest.bind(kanban);
      let failures = 1;
      kanban.addNormalizedKanbanImageForRequest = async (...args) => {
        if (failures-- > 0) throw new Error("disk full");
        return original(...args);
      };
      await expect(createDebugBuild({ ...request, screenshot }, context, bothTabs)).rejects.toThrow(
        "disk full",
      );
      const [partial] = await storage.kanban.getKanbanTasks("project-1");
      // Both tabs' transcripts arrived with the ticket, in one write.
      expect(partial?.comments).toHaveLength(2);
      expect(supervisor.started).toEqual([]);

      const retry = await createDebugBuild({ ...request, screenshot }, context, bothTabs);
      const task = await storage.kanban.getKanbanTask(retry.taskId);
      expect(task?.comments).toHaveLength(2);
      expect(task?.images).toHaveLength(1);
      expect(supervisor.started).toHaveLength(1);
      expect(supervisor.started[0]!.taskSnapshot.comments).toHaveLength(2);
    });
  });

  test("a long tab is split across comments and does not crowd the other tabs out", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const long: DebugTranscriptMessage[] = Array.from({ length: 400 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        createdAt: null,
        text: `${index}:${"y".repeat(1_500)}`,
        textTruncated: false,
        parts: [],
      }));
      const result = await createDebugBuild(
        request,
        { storage, runtime, buildPipelines: supervisor.service },
        ports({
          readTranscript: async (_environmentId, tabId) =>
            tabId === "tab-front" ? { status: "read", complete: true, messages: long } : transcript,
        }),
      );
      const task = (await storage.kanban.getKanbanTask(result.taskId))!;
      const front = task.comments.filter((comment) => comment.text.includes("tab `tab-front`"));
      const other = task.comments.filter((comment) => comment.text.includes("tab `tab-other`"));
      // The short tab is attached whole; the long one is cut and says so.
      expect(other).toHaveLength(1);
      expect(other[0]!.text).toContain("The dialog did not open.");
      expect(front.length).toBeGreaterThan(1);
      for (const comment of task.comments) {
        expect(comment.text.length).toBeLessThanOrEqual(DEBUG_BUILD_TRANSCRIPT_COMMENT_MAX_CHARS);
      }
      const frontText = front.map((comment) => comment.text).join("\n");
      expect(frontText).toContain("#### 1. user");
      expect(frontText).toContain("#### 400. assistant");
      expect(frontText).toContain("omitted for length");
      expect(frontText).toContain("orkestrator session transcript");
      const total = task.comments.reduce((sum, comment) => sum + comment.text.length, 0);
      expect(total).toBeLessThanOrEqual(DEBUG_BUILD_TRANSCRIPT_MAX_CHARS + 5_000);
      expect(task.description).not.toContain("size limit");
    });
  });

  test("a ticket another attempt created first is used when it is the same request, refused when not", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor(storage);
      const context = { storage, runtime, buildPipelines: supervisor.service };
      const first = await createDebugBuild(request, context, ports());
      const kanban = storage.kanban;
      const original = kanban.findKanbanTaskByRequestId.bind(kanban);
      // Another process created the ticket between this attempt's lookup and its write.
      let misses = 1;
      kanban.findKanbanTaskByRequestId = async (...args) =>
        misses-- > 0 ? null : original(...args);
      const replay = await createDebugBuild(
        request,
        context,
        ports({ now: () => new Date("2026-11-14T11:30:00.000Z") }),
      );
      expect(replay).toEqual(first);
      expect(supervisor.started).toHaveLength(1);

      misses = 1;
      // The stored ticket's hash is checked again after the conflict.
      await expect(
        createDebugBuild({ ...request, problem: "Different" }, context, ports()),
      ).rejects.toThrow("already used with different arguments");
    });
  });
});

describe("debug source tabs", () => {
  const layout = {
    activePaneId: "right",
    root: {
      kind: "split",
      children: [
        {
          kind: "leaf",
          id: "left",
          activeTabId: "a",
          tabs: [{ id: "a", type: "agent-native", nativeAgentData: { platform: "claude" } }],
        },
        {
          kind: "leaf",
          id: "right",
          activeTabId: "b",
          tabs: [
            {
              id: "b",
              type: "agent-native",
              displayTitle: "Fix",
              nativeAgentData: { platform: "codex" },
            },
            { id: "t", type: "terminal" },
          ],
        },
      ],
    },
  };

  test("finds the active pane's active tab", () => {
    expect(frontTabId(layout)).toBe("b");
    expect(frontTabId(null)).toBeNull();
    expect(frontTabId({ root: layout.root })).toBeNull();
  });

  test("lists agent tabs only, the one in front first", async () => {
    const tabs = await debugSourceTabs({ getPaneLayout: async () => layout as never }, "env");
    expect(tabs).toEqual([
      { tabId: "b", agent: "codex", title: "Fix", front: true },
      { tabId: "a", agent: "claude", title: null, front: false },
    ]);
  });
});

describe("readDebugTabTranscript", () => {
  const environment = { id: "env-1", projectId: "project-1", status: "running" };
  const layout = {
    activePaneId: "p",
    root: {
      kind: "leaf",
      id: "p",
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", type: "agent-native", nativeAgentData: { platform: "claude" } }],
    },
  };
  const row = (id: string, text: string) => ({ id, role: "assistant", content: text, parts: [] });

  function context(options: { record: boolean; pages: Record<string, unknown> }) {
    const calls: string[] = [];
    return {
      calls,
      value: {
        command: {
          storage: {
            getEnvironment: async () => environment,
            getPaneLayout: async () => layout,
            getNativeAgentSession: async () =>
              options.record ? { environmentId: "env-1", agent: "claude" } : null,
          },
        },
        invoke: async (name: string, args: Record<string, unknown>) => {
          calls.push(`${name}:${String(args.before ?? "")}`);
          const page = options.pages[`${name}:${String(args.before ?? "")}`];
          return typeof page === "function" ? (page as () => unknown)() : page;
        },
      } as never,
    };
  }

  test("walks from the newest page back to the start of the conversation", async () => {
    const fake = context({
      record: true,
      pages: {
        "get_native_agent_transcript_update:": {
          status: "snapshot",
          token: "t",
          value: {
            messages: [row("m3", "newest")],
            freshness: "current",
            historyCursor: "older",
            historyEpoch: "epoch",
            historyComplete: false,
          },
        },
        "get_native_agent_message_page:older": {
          messages: [row("m1", "first"), row("m2", "second")],
          historyEpoch: "epoch",
          complete: true,
        },
      },
    });
    const read = await readDebugTabTranscript(fake.value, "env-1", "tab-1", 100_000);
    expect(read.status).toBe("read");
    if (read.status !== "read") return;
    expect(read.messages.map((message) => message.text)).toEqual(["first", "second", "newest"]);
    expect(read.complete).toBe(true);
  });

  test("a tab with no conversation is empty, and a failed read is unavailable", async () => {
    expect(
      (
        await readDebugTabTranscript(
          context({ record: false, pages: {} }).value,
          "env-1",
          "tab-1",
          1,
        )
      ).status,
    ).toBe("empty");
    expect(
      (
        await readDebugTabTranscript(
          context({
            record: true,
            pages: { "get_native_agent_transcript_update:": { status: "unavailable" } },
          }).value,
          "env-1",
          "tab-1",
          1,
        )
      ).status,
    ).toBe("unavailable");
  });

  const newest = (text: string, cursor = "older") => ({
    "get_native_agent_transcript_update:": {
      status: "snapshot",
      token: "t",
      value: {
        messages: [row("m9", text)],
        freshness: "current",
        historyCursor: cursor,
        historyEpoch: "epoch",
        historyComplete: false,
      },
    },
  });

  test("stops reading older pages once it has the characters it was asked for", async () => {
    const fake = context({
      record: true,
      pages: {
        ...newest("n".repeat(500)),
        "get_native_agent_message_page:older": {
          messages: [row("m1", "first")],
          historyEpoch: "epoch",
          complete: true,
        },
      },
    });
    const read = await readDebugTabTranscript(fake.value, "env-1", "tab-1", 100);
    expect(read.status).toBe("read");
    if (read.status !== "read") return;
    expect(read.messages.map((message) => message.text)).toEqual(["n".repeat(500)]);
    expect(read.complete).toBe(false);
    expect(fake.calls).toEqual(["get_native_agent_transcript_update:"]);
  });

  test("a page that hands back the cursor it was read with ends the walk", async () => {
    const fake = context({
      record: true,
      pages: {
        ...newest("newest"),
        "get_native_agent_message_page:older": {
          messages: [row("m1", "older")],
          historyEpoch: "epoch",
          nextCursor: "older",
          complete: false,
        },
      },
    });
    const read = await readDebugTabTranscript(fake.value, "env-1", "tab-1", 100_000);
    expect(read.status).toBe("read");
    if (read.status !== "read") return;
    expect(read.complete).toBe(false);
    // One newest page and one older page, not the page limit's worth.
    expect(fake.calls).toHaveLength(2);
  });

  test("a later page that fails keeps what was read, marked as not reaching the start", async () => {
    const fake = context({
      record: true,
      pages: {
        ...newest("newest"),
        "get_native_agent_message_page:older": () => {
          throw new Error("bridge restarted");
        },
      },
    });
    const read = await readDebugTabTranscript(fake.value, "env-1", "tab-1", 100_000);
    expect(read.status).toBe("read");
    if (read.status !== "read") return;
    expect(read.messages.map((message) => message.text)).toEqual(["newest"]);
    expect(read.complete).toBe(false);
  });
});
