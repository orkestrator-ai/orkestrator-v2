import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { WorkflowResultService } from "./workflow-result-service.js";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { expect, test, spyOn, setDefaultTimeout } from "bun:test";

// Real Git setup and commits require process startup headroom under aggregate load.
setDefaultTimeout(30_000);
import {
  AutoPipelineService,
  MAX_ACTIVE_DRAFTS,
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
      logicalSessionKey: "env-env-1:original-tab",
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
  fence = new EnvironmentMutationFence(),
): CommandContext {
  return {
    storage,
    buildPipelines,
    runtime: {
      environments: { fence },
      tmux: { sessions: { activityState: () => "idle" } },
      terminals: {
        hasLiveSessionsForEnvironment: () => false,
        hasContainerTerminal: () => false,
        terminateSessionsForEnvironment: async () => [],
      },
    },
    nativeAgents: { hasActiveCheckoutWork: async () => false },
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
      expect(auto.state("env-1", "original-tab")).toEqual({ phase: "idle" });
      let draft;
      try {
        const drafting = auto.draft("env-1", "original-tab");
        // The tab reads progress without joining or restarting the operation.
        expect(auto.state("env-1", "original-tab")).toEqual({ phase: "drafting" });
        draft = await drafting;
      } finally {
        structured.mockRestore();
      }
      expect(auto.state("env-1", "original-tab")).toEqual({ phase: "ready", draft });
      const edits = { title: "", description: "Half typed", acceptanceCriteria: ["", "x"] };
      auto.saveEdits(draft.id, edits);
      expect(auto.state("env-1", "original-tab")).toEqual({ phase: "ready", draft, edits });
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.sessionId).not.toBe("original-session");
      expect(provider.sent[0]?.prompt).toContain("submit_auto_pipeline_draft");
      expect(provider.created[0]?.options?.readOnly).toBe(true);
      expect(provider.created[0]?.options?.model).toBe("draft-model");
      expect(provider.created[0]?.options?.effort).toBe("high");
      expect(provider.created[0]?.options?.policy?.approvals).toBe("deny");
      expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
      // A new service represents backend restart; the reviewed draft remains authoritative.
      const restarted = new AutoPipelineService(context, () =>
        gitPorts(async (environment) => {
          // The production local bridge start uses this same moving-checkout gate.
          context.runtime.environments.fence.assertNotMoving(environment.id);
          return provider;
        }),
      );
      expect((await restarted.draft("env-1", "original-tab")).id).toBe(draft.id);
      expect(provider.sent).toHaveLength(1);
      const terminate = spyOn(context.runtime.terminals, "terminateSessionsForEnvironment");
      const record = (await restarted.confirm(draft.id, {
        ...result,
        title: "Reviewed feature",
      })) as { id: string };
      // Promotion closes the environment's shells itself rather than asking the user to.
      expect(terminate).toHaveBeenCalledWith("env-1");
      terminate.mockRestore();
      expect(restarted.state("env-1", "original-tab")).toEqual({
        phase: "promoted",
        pipelineId: record.id,
      });
      expect(() => restarted.saveEdits(draft.id, edits)).toThrow("already confirmed");
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
      expect(auto.state("env-1", "original-tab")).toEqual({
        phase: "failed",
        error: "Wait for this tab's turn to finish",
      });
    } finally {
      status.mockRestore();
    }
  });
});

test("sources exclude foreign environment keys and sessions without an open pane tab", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    const original = (await storage.listNativeAgentSessions())[0]!;
    const sessions = { original };
    for (const [key, environmentId, logicalSessionKey] of [
      ["foreign-key", "env-1", "env-env-2:original-tab"],
      ["closed-tab", "env-1", "env-env-1:closed-tab"],
      ["foreign-environment", "env-2", "env-env-1:original-tab"],
      ["bare-tab", "env-1", "original-tab"],
    ] as const) {
      Object.assign(sessions, {
        [key]: {
          ...original,
          key,
          environmentId,
          logicalSessionKey,
          providerSessionId: key,
        },
      });
    }
    seedStore(storage.getDataDir(), "native-agent-sessions.json", sessions);
    expect(await storage.listNativeAgentSessions()).toHaveLength(5);
    const status = spyOn(provider, "status");
    try {
      const auto = new AutoPipelineService(draftContext(storage, buildPipelines), () =>
        gitPorts(async () => provider),
      );
      expect(await auto.sources("env-1")).toEqual({
        available: true,
        sources: [{ tabId: "original-tab", label: "codex" }],
      });
      expect(status.mock.calls).toEqual([["original-session"]]);
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
        await writeFile(join(cwd, "feature.txt"), "unreviewed later work\n");
        await expect(auto.confirm(draft.id, result)).rejects.toThrow("Work changed");
        expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
        await writeFile(join(cwd, "feature.txt"), "after\n");
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
        const persist = storage.putAutoPipelineDraft.bind(storage);
        let crashed = false;
        const receipt = spyOn(storage, "putAutoPipelineDraft").mockImplementation((record) => {
          if (!crashed && record.attempt.commit !== base) {
            crashed = true;
            throw new Error("receipt unavailable");
          }
          persist(record);
        });
        try {
          await expect(auto.confirm(draft.id, result)).rejects.toThrow("receipt unavailable");
        } finally {
          receipt.mockRestore();
        }
        // Recover the real trailer-bearing commit without committing a second time.
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
        logicalSessionKey: "env-env-1:second-tab",
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
      // The part-way failure locked the ticket: the tab is told so, and edits are refused.
      expect(auto.state("env-1", "original-tab")).toMatchObject({
        phase: "ready",
        draft: { id: draft.id },
        reviewed: {
          title: result.title,
          description: result.description,
          acceptanceCriteria: result.acceptanceCriteria,
        },
        confirmError: "admission rejected",
      });
      expect(() =>
        auto.saveEdits(draft.id, { title: "x", description: "y", acceptanceCriteria: ["z"] }),
      ).toThrow("already confirmed");
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

for (const boundary of ["add", "commit", "admission"] as const) {
  test(`promotion owns checkout through ${boundary} and releases it on failure`, async () => {
    const fence = new EnvironmentMutationFence();
    await withService(
      async (buildPipelines, storage, provider) => {
        seed(storage);
        await storage.updateEnvironment("env-1", {
          createdFromCommit: "1111111111111111111111111111111111111111",
        });
        const context = draftContext(storage, buildPipelines, fence);
        const ports = gitPorts(async () => provider);
        const git = ports.git;
        let reached!: () => void;
        let resume!: () => void;
        const ready = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const stopAtBoundary = async () => {
          reached();
          await gate;
          throw new Error("injected promotion failure");
        };
        ports.git = async (id, args) => {
          // Real environment Git commands participate in this same fence.
          fence.beginMutation(id)();
          if (args[0] === boundary) await stopAtBoundary();
          if (args[0] === "status") return " M fixture.ts\n";
          return git(id, args);
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
        const admission =
          boundary === "admission"
            ? spyOn(buildPipelines, "startFromCompletedBuild").mockImplementation(stopAtBoundary)
            : undefined;
        const promotion = auto.confirm(draft.id, result);
        const rejected = promotion.catch((error: unknown) => error);
        await ready;
        try {
          expect(() => fence.beginAgentWork("env-1")).toThrow();
          expect(() => fence.beginMutation("env-1")).toThrow();
          expect(() => fence.beginWorktreeMutation("/tmp/build/fixture.ts")).toThrow();
          await expect(
            buildPipelines.start({
              projectId: "project-1",
              taskId: "other",
              taskTitle: "Other pipeline",
              taskSnapshot: {
                title: "Other pipeline",
                description: "",
                acceptanceCriteria: "",
                comments: [],
                images: [],
              },
              agentType: "codex",
              existingEnvironmentId: "env-1",
              environmentType: "local",
            }),
          ).rejects.toThrow("being moved");
        } finally {
          resume();
          expect(await rejected).toMatchObject({ message: "injected promotion failure" });
          admission?.mockRestore();
        }
        fence.beginAgentWork("env-1")();
        fence.beginMutation("env-1")();
        expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
      },
      { environmentFence: fence, realKanban: true },
    );
  });
}

test("promotion refuses an in-flight submission, another active agent and a terminal that will not close", async () => {
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
      const release = context.runtime.environments.fence.beginAgentWork("env-1");
      try {
        await expect(auto.confirm(draft.id, result)).rejects.toThrow("submission");
      } finally {
        release();
      }
      const active = spyOn(context.nativeAgents!, "hasActiveCheckoutWork").mockResolvedValue(true);
      try {
        await expect(auto.confirm(draft.id, result)).rejects.toThrow("agent may still write");
      } finally {
        active.mockRestore();
      }
      const terminal = spyOn(
        context.runtime.terminals,
        "terminateSessionsForEnvironment",
      ).mockResolvedValue(["env-1:setup"]);
      try {
        await expect(auto.confirm(draft.id, result)).rejects.toThrow("did not close");
        expect(terminal).toHaveBeenCalledWith("env-1");
      } finally {
        terminal.mockRestore();
      }
      // Each refusal is kept for the tab, beside the still-editable draft.
      expect(auto.state("env-1", "original-tab")).toMatchObject({
        phase: "ready",
        draft: { id: draft.id },
        confirmError: expect.stringContaining("did not close"),
      });
      expect(await storage.kanban.getKanbanTasks("project-1")).toHaveLength(0);
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
      expect(storage.getAutoPipelineDraft(draft.id)?.reviewed).toBeUndefined();
      expect(context.runtime.environments.fence.isBeingMoved("env-1")).toBe(false);
    },
    { realKanban: true },
  );
});

test("source discovery isolates a failed session and retains healthy tabs", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    const sessions = await storage.listNativeAgentSessions();
    const first = sessions[0]!;
    seedStore(storage.getDataDir(), "native-agent-sessions.json", {
      broken: { ...first, key: "broken", providerSessionId: "broken" },
      healthy: { ...first, key: "healthy", providerSessionId: "healthy" },
    });
    const status = spyOn(provider, "status").mockImplementation(async (id) => {
      if (id === "broken") throw new Error("Unavailable");
      return "idle";
    });
    try {
      const auto = new AutoPipelineService(draftContext(storage, buildPipelines), () =>
        gitPorts(async () => provider),
      );
      const sources = await auto.sources("env-1");
      expect(sources.sources).toHaveLength(2);
      expect(sources.sources[0]?.disabledReason).toContain("unavailable");
      expect(sources.sources[1]?.disabledReason).toBeUndefined();
    } finally {
      status.mockRestore();
    }
  });
});

test("draft rejects more than 1000 total pending paths before model dispatch", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    await storage.updateEnvironment("env-1", { createdFromCommit: "1".repeat(40) });
    const ports = gitPorts(async () => provider);
    const git = ports.git;
    ports.git = async (id, args) =>
      args[0] === "status"
        ? [
            ...Array.from({ length: 900 }, (_, i) => `?? untracked-${i}`),
            ...Array.from({ length: 200 }, (_, i) => ` M modified-${i}`),
          ].join("\n")
        : git(id, args);
    const auto = new AutoPipelineService(draftContext(storage, buildPipelines), () => ports);
    await expect(auto.draft("env-1", "original-tab")).rejects.toThrow("Too many pending files");
    expect(provider.sent).toHaveLength(0);
  });
});

test("explicit draft cancellation aborts the separate session and releases the pending request", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    await storage.updateEnvironment("env-1", { createdFromCommit: "1".repeat(40) });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resultKey = "";
    const send = spyOn(provider, "send").mockImplementation(async (_id, _prompt, options) => {
      resultKey = options.requestId!;
      started();
      return new Promise(() => {});
    });
    const abort = spyOn(provider, "abort");
    const context = draftContext(storage, buildPipelines);
    const auto = new AutoPipelineService(context, () => gitPorts(async () => provider));
    const pending = auto.draft("env-1", "original-tab");
    const outcome = pending.catch((error: Error) => error.message);
    try {
      await ready;
      // Separate service instances share the backend-owned operation registry.
      new AutoPipelineService(context, () => gitPorts(async () => provider)).cancelDraft(
        "env-1",
        "original-tab",
      );
      expect(await outcome).toContain("cancelled");
      expect(
        await context.workflowResults!.status(
          { environmentId: "env-1", projectId: "project-1" },
          resultKey,
        ),
      ).toMatchObject({ lifecycle: "cancelled" });
      expect(abort).toHaveBeenCalled();
      expect(abort.mock.calls.every(([id]) => id !== "original-session")).toBe(true);
      expect(storage.latestAutoPipelineDraft("env-1", "original-tab")).toBeNull();
      // A cancelled draft is a deliberate stop, not a failure the tab shows.
      expect(auto.state("env-1", "original-tab")).toEqual({ phase: "idle" });
    } finally {
      send.mockRestore();
      abort.mockRestore();
    }
  });
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

test("drafting refused at the session cap is recorded for the tab that asked", async () => {
  await withService(async (buildPipelines, storage, provider) => {
    seed(storage);
    const auto = new AutoPipelineService(draftContext(storage, buildPipelines), () =>
      gitPorts(async () => provider),
    );
    // Each attempt stays registered until it settles, so these fill every slot.
    const filling = Array.from({ length: MAX_ACTIVE_DRAFTS }, (_, index) =>
      auto.draft("env-1", `missing-${index}`).catch(() => undefined),
    );
    await expect(auto.draft("env-1", "original-tab")).rejects.toThrow("Too many drafting");
    expect(auto.state("env-1", "original-tab")).toEqual({
      phase: "failed",
      error: expect.stringContaining("Too many drafting sessions"),
    });
    await Promise.all(filling);
    expect(provider.sent).toHaveLength(0);
  });
});

test("a promotion in flight is reported, and locks edits, for its own draft only", async () => {
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
      const edits = { title: "Edited", description: "Typed", acceptanceCriteria: ["One"] };
      let openTerminals!: () => void;
      const terminalsClosed = new Promise<void>((resolve) => {
        openTerminals = resolve;
      });
      const terminate = spyOn(
        context.runtime.terminals,
        "terminateSessionsForEnvironment",
      ).mockImplementation(async () => {
        await terminalsClosed;
        return [];
      });
      let admit!: () => void;
      const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const start = buildPipelines.startFromCompletedBuild.bind(buildPipelines);
      const admission = spyOn(buildPipelines, "startFromCompletedBuild").mockImplementation(
        async (...args) => {
          await admitted;
          return start(...args);
        },
      );
      try {
        const confirming = auto.confirm(draft.id, result);
        await until(() => terminate.mock.calls.length > 0);
        // Before the ticket is locked in, the promotion alone refuses edits.
        expect(auto.state("env-1", "original-tab")).toEqual({ phase: "promoting", draft });
        expect(() => auto.saveEdits(draft.id, edits)).toThrow("being confirmed");
        openTerminals();
        await until(() => admission.mock.calls.length > 0);
        expect(auto.state("env-1", "original-tab")).toMatchObject({
          phase: "promoting",
          draft: { id: draft.id },
          reviewed: { title: result.title },
        });
        // A newer draft of the same tab is not the one being confirmed.
        const record = storage.getAutoPipelineDraft(draft.id)!;
        const { reviewed: _reviewed, ...unconfirmed } = record;
        storage.putAutoPipelineDraft({
          ...unconfirmed,
          draft: { ...record.draft, id: "newer-draft" },
          attempt: { ...record.attempt, completedAt: new Date(Date.now() + 60_000).toISOString() },
        });
        expect(auto.state("env-1", "original-tab")).toMatchObject({
          phase: "ready",
          draft: { id: "newer-draft" },
        });
        expect(() => auto.saveEdits("newer-draft", edits)).not.toThrow();
        admit();
        const pipelineRecord = (await confirming) as { id: string };
        // The environment now belongs to the older draft's pipeline.
        expect(auto.state("env-1", "original-tab")).toEqual({
          phase: "promoted",
          pipelineId: pipelineRecord.id,
        });
      } finally {
        openTerminals();
        admit();
        terminate.mockRestore();
        admission.mockRestore();
      }
    },
    { realKanban: true },
  );
});
