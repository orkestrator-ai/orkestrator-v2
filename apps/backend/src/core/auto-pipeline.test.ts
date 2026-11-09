import { WorkflowResultService } from "./workflow-result-service.js";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { expect, test, spyOn } from "bun:test";
import {
  AutoPipelineService,
  parseAutoPipelineResult,
  type AutoPipelinePorts,
} from "./auto-pipeline.js";
import { withService, pipeline } from "./build-pipeline-service-test-support.js";
import { seedStore } from "./storage-test-support.js";
import type { CommandContext } from "./commands-context.js";
import type { StorageService } from "./storage.js";

const result = {
  title: "Finished feature",
  description: "Summary: complete.\nProblem: missing feature.\nContext: fixture.",
  acceptanceCriteria: ["The fixture works", "The fixture persists after reload"],
  notes: {
    summary: "Implemented the feature",
    workDone: ["Changed fixture.txt"],
    decisions: [],
    tests: [{ name: "fixture", result: "passed" as const }],
    notDone: ["Review remains"],
  },
};
function seed(storage: StorageService) {
  seedStore(storage.getDataDir(), "pane-layouts.json", {
    "env-1": {
      root: {
        kind: "leaf",
        id: "leaf",
        tabs: [{ id: "original-tab", type: "agent-native" }],
        activeTabId: "original-tab",
      },
      activePaneId: "leaf",
    },
  });
  seedStore(storage.getDataDir(), "native-agent-sessions.json", {
    original: {
      version: 1,
      key: "original",
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "original-tab",
      providerSessionId: "original-session",
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1).toISOString(),
    },
  });
}
function draftContext(
  storage: StorageService,
  buildPipelines: CommandContext["buildPipelines"],
): CommandContext {
  return {
    storage,
    buildPipelines,
    workflowResults: new WorkflowResultService(storage.getDataDir()),
    agentTools: {
      workflowResultConnection: () => ({ url: "http://127.0.0.1:1/mcp", token: "fixture" }),
    },
  } as unknown as CommandContext;
}
function gitPorts(provider: AutoPipelinePorts["provider"]): AutoPipelinePorts {
  return {
    provider,
    release() {},
    git: async (_id, args) => {
      if (args[0] === "rev-parse") return "1111111111111111111111111111111111111111";
      if (args[0] === "branch") return "build";
      if (args[0] === "diff") return "diff --git a/fixture.txt b/fixture.txt\n+feature";
      return "";
    },
  };
}
test("draft result has bounded checkable criteria and valid Build notes", () => {
  expect(parseAutoPipelineResult(result)).toEqual(result);
  for (const value of [
    null,
    {},
    { ...result, title: "" },
    { ...result, acceptanceCriteria: [] },
    { ...result, notes: {} },
    { ...result, description: "x".repeat(32001) },
  ])
    expect(() => parseAutoPipelineResult(value)).toThrow();
});

test("manual prompt draft confirms through normal Review, Verify and PR without sending to original tab", async () => {
  await withService(
    async (buildPipelines, storage, provider) => {
      seed(storage);
      await storage.updateEnvironment("env-1", {
        createdFromCommit: "1111111111111111111111111111111111111111",
      });
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          enabledAgentPlatforms: ["codex"],
          agentSettings: {
            defaultAgent: "codex",
            platforms: { codex: { model: "draft-model", reasoningEffort: "high" } },
          },
        },
      });
      const context = draftContext(storage, buildPipelines);
      const auto = new AutoPipelineService(context, () => gitPorts(async () => provider));
      expect(await auto.sources("env-1")).toMatchObject({
        available: true,
        sources: [{ tabId: "original-tab" }],
      });
      const sendOriginal = provider.send.bind(provider);
      const structured = spyOn(provider, "send").mockImplementation(
        async (sessionId, prompt, options) => {
          await sendOriginal(sessionId, prompt, options);
          expect(
            await context.workflowResults!.submit(
              { environmentId: "env-1", projectId: "project-1" },
              options.requestId,
              result,
            ),
          ).toMatchObject({ ok: true });
        },
      );
      let draft;
      try {
        draft = await auto.draft("env-1", "original-tab");
      } finally {
        structured.mockRestore();
      }
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.sessionId).not.toBe("original-session");
      expect(provider.sent[0]?.prompt).toContain("submit_auto_pipeline_draft");
      expect(provider.created[0]?.options?.readOnly).toBe(true);
      expect(provider.created[0]?.options?.model).toBe("draft-model");
      expect(provider.created[0]?.options?.effort).toBe("high");
      expect(provider.created[0]?.options?.policy?.approvals).toBe("deny");
      expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
      // A new service represents backend restart; the reviewed draft remains authoritative.
      const restarted = new AutoPipelineService(context, () => gitPorts(async () => provider));
      expect((await restarted.draft("env-1", "original-tab")).id).toBe(draft.id);
      expect(provider.sent).toHaveLength(1);
      const record = (await restarted.confirm(draft.id, {
        ...result,
        title: "Reviewed feature",
      })) as { id: string };
      for (let pass = 0; pass < 12; pass++) await buildPipelines.advanceNow(record.id);
      const finished = await pipeline(storage, record.id);
      expect(finished.phase).toBe("complete");
      expect(finished.sessions[0]?.sdkSessionId).toBe("original-session");
      expect(finished.taskSnapshot.title).toBe("Reviewed feature");
      expect(finished.keyInformation?.summary).toBe(result.notes.summary);
      expect((await storage.getEnvironment("env-1"))?.prUrl).toContain("/pull/1");
      expect(provider.sent.every((turn) => turn.sessionId !== "original-session")).toBe(true);
      expect((await restarted.sources("env-1")).available).toBe(false);
      const tasks = await storage.kanban.getKanbanTasks("project-1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.environmentId).toBe("env-1");
      expect(tasks[0]?.buildPipelineId).toBe(record.id);
      expect(tasks[0]?.acceptanceCriteria).toContain("The fixture persists after reload");
    },
    { realKanban: true },
  );
});

test("running source is disabled and cannot draft", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    const status = spyOn(provider, "status").mockResolvedValue("running");
    try {
      const auto = new AutoPipelineService(draftContext(storage, buildPipelines), () =>
        gitPorts(async () => provider),
      );
      expect((await auto.sources("env-1")).sources[0]?.disabledReason).toContain("finish");
      await expect(auto.draft("env-1", "original-tab")).rejects.toThrow("finish");
      expect(provider.sent).toHaveLength(0);
    } finally {
      status.mockRestore();
    }
  });
});

test("malformed and failed drafting leave the prompt environment without a ticket or pipeline", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    await storage.updateEnvironment("env-1", {
      createdFromCommit: "1111111111111111111111111111111111111111",
    });
    const context = draftContext(storage, buildPipelines);
    const auto = new AutoPipelineService(context, () => gitPorts(async () => provider));
    const structured = spyOn(context.workflowResults!, "structured").mockResolvedValue({
      ok: true,
      provider: "codex",
      value: {},
    });
    try {
      await expect(auto.draft("env-1", "original-tab")).rejects.toThrow();
    } finally {
      structured.mockRestore();
    }
    const send = spyOn(provider, "send").mockRejectedValue(new Error("Failed draft"));
    try {
      await expect(auto.draft("env-1", "original-tab")).rejects.toThrow("Failed draft");
    } finally {
      send.mockRestore();
    }
    expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
    expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
  });
});

test("confirmation commits reviewed pending work once and rejects changed confirmation content", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    await storage.updateEnvironment("env-1", {
      createdFromCommit: "1111111111111111111111111111111111111111",
    });
    const context = draftContext(storage, buildPipelines);
    let dirty = true;
    let head = "1111111111111111111111111111111111111111";
    const commands: string[][] = [];
    const ports = gitPorts(async () => provider);
    const baseGit = ports.git;
    ports.git = async (id, args) => {
      commands.push(args);
      if (args[0] === "status") return dirty ? " M fixture.ts\n" : "";
      if (args[0] === "rev-parse") return head;
      if (args[0] === "commit") {
        dirty = false;
        head = "2222222222222222222222222222222222222222";
        return "";
      }
      return baseGit(id, args);
    };
    const auto = new AutoPipelineService(context, () => ports);
    const send = spyOn(provider, "send").mockImplementation(async (_session, _prompt, options) => {
      await context.workflowResults!.submit(
        { environmentId: "env-1", projectId: "project-1" },
        options.requestId,
        result,
      );
    });
    let draft;
    try {
      draft = await auto.draft("env-1", "original-tab");
    } finally {
      send.mockRestore();
    }
    expect(draft.uncommittedFiles).toEqual([" M fixture.ts"]);
    const first = (await auto.confirm(draft.id, result)) as { id: string };
    const replay = (await auto.confirm(draft.id, result)) as { id: string };
    expect(replay.id).toBe(first.id);
    expect(commands.filter((args) => args[0] === "commit")).toHaveLength(1);
    expect(commands.find((args) => args[0] === "commit")?.join(" ")).toContain("Finished feature");
    expect((await pipeline(storage, first.id)).sessions[0]?.headAtStart).toBe(head);
    await expect(auto.confirm(draft.id, { ...result, title: "Changed" })).rejects.toThrow(
      "different content",
    );
  });
});
