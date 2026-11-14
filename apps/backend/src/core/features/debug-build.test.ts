import { beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import { DEBUG_BUILD_SCREENSHOT_FILENAME } from "@orkestrator/protocol/debug-build";
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

function fakeSupervisor() {
  const started: StartBuildPipelineInput[] = [];
  return {
    started,
    service: {
      async start(input: StartBuildPipelineInput) {
        started.push(input);
        // The supervisor's admission key makes a retry return the same pipeline.
        return { id: `pipeline-for-${input.taskId}`, environmentId: "" };
      },
    } as never,
  };
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

const transcript: DebugTabTranscript = {
  status: "read",
  complete: true,
  messages: [
    { role: "user", createdAt: null, text: "Open settings", textTruncated: false, parts: [] },
    {
      role: "assistant",
      createdAt: null,
      text: "The dialog did not open.",
      textTruncated: false,
      parts: [{ type: "tool", toolName: "Bash", status: "completed", title: "bun test" }],
    },
  ],
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
      const supervisor = fakeSupervisor();
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
      const supervisor = fakeSupervisor();
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
      const supervisor = fakeSupervisor();
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
            messages: [...(transcript as { messages: never[] }).messages],
          }),
          now: () => new Date("2026-11-14T11:00:00.000Z"),
        }),
      );
      expect(second.taskId).toBe(first.taskId);
      expect(second.pipelineId).toBe(first.pipelineId);
      const task = await storage.kanban.getKanbanTask(first.taskId);
      expect(task?.comments).toHaveLength(1);
      expect(task?.images).toHaveLength(1);
      const tasks = await storage.kanban.getKanbanTasks("project-1");
      expect(tasks).toHaveLength(1);
    });
  });

  test("refuses a key reused for a different request", async () => {
    await withStorage(async (storage) => {
      const supervisor = fakeSupervisor();
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
      const supervisor = fakeSupervisor();
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
      const supervisor = fakeSupervisor();
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
          return options.pages[`${name}:${String(args.before ?? "")}`];
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
});
