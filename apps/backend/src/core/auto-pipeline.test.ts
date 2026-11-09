import { WorkflowResultService } from "./workflow-result-service.js";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { expect, test, spyOn, setDefaultTimeout } from "bun:test";

// Real Git setup and commits require process startup headroom under aggregate load.
setDefaultTimeout(30_000);
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

test("confirmation replay repairs failed tab publication without another ticket", async () => {
  await withService(
    async (buildPipelines, storage, provider) => {
      seed(storage);
      await storage.updateEnvironment("env-1", {
        createdFromCommit: "1111111111111111111111111111111111111111",
      });
      const context = draftContext(storage, buildPipelines);
      const auto = new AutoPipelineService(context, () => gitPorts(async () => provider));
      const send = spyOn(provider, "send").mockImplementation(async (_id, _prompt, options) => {
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
      const publishOriginal = storage.ensureBuildPipelineTab.bind(storage);
      const publish = spyOn(storage, "ensureBuildPipelineTab").mockRejectedValueOnce(
        new Error("publication unavailable"),
      );
      try {
        await expect(auto.confirm(draft.id, result)).rejects.toThrow("publication unavailable");
      } finally {
        publish.mockRestore();
      }
      const repaired = spyOn(storage, "ensureBuildPipelineTab").mockImplementation(publishOriginal);
      try {
        await auto.confirm(draft.id, result);
        expect(repaired).toHaveBeenCalledTimes(1);
        expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(1);
      } finally {
        repaired.mockRestore();
      }
    },
    { realKanban: true },
  );
});

test("draft retention prunes superseded rows and deletes environment-owned receipts", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    await storage.updateEnvironment("env-1", {
      createdFromCommit: "1111111111111111111111111111111111111111",
    });
    const context = draftContext(storage, buildPipelines);
    const auto = new AutoPipelineService(context, () => gitPorts(async () => provider));
    const send = spyOn(provider, "send").mockImplementation(async (_id, _prompt, options) => {
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
    const record = storage.getAutoPipelineDraft(draft.id)!;
    storage.putAutoPipelineDraft({ ...record, draft: { ...draft, id: "replacement" } });
    expect(storage.getAutoPipelineDraft(draft.id)).toBeNull();
    expect(storage.getAutoPipelineDraft("replacement")).toBeTruthy();
    storage.deleteAutoPipelineDraftsByEnvironment("env-1");
    expect(storage.getAutoPipelineDraft("replacement")).toBeNull();
  });
});

test("changed checkout or transcript and stopped environment reject before ticket creation", async () => {
  await withService(
    async (buildPipelines, storage, provider) => {
      seed(storage);
      await storage.updateEnvironment("env-1", {
        createdFromCommit: "1111111111111111111111111111111111111111",
      });
      const context = draftContext(storage, buildPipelines);
      const ports = gitPorts(async () => provider);
      const auto = new AutoPipelineService(context, () => ports);
      const send = spyOn(provider, "send").mockImplementation(async (_id, _prompt, options) => {
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
      const base = ports.git;
      ports.git = async (id, args) => (args[0] === "diff" ? "later work" : base(id, args));
      await expect(auto.confirm(draft.id, result)).rejects.toThrow("Work changed");
      ports.git = base;
      const messages = spyOn(provider, "messages").mockResolvedValue([
        { role: "assistant", content: "later response" },
      ] as never);
      try {
        await expect(auto.confirm(draft.id, result)).rejects.toThrow("transcript changed");
      } finally {
        messages.mockRestore();
      }
      await storage.updateEnvironment("env-1", { status: "stopped" });
      await expect(auto.confirm(draft.id, result)).rejects.toThrow("must be running");
      expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
    },
    { realKanban: true },
  );
});

test("promotion commits real Git work once and commit failure creates no ticket", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "auto-pipeline-git-"));
  async function git(args: string[]): Promise<string> {
    const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code) throw new Error(stderr);
    return stdout;
  }
  try {
    await git(["init", "-b", "build"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(cwd, "feature.txt"), "before\n");
    await git(["add", "--all"]);
    await git(["commit", "-m", "Base"]);
    const base = (await git(["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "feature.txt"), "after\n");
    await withService(
      async (buildPipelines, storage, provider) => {
        seed(storage);
        await storage.updateEnvironment("env-1", { createdFromCommit: base });
        const context = draftContext(storage, buildPipelines);
        let failCommit = true;
        const ports = gitPorts(async () => provider);
        ports.git = async (_id, args) => {
          if (args[0] === "commit" && failCommit) throw new Error("commit hook failed");
          return git(args);
        };
        const auto = new AutoPipelineService(context, () => ports);
        const send = spyOn(provider, "send").mockImplementation(async (_id, _prompt, options) => {
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
        await expect(auto.confirm(draft.id, result)).rejects.toThrow("commit hook failed");
        expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
        // A failed commit stages the same work. Re-draft to review that index state.
        failCommit = false;
        const sendAgain = spyOn(provider, "send").mockImplementation(
          async (_id, _prompt, options) => {
            await context.workflowResults!.submit(
              { environmentId: "env-1", projectId: "project-1" },
              options.requestId,
              result,
            );
          },
        );
        try {
          draft = await auto.draft("env-1", "original-tab");
        } finally {
          sendAgain.mockRestore();
        }
        const admitted = (await auto.confirm(draft.id, result)) as { id: string };
        await auto.confirm(draft.id, result);
        expect((await git(["rev-list", "--count", "HEAD"])).trim()).toBe("2");
        expect((await git(["status", "--porcelain"])).trim()).toBe("");
        expect((await pipeline(storage, admitted.id)).sessions[0]?.headAtStart).toBe(
          (await git(["rev-parse", "HEAD"])).trim(),
        );
        expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(1);
      },
      { realKanban: true },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("source enumeration places the active pane's native tab first", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    const original = (await storage.listNativeAgentSessions())[0]!;
    seedStore(storage.getDataDir(), "native-agent-sessions.json", {
      original,
      second: {
        ...original,
        key: "second",
        logicalSessionKey: "second-tab",
        providerSessionId: "second-session",
      },
    });
    seedStore(storage.getDataDir(), "pane-layouts.json", {
      "env-1": {
        root: {
          kind: "leaf",
          id: "leaf",
          tabs: [
            { id: "original-tab", type: "agent-native" },
            { id: "second-tab", type: "agent-native" },
          ],
          activeTabId: "second-tab",
        },
        activePaneId: "leaf",
      },
    });
    const auto = new AutoPipelineService(draftContext(storage, buildPipelines), () =>
      gitPorts(async () => provider),
    );
    expect((await auto.sources("env-1")).sources.map((source) => source.tabId)).toEqual([
      "second-tab",
      "original-tab",
    ]);
  });
});

test("admission rejection removes its unpublished ticket and permits same-draft retry", async () => {
  await withService(
    async (buildPipelines, storage, provider) => {
      seed(storage);
      await storage.updateEnvironment("env-1", {
        createdFromCommit: "1111111111111111111111111111111111111111",
      });
      const context = draftContext(storage, buildPipelines);
      const auto = new AutoPipelineService(context, () => gitPorts(async () => provider));
      const send = spyOn(provider, "send").mockImplementation(async (_id, _prompt, options) => {
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
      const admission = spyOn(buildPipelines, "startFromCompletedBuild").mockRejectedValueOnce(
        new Error("admission rejected"),
      );
      try {
        await expect(auto.confirm(draft.id, result)).rejects.toThrow("admission rejected");
      } finally {
        admission.mockRestore();
      }
      expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
      await auto.confirm(draft.id, result);
      expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(1);
    },
    { realKanban: true },
  );
});

test("a hung drafting send times out, releases its session and permits retry", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    await storage.updateEnvironment("env-1", {
      createdFromCommit: "1111111111111111111111111111111111111111",
    });
    const context = draftContext(storage, buildPipelines);
    const auto = new AutoPipelineService(context, () => gitPorts(async () => provider), 20);
    const send = spyOn(provider, "send").mockImplementation(() => new Promise(() => {}));
    const abort = spyOn(provider, "abort");
    try {
      await expect(auto.draft("env-1", "original-tab")).rejects.toThrow("timed out");
      expect(abort).toHaveBeenCalledTimes(1);
      await expect(auto.draft("env-1", "original-tab")).rejects.toThrow("timed out");
      expect(abort).toHaveBeenCalledTimes(2);
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
    } finally {
      send.mockRestore();
      abort.mockRestore();
    }
  });
});
