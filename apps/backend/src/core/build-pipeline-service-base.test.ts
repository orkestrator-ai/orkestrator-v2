import { describe, expect, mock, test } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";

import { isBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { isReviewPackagePreparationSession } from "@orkestrator/protocol/build-pipeline";
import { REVIEW_PACKAGE_SESSION_LABEL } from "@orkestrator/protocol/build-pipeline";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";

import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";

import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";

import { StorageService } from "./storage.js";

import { BuildPipelineService } from "./build-pipeline-service.js";

import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";

import {
  cleanReview,
  FakeProvider,
  withService,
  pipeline,
  startInput,
  pendingQuestion,
  installInteractions,
  startBuilding,
  mutateStored,
  startVerifying,
} from "./build-pipeline-service-test-support.js";

describe("BuildPipelineService", () => {
  test("execution policy fails closed after the build environment is deleted", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      await storage.removeEnvironment("env-1");
      const internal = service as unknown as {
        executionPolicy(pipeline: BuildPipeline): Promise<unknown>;
      };

      await expect(internal.executionPolicy(started)).rejects.toThrow(
        "Build environment no longer exists",
      );
    });
  });

  test("rejects malformed starts and environments already being deleted", async () => {
    await withService(async (service, storage) => {
      await expect(service.start({} as never)).rejects.toThrow(
        "Invalid build pipeline start request",
      );

      await storage.updateEnvironment("env-1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(service.start(startInput())).rejects.toThrow("does not belong to this project");
      expect(await storage.listBuildPipelines("project-1")).toEqual([]);
    });
  });

  test("admits one equivalent start across two backend processes", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-admission-"));
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);
    await firstStorage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "build",
      branch: "build",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/build",
      setupScriptsComplete: true,
    });
    const invoke = async <T>(): Promise<T> => {
      throw new Error("No backend command should run during admission");
    };
    const first = new BuildPipelineService(firstStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    const second = new BuildPipelineService(secondStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      const [left, right] = await Promise.all([
        first.start(startInput()),
        second.start(startInput()),
      ]);
      expect(right.id).toBe(left.id);
      expect(await firstStorage.listBuildPipelines("project-1")).toHaveLength(1);
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("selects the build tab when setup hands off to the build stage", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("waiting-for-setup");

      const buildLayout = await storage.getPaneLayout("env-1");
      const buildRoot = buildLayout?.root as
        | {
            kind?: unknown;
            id?: unknown;
            tabs?: unknown;
            activeTabId?: unknown;
          }
        | undefined;
      if (
        !buildLayout ||
        buildRoot?.kind !== "leaf" ||
        typeof buildRoot.id !== "string" ||
        !Array.isArray(buildRoot.tabs)
      ) {
        throw new Error("expected a leaf build layout");
      }
      await storage.savePaneLayout(
        "env-1",
        {
          version: buildLayout.version,
          containerId: buildLayout.containerId,
          activePaneId: buildLayout.activePaneId,
          root: {
            ...buildRoot,
            tabs: [...buildRoot.tabs, { id: "setup-terminal", type: "plain", isSetupTab: true }],
            activeTabId: "setup-terminal",
          },
        },
        buildLayout.revision,
      );
      expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
        activeTabId: "setup-terminal",
      });

      await service.advanceNow(started.id);

      expect((await pipeline(storage, started.id)).phase).toBe("building");
      expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
        activeTabId: `build-${started.id}`,
      });
    });
  });

  test("canonicalizes immutable admission identity and ignores mutable source metadata", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-canonical-"));
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);
    await firstStorage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "build",
      branch: "build",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/build",
      setupScriptsComplete: true,
    });
    const invoke = async <T>(): Promise<T> => undefined as T;
    const first = new BuildPipelineService(firstStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    const second = new BuildPipelineService(secondStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      const firstInput = startInput({
        existingEnvironmentId: " env-1 ",
        featurePlanId: " feature-1 ",
        source: {
          type: "linear",
          issueId: "issue-1",
          issueIdentifier: "OLD-1",
          issueUrl: "https://linear.example/old",
          status: "backlog",
          teamKey: "OLD",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      const secondInput = startInput({
        existingEnvironmentId: "env-1",
        featurePlanId: "feature-1",
        source: {
          type: "linear",
          issueId: "issue-1",
          issueIdentifier: "NEW-99",
          issueUrl: "https://linear.example/new",
          status: "started",
          teamKey: "NEW",
          updatedAt: "2026-07-29T00:00:00.000Z",
        },
      });

      const [left, right] = await Promise.all([first.start(firstInput), second.start(secondInput)]);

      expect(right.id).toBe(left.id);
      expect(await firstStorage.listBuildPipelines("project-1")).toHaveLength(1);
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps distinct immutable admission identities separate", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-distinct-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    for (const id of ["env-1", "env-2"]) {
      await storage.addEnvironment({
        id,
        projectId: "project-1",
        name: id,
        branch: id,
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "full",
        order: id === "env-1" ? 0 : 1,
        environmentType: "local",
        worktreePath: `/tmp/${id}`,
        setupScriptsComplete: true,
      });
    }
    const service = new BuildPipelineService(storage, async <T>(): Promise<T> => undefined as T, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      const source = {
        type: "linear" as const,
        issueId: "issue-1",
        issueIdentifier: "TEAM-1",
      };
      const starts = [
        startInput({ taskId: "task-1", source }),
        startInput({ taskId: "task-2", source }),
        startInput({
          taskId: "task-1",
          source: { ...source, issueId: "issue-2" },
        }),
        startInput({
          taskId: "task-1",
          source,
          existingEnvironmentId: "env-2",
        }),
        startInput({
          taskId: "task-1",
          source,
          featurePlanId: "feature-2",
        }),
      ];
      const results = [];
      for (const input of starts) results.push(await service.start(input));

      expect(new Set(results.map(({ id }) => id)).size).toBe(starts.length);
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(starts.length);
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("admits one concurrent new-environment start and preserves its naming prompt", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-new-env-"));
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);
    const createEnvironment = mock(async (args: Record<string, unknown>) => {
      const environment = {
        id: "env-created",
        projectId: "project-1",
        name: "created",
        branch: "created",
        containerId: null,
        status: "running" as const,
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "full" as const,
        order: 0,
        environmentType: "local" as const,
        worktreePath: "/tmp/env-created",
        setupScriptsComplete: true,
      };
      await firstStorage.addEnvironment(environment);
      expect(args.namingPrompt).toBe("name this durable build");
      return environment;
    });
    const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (command === "create_environment") {
        return (await createEnvironment(args)) as T;
      }
      throw new Error(`Unexpected command: ${command}`);
    };
    const first = new BuildPipelineService(firstStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    const second = new BuildPipelineService(secondStorage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      const input = startInput({
        existingEnvironmentId: undefined,
        namingPrompt: "name this durable build",
      });
      const [left, right] = await Promise.all([first.start(input), second.start(input)]);

      expect(right.id).toBe(left.id);
      expect(createEnvironment).toHaveBeenCalledTimes(1);
      expect(await firstStorage.listBuildPipelines("project-1")).toHaveLength(1);
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects a malformed snapshot returned by admission", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-malformed-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "build",
      branch: "build",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/build",
      setupScriptsComplete: true,
    });
    storage.saveBuildPipeline = mock(async (_pipelineId, projectId, environmentId, version) => ({
      version,
      id: "admitted-malformed",
      projectId,
      environmentId,
      snapshot: {},
      updatedAt: new Date().toISOString(),
      revision: 1,
    }));
    const service = new BuildPipelineService(storage, async <T>(): Promise<T> => undefined as T, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });
    try {
      await expect(service.start(startInput())).rejects.toThrow(
        "Existing build pipeline admission is invalid",
      );
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("wires repository defaults, authentication and staged images into the production Codex provider", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(tmpdir(), "orkestrator-pipeline-production-provider-"),
    );
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "build",
      branch: "build",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/build",
      setupScriptsComplete: true,
    });
    await storage.updateRepositoryConfig("project-1", {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: {
        defaultAgent: "codex",
        platforms: { codex: { model: "repo-codex", reasoningEffort: "xhigh" } },
      },
    });

    const requests: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/session/create")) {
        return Response.json({ sessionId: "build-production-1" });
      }
      if (url.endsWith("/global/models")) {
        return Response.json({ source: "app-server", models: [{ id: "repo-codex" }] });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const invocations: Array<{
      command: string;
      args: Record<string, unknown>;
    }> = [];
    const service = new BuildPipelineService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
        invocations.push({ command, args });
        if (
          command === "update_environment_agent_settings" ||
          command === "run_environment_setup"
        ) {
          return (await storage.getEnvironment("env-1")) as T;
        }
        if (command === "start_local_codex_server_cmd") {
          return { port: 3210, authToken: "test-auth-token" } as T;
        }
        if (command === "write_local_file") {
          return "/tmp/build/.orkestrator/prompt-attachments/shot.png" as T;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { autoAdvance: false },
    );
    try {
      const started = await service.start(
        startInput({
          agentType: "codex",
          taskSnapshot: {
            ...startInput().taskSnapshot,
            images: [{ filename: "shot.png", data: "AAAA" }],
          },
        }),
      );
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      expect(invocations).toContainEqual({
        command: "start_local_codex_server_cmd",
        args: { environmentId: "env-1" },
      });
      expect(invocations).toContainEqual({
        command: "write_local_file",
        args: {
          worktreePath: "/tmp/build",
          filePath: ".orkestrator/prompt-attachments/shot.png",
          base64Data: "AAAA",
        },
      });
      // The configured default is checked against the live model list first.
      expect(requests.map(({ url }) => url)).toEqual([
        "http://127.0.0.1:3210/global/models",
        "http://127.0.0.1:3210/session/create",
        "http://127.0.0.1:3210/session/build-production-1/prompt",
      ]);
      const create = requests[1]!;
      expect(new Headers(create.init.headers).get("X-Orkestrator-Codex-Token")).toBe(
        "test-auth-token",
      );
      expect(JSON.parse(String(create.init.body))).toMatchObject({
        model: "repo-codex",
        modelReasoningEffort: "xhigh",
        mode: "build",
      });
      expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
        attachments: [
          {
            type: "image",
            path: "/tmp/build/.orkestrator/prompt-attachments/shot.png",
            filename: "shot.png",
            dataUrl: "data:image/png;base64,AAAA",
          },
        ],
      });
    } finally {
      await service.shutdown();
      globalThis.fetch = originalFetch;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects missing and cross-project existing environments before persisting", async () => {
    await withService(async (service, storage) => {
      await expect(
        service.start(
          startInput({
            existingEnvironmentId: "missing",
          }),
        ),
      ).rejects.toThrow("does not belong to this project");
      await storage.addEnvironment({
        id: "foreign-env",
        projectId: "project-2",
        name: "foreign",
        branch: "foreign",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "full",
        order: 0,
        environmentType: "local",
        worktreePath: "/tmp/foreign",
      });
      await expect(
        service.start(
          startInput({
            existingEnvironmentId: "foreign-env",
          }),
        ),
      ).rejects.toThrow("does not belong to this project");
      expect(await storage.listBuildPipelines("project-1")).toEqual([]);
    });
  });

  test("resume dispatches durable continuation work instead of advancing an aborted stage", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      expect(provider.sent).toHaveLength(1);

      const reconnecting = await pipeline(storage, started.id);
      await storage.saveBuildPipeline(
        started.id,
        reconnecting.projectId,
        reconnecting.environmentId,
        1,
        { ...reconnecting, error: "Reconnect failed" },
        reconnecting.backendRevision,
      );
      await service.pause(started.id);
      const paused = await pipeline(storage, started.id);
      expect(paused.sessions[0]?.status).toBe("idle");
      expect(paused.pauseCause).toBe("requested");
      expect(paused.error).toBe("Reconnect failed");
      await service.resume(started.id);
      await service.advanceNow(started.id);

      const resumed = await pipeline(storage, started.id);
      expect(resumed.phase).toBe("building");
      expect(resumed.sessions[0]?.status).toBe("running");
      expect(provider.sent).toHaveLength(2);
      expect(resumed.pendingPromptAttempt).toBeUndefined();
    });
  });

  test("tool-mode pause and resume supersede the abandoned result slot", async () => {
    await withService(
      async (service, storage, _provider, _invocations, controls) => {
        const { started } = await startBuilding(service, storage);
        const beforePause = await pipeline(storage, started.id);
        const oldKey = beforePause.sessions[beforePause.currentSessionIndex]!.structuredRequestId!;

        await service.pause(started.id);
        expect(
          await controls.workflowResults!.status(
            { environmentId: "env-1", projectId: "project-1" },
            oldKey,
          ),
        ).toMatchObject({ lifecycle: "superseded", completion: "blocked" });

        await service.resume(started.id);
        const resumed = await pipeline(storage, started.id);
        expect(resumed.sessions[resumed.currentSessionIndex]!.structuredRequestId).not.toBe(oldKey);
        expect(
          await controls.workflowResults!.submit(
            { environmentId: "env-1", projectId: "project-1" },
            oldKey,
            { commands: [], summary: "late" },
          ),
        ).toMatchObject({ ok: false, error: { code: "attempt_closed" } });
      },
      { toolMode: true },
    );
  });

  test("fails a container stage before dispatch when its agent tools are unreachable", async () => {
    const unreachable =
      "Orkestrator did not start the stage: the container can't reach the agent tools server.";
    const preflights: Array<{ environmentId: string; stage: string }> = [];
    await withService(
      async (service, storage, provider) => {
        const started = await service.start(startInput());
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);

        const failed = await pipeline(storage, started.id);
        expect(failed.phase).toBe("failed");
        expect(failed.error).toContain(unreachable);
        expect(failed.pendingPromptAttempt).toBeUndefined();
        // Nothing was sent to an agent that could never report its result.
        expect(provider.sent).toHaveLength(0);
        expect(preflights).toEqual([
          { environmentId: "env-1", stage: "build pipeline building step" },
        ]);
      },
      {
        toolMode: true,
        environmentType: "containerized",
        assertAgentToolsReachable: async (environmentId, stage) => {
          preflights.push({ environmentId, stage });
          throw new Error(unreachable);
        },
      },
    );
  });

  test("redispatching a pending container prompt re-checks agent tools reachability", async () => {
    const unreachable = "The container can't reach the agent tools server.";
    const preflights: Array<{ environmentId: string; stage: string }> = [];
    let reachable = true;
    await withService(
      async (service, storage, provider) => {
        const { started } = await startBuilding(service, storage, {
          environmentType: "containerized",
        });
        expect(provider.sent).toHaveLength(1);
        expect(preflights).toEqual([
          { environmentId: "env-1", stage: "build pipeline building step" },
        ]);

        await service.pause(started.id);
        reachable = false;
        // Resume journals a continuation prompt; its dispatch goes through the
        // pending-attempt path, which must check reachability again.
        await service.resume(started.id);
        await service.advanceNow(started.id);

        const failed = await pipeline(storage, started.id);
        expect(failed.phase).toBe("failed");
        expect(failed.error).toContain(unreachable);
        expect(failed.pendingPromptAttempt).toBeUndefined();
        // The failure came from redispatching the existing session, not a new stage.
        expect(provider.created).toHaveLength(1);
        expect(provider.sent).toHaveLength(1);
        expect(preflights).toHaveLength(2);
        expect(preflights[1]).toEqual({
          environmentId: "env-1",
          stage: "build pipeline building step",
        });
      },
      {
        toolMode: true,
        environmentType: "containerized",
        assertAgentToolsReachable: async (environmentId, stage) => {
          preflights.push({ environmentId, stage });
          if (!reachable) throw new Error(unreachable);
        },
      },
    );
  });

  test("skips the agent tools preflight for a local worktree pipeline", async () => {
    let preflights = 0;
    await withService(
      async (service, storage, provider) => {
        await startBuilding(service, storage);
        expect(provider.sent).toHaveLength(1);
        expect(preflights).toBe(0);
      },
      {
        toolMode: true,
        assertAgentToolsReachable: async () => {
          preflights += 1;
        },
      },
    );
  });

  test("completes PR creation when GitHub mergeability is still indeterminate", async () => {
    await withService(async (service, storage, _provider, invocations, controls) => {
      controls.detection = {
        url: "https://github.com/acme/repo/pull/43",
        state: "open",
        hasMergeConflicts: null,
      };
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }

      expect((await pipeline(storage, started.id)).phase).toBe("complete");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/43",
        prState: "open",
        hasMergeConflicts: null,
      });
      expect(invocations).toContainEqual({
        command: "pr_monitor_watch",
        args: { environmentId: "env-1", mode: "normal" },
      });
    });
  });

  test("restarts a selected pipeline stage and runs every downstream stage again", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }

      const completed = await pipeline(storage, started.id);
      expect(completed.phase).toBe("complete");
      const originalReview = completed.sessions.find(
        (session) => session.phase === "review" && session.reviewReport !== undefined,
      )!;
      const originalDownstream = completed.sessions.filter(
        (session) => session.phase === "verify" || session.phase === "pr",
      );
      expect(originalReview).toBeDefined();
      expect(originalDownstream).not.toHaveLength(0);

      const restarted = await service.restartStep(started.id, originalReview.sdkSessionId);
      expect(restarted.phase).toBe("reviewing");
      expect(restarted.structuredReview).toBeUndefined();
      expect(restarted.verificationResult).toBeUndefined();
      expect(restarted.restartRequest).toBeUndefined();
      const replacementReview = restarted.sessions.at(-1)!;
      expect(replacementReview).toMatchObject({ phase: "review", status: "running" });
      expect(replacementReview.sdkSessionId).not.toBe(originalReview.sdkSessionId);

      for (let pass = 0; pass < 4; pass += 1) {
        await service.advanceNow(started.id);
      }
      const rerun = await pipeline(storage, started.id);
      expect(rerun.phase).toBe("complete");
      const replacementDownstream = rerun.sessions.filter(
        (session) =>
          (session.phase === "verify" || session.phase === "pr") &&
          !originalDownstream.some((old) => old.sessionKey === session.sessionKey),
      );
      expect(replacementDownstream.map((session) => session.phase)).toEqual(["verify", "pr"]);
    });
  });

  test("aborts a still-running stage before starting its replacement", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
      let completed = await pipeline(storage, started.id);
      const verificationIndex = completed.sessions.findIndex(
        (session) => session.phase === "verify",
      );
      completed = await mutateStored(storage, started.id, (snapshot) => {
        snapshot.phase = "verifying";
        snapshot.currentSessionIndex = verificationIndex;
        snapshot.sessions[verificationIndex]!.status = "running";
        delete snapshot.sessions[verificationIndex]!.completedAt;
      });
      const session = completed.sessions[verificationIndex]!;

      const restarted = await service.restartStep(started.id, session.sdkSessionId);

      expect(provider.aborted).toContain(session.sdkSessionId);
      expect(restarted.sessions.at(-1)).toMatchObject({
        phase: "verify",
        status: "running",
      });
      expect(restarted.sessions.at(-1)?.sdkSessionId).not.toBe(session.sdkSessionId);
    });
  });

  describe("restarting the current stage", () => {
    const reviewSessionCount = (snapshot: BuildPipeline) =>
      snapshot.sessions.filter((session) => session.phase === "review").length;

    test("restarts a running default build even though it produces the package plan", async () => {
      await withService(async (service, storage, provider) => {
        provider.runningPhases.add("build");
        const { started, session } = await startBuilding(service, storage);
        expect(session.producedReviewPackagePlan).toBe(true);

        const restarted = await service.restartCurrentStep(started.id);

        expect(provider.aborted).toContain(session.sdkSessionId);
        expect(restarted.phase).toBe("building");
        expect(restarted.sessions.at(-1)).toMatchObject({
          phase: "build",
          label: "Build Session",
          status: "running",
        });
        expect(restarted.sessions.at(-1)?.sdkSessionId).not.toBe(session.sdkSessionId);
      });
    });

    test("restarts a running default fix rather than review preparation", async () => {
      await withService(async (service, storage, provider) => {
        const started = await service.start(startInput());
        for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
        const staged = await mutateStored(storage, started.id, (snapshot) => {
          snapshot.sessions.push({
            phase: "fix",
            agent: "claude",
            iteration: snapshot.iteration,
            sessionKey: "previous-fix",
            sdkSessionId: "previous-fix",
            status: "idle",
            startedAt: new Date().toISOString(),
            label: "Fix Session",
          });
          snapshot.verificationFeedback = "Repair the failed verification";
        });
        provider.runningPhases.add("fix");
        const fixing = await service.restartStep(started.id, staged.sessions.at(-1)!.sdkSessionId);
        const session = fixing.sessions.at(-1)!;
        expect(session.producedReviewPackagePlan).toBe(true);

        const restarted = await service.restartCurrentStep(started.id);

        expect(provider.aborted).toContain(session.sdkSessionId);
        expect(restarted.phase).toBe("fixing");
        expect(restarted.sessions.at(-1)).toMatchObject({
          phase: "fix",
          label: "Fix Session",
          status: "running",
        });
        expect(restarted.sessions.at(-1)?.sdkSessionId).not.toBe(session.sdkSessionId);
      });
    });

    test.each(["planned", "running"] as const)(
      "restarts the %s validation run instead of the agent turn",
      async (status) => {
        await withService(async (service, storage, provider, invocations) => {
          const { started, session } = await startBuilding(service, storage);
          const original = newReviewValidationRun("validation-original", {
            headRef: "1".repeat(40),
            commands: [],
            limitations: ["No validation command is configured for this test"],
          });
          await mutateStored(storage, started.id, (snapshot) => {
            snapshot.validationRun = { ...original, status };
            snapshot.iteration = 2;
            snapshot.sessions[snapshot.currentSessionIndex]!.iteration = 2;
            snapshot.sessions[snapshot.currentSessionIndex]!.status = "idle";
            snapshot.sessions[snapshot.currentSessionIndex]!.completedAt = new Date().toISOString();
          });

          const restarted = await service.restartCurrentStep(started.id);

          expect(restarted.validationRun?.id).not.toBe(original.id);
          expect(restarted.validationRun?.status).toBe("running");
          expect(restarted.iteration).toBe(2);
          expect(restarted.rewinds?.at(-1)).toMatchObject({
            iteration: 2,
            supersededSessions: 0,
            validationRun: { ...original, status: "cancelled" },
          });
          expect(restarted.sessions.every((entry) => !entry.supersededBy)).toBe(true);
          expect(restarted.sessions.at(-1)?.sdkSessionId).toBe(session.sdkSessionId);
          expect(provider.aborted).toEqual([]);
          expect(invocations.some(({ command }) => command === "start_review_validation")).toBe(
            true,
          );
        });
      },
    );

    test.each(["cancelled", "retry"] as const)(
      "regenerates review preparation after a %s validation run",
      async (reason) => {
        await withService(async (service, storage, _provider, invocations) => {
          const { started } = await startBuilding(service, storage);
          await mutateStored(storage, started.id, (snapshot) => {
            snapshot.validationRun = {
              ...newReviewValidationRun("validation-original", {
                headRef: "1".repeat(40),
                commands: [],
                limitations: ["No validation command is configured for this test"],
              }),
              status: reason === "cancelled" ? "cancelled" : "planned",
            };
            if (reason === "retry") snapshot.reviewRetryRequested = true;
          });

          const restarted = await service.restartCurrentStep(started.id);

          expect(restarted.phase).toBe("fixing");
          expect(restarted.sessions.at(-1)).toMatchObject({
            phase: "fix",
            label: REVIEW_PACKAGE_SESSION_LABEL,
            status: "running",
          });
          expect(restarted.validationRun).toBeUndefined();
          expect(invocations.some(({ command }) => command === "start_review_validation")).toBe(
            false,
          );
        });
      },
    );

    test("restarts the dedicated review preparation session", async () => {
      await withService(async (service, storage, provider) => {
        const { started } = await startBuilding(service, storage, {
          reviewPreparation: { agent: "claude" },
        });
        provider.runningPhases.add("fix");
        await service.advanceNow(started.id);
        const preparation = (await pipeline(storage, started.id)).sessions.at(-1)!;
        expect(preparation.label).toBe(REVIEW_PACKAGE_SESSION_LABEL);

        const restarted = await service.restartCurrentStep(started.id);

        expect(provider.aborted).toContain(preparation.sdkSessionId);
        expect(restarted.sessions.at(-1)).toMatchObject({
          phase: "fix",
          label: REVIEW_PACKAGE_SESSION_LABEL,
          status: "running",
        });
        expect(restarted.sessions.at(-1)?.sdkSessionId).not.toBe(preparation.sdkSessionId);
      });
    });

    test.each([
      ["review", "reviewing"],
      ["address", "addressing"],
      ["pr", "creating-pr"],
      ["resolve-conflicts", "resolving-conflicts"],
    ] as const)("restarts the running %s session", async (sessionPhase, phase) => {
      await withService(async (service, storage, provider) => {
        const started = await service.start(startInput());
        for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
        const staged = await mutateStored(storage, started.id, (snapshot) => {
          snapshot.phase = phase;
          snapshot.sessions.push({
            phase: sessionPhase,
            agent: "claude",
            iteration: snapshot.iteration,
            sessionKey: `running-${sessionPhase}`,
            sdkSessionId: `running-${sessionPhase}`,
            status: "running",
            startedAt: new Date().toISOString(),
            label: `${sessionPhase} Session`,
          });
          snapshot.currentSessionIndex = snapshot.sessions.length - 1;
        });
        const previous = staged.sessions.at(-1)!;

        const restarted = await service.restartCurrentStep(started.id);

        expect(provider.aborted).toContain(previous.sdkSessionId);
        expect(restarted.phase).toBe(phase);
        expect(restarted.sessions.at(-1)).toMatchObject({ phase: sessionPhase, status: "running" });
        expect(restarted.sessions.at(-1)?.sdkSessionId).not.toBe(previous.sdkSessionId);
      });
    });

    test("restarts the verification it is on without re-running the review", async () => {
      await withService(async (service, storage, provider) => {
        const started = await service.start(startInput());
        for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
        let completed = await pipeline(storage, started.id);
        const verificationIndex = completed.sessions.findIndex(
          (session) => session.phase === "verify",
        );
        completed = await mutateStored(storage, started.id, (snapshot) => {
          snapshot.phase = "verifying";
          snapshot.currentSessionIndex = verificationIndex;
          snapshot.sessions[verificationIndex]!.status = "running";
          delete snapshot.sessions[verificationIndex]!.completedAt;
        });
        const verification = completed.sessions[verificationIndex]!;

        const restarted = await service.restartCurrentStep(started.id);

        expect(provider.aborted).toContain(verification.sdkSessionId);
        expect(restarted.phase).toBe("verifying");
        expect(restarted.structuredReview).toEqual(completed.structuredReview);
        expect(reviewSessionCount(restarted)).toBe(reviewSessionCount(completed));
        expect(restarted.sessions.at(-1)).toMatchObject({ phase: "verify", status: "running" });
        expect(restarted.sessions.at(-1)?.sdkSessionId).not.toBe(verification.sdkSessionId);
      });
    });

    test("restarts the stage a paused pipeline paused in", async () => {
      await withService(async (service, storage) => {
        const started = await service.start(startInput());
        for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
        let completed = await pipeline(storage, started.id);
        const verificationIndex = completed.sessions.findIndex(
          (session) => session.phase === "verify",
        );
        completed = await mutateStored(storage, started.id, (snapshot) => {
          snapshot.phase = "paused";
          snapshot.pausedFromPhase = "verifying";
          snapshot.currentSessionIndex = verificationIndex;
        });

        const restarted = await service.restartCurrentStep(started.id);

        expect(restarted.phase).toBe("verifying");
        expect(restarted.pausedFromPhase).toBeUndefined();
        expect(reviewSessionCount(restarted)).toBe(reviewSessionCount(completed));
        expect(restarted.sessions.at(-1)).toMatchObject({ phase: "verify", status: "running" });
      });
    });

    test("restarts the phase it has entered before that stage's session exists", async () => {
      await withService(async (service, storage) => {
        const started = await service.start(startInput());
        for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
        const completed = await mutateStored(storage, started.id, (snapshot) => {
          // The previous stage's session is still current until the next tick
          // opens the verification; restarting it would rewind the pipeline.
          snapshot.phase = "verifying";
          snapshot.currentSessionIndex =
            snapshot.sessions.findIndex((session) => session.phase === "verify") - 1;
        });
        const previous = completed.sessions[completed.currentSessionIndex]!;
        expect(previous.phase).not.toBe("verify");
        const previousCount = completed.sessions.filter(
          (session) => session.phase === previous.phase,
        ).length;

        const restarted = await service.restartCurrentStep(started.id);

        expect(restarted.phase).toBe("verifying");
        expect(
          restarted.sessions.filter((session) => session.phase === previous.phase),
        ).toHaveLength(previousCount);
        expect(restarted.sessions.at(-1)).toMatchObject({ phase: "verify", status: "running" });
      });
    });

    test("refuses a build with no running stage", async () => {
      await withService(async (service, storage) => {
        const started = await service.start(startInput());
        for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
        expect((await pipeline(storage, started.id)).phase).toBe("complete");

        await expect(service.restartCurrentStep(started.id)).rejects.toThrow(
          "This build has no running stage to restart",
        );
      });
    });
  });

  test("restarting a build that also wrote the package plan runs the build again", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
      const completed = await pipeline(storage, started.id);
      const preparation = completed.sessions.find((session) =>
        isReviewPackagePreparationSession(session, completed),
      )!;
      expect(preparation).toMatchObject({ phase: "build", producedReviewPackagePlan: true });

      const restarted = await service.restartStep(started.id, preparation.sdkSessionId);

      expect(restarted.phase).toBe("building");
      expect(restarted.reviewPackage).toBeUndefined();
      expect(restarted.validationRun).toBeUndefined();
      expect(restarted.sessions.at(-1)).toMatchObject({
        phase: "build",
        label: "Build Session",
        status: "running",
      });
      expect(isReviewPackagePreparationSession(restarted.sessions.at(-1), restarted)).toBe(true);
      expect(restarted.sessions.filter((session) => !session.supersededBy)).toHaveLength(1);
    });
  });

  test("restarts a dedicated review-package preparation session as a first-class stage", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput({ reviewPreparation: { agent: "claude" } }));
      for (let pass = 0; pass < 10; pass += 1) await service.advanceNow(started.id);
      const completed = await pipeline(storage, started.id);
      expect(completed.phase).toBe("complete");
      const preparation = completed.sessions.find(
        (session) => session.label === REVIEW_PACKAGE_SESSION_LABEL,
      )!;
      expect(preparation).toBeDefined();

      const restarted = await service.restartStep(started.id, preparation.sdkSessionId);

      expect(restarted.reviewPackage).toBeUndefined();
      expect(restarted.validationRun).toBeUndefined();
      expect(restarted.sessions.at(-1)).toMatchObject({
        phase: "fix",
        label: REVIEW_PACKAGE_SESSION_LABEL,
        status: "running",
      });
      // The build before the preparation is kept; the preparation and every
      // later step are the previous attempt.
      expect(
        restarted.sessions
          .filter((session) => !session.supersededBy)
          .map((session) => session.label),
      ).toEqual(["Build Session", REVIEW_PACKAGE_SESSION_LABEL]);
    });
  });

  test.each(["build", "fix", "verify", "pr", "resolve-conflicts"] as const)(
    "restarts a completed %s stage through the durable supervisor request",
    async (phase) => {
      await withService(async (service, storage) => {
        const started = await service.start(startInput());
        for (let pass = 0; pass < 6; pass += 1) await service.advanceNow(started.id);
        let completed = await pipeline(storage, started.id);
        let target = completed.sessions.find(
          (session) =>
            session.phase === phase && !isReviewPackagePreparationSession(session, completed),
        );
        if (!target) {
          completed = await mutateStored(storage, started.id, (snapshot) => {
            snapshot.sessions.push({
              phase,
              agent: "claude",
              iteration: snapshot.iteration,
              sessionKey: `synthetic-${phase}`,
              sdkSessionId: `synthetic-${phase}`,
              status: "idle",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              label: `${phase} session`,
            });
            if (phase === "fix") snapshot.verificationFeedback = "Apply the requested repair";
          });
          target = completed.sessions.at(-1)!;
        }

        const restarted = await service.restartStep(started.id, target.sdkSessionId);

        expect(restarted.restartRequest).toBeUndefined();
        expect(restarted.sessions.at(-1)).toMatchObject({ phase, status: "running" });
        expect(restarted.sessions.at(-1)?.sdkSessionId).not.toBe(target.sdkSessionId);
      });
    },
  );

  test("restarts a fan-out review and abandons every prior reviewer session", async () => {
    await withService(async (service, storage, provider) => {
      provider.runningPhases.add("review");
      const started = await service.start(
        startInput({
          reviewers: [
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ],
        }),
      );
      let reviewing = await pipeline(storage, started.id);
      for (let pass = 0; pass < 12; pass += 1) {
        const projectedSessionIds = new Set(
          reviewing.sessions.map((session) => session.sdkSessionId),
        );
        const reviewerSessionIds =
          reviewing.reviewFanout?.reviewers
            .map((reviewer) => reviewer.providerSessionId)
            .filter((id): id is string => id !== undefined) ?? [];
        if (
          reviewerSessionIds.length === 2 &&
          reviewerSessionIds.every((id) => projectedSessionIds.has(id))
        ) {
          break;
        }
        await service.advanceNow(started.id);
        reviewing = await pipeline(storage, started.id);
      }
      expect(reviewing.reviewFanout).toBeDefined();
      const oldReviewerSessionIds = reviewing
        .reviewFanout!.reviewers.map((reviewer) => reviewer.providerSessionId)
        .filter((id): id is string => id !== undefined);
      const target = reviewing.sessions.find(
        (session) => session.sdkSessionId === oldReviewerSessionIds[0],
      )!;

      const restarted = await service.restartStep(started.id, target.sdkSessionId);

      expect(provider.aborted).toEqual(expect.arrayContaining(oldReviewerSessionIds));
      expect(restarted.phase).toBe("reviewing");
      expect(restarted.reviewFanout).toBeDefined();
      expect(
        restarted.reviewFanout?.reviewers.map((reviewer) => reviewer.providerSessionId),
      ).not.toEqual(oldReviewerSessionIds);
    });
  });

  test("fails a local build cleanly when the project has no host checkout", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-no-checkout-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    // What `create_environment` now answers for a remote-only project.
    const rejection = "Project has no local path - cannot create a local worktree";
    const invoke = async <T>(command: string): Promise<T> => {
      if (command !== "create_environment") {
        throw new Error(`Unexpected command: ${command}`);
      }
      throw new Error(rejection);
    };
    const service = new BuildPipelineService(storage, invoke, {
      autoAdvance: false,
      provider: async () => new FakeProvider(),
    });

    try {
      await expect(
        service.start(
          startInput({
            existingEnvironmentId: undefined,
            environmentType: "local",
          }),
        ),
      ).rejects.toThrow(rejection);

      // The rejection must land as a terminal, explained failure rather than
      // leaving the pipeline parked in `creating-environment` forever.
      const pipelines = await storage.listBuildPipelines("project-1");
      expect(pipelines).toHaveLength(1);
      const pipeline = pipelines[0]!.snapshot as BuildPipeline;
      expect(pipeline.phase).toBe("failed");
      expect(pipeline.error).toContain(rejection);
      expect(pipeline.environmentId).toBeFalsy();
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  for (const status of ["missing", "error"] as const) {
    test(`fails durably when provider status is ${status}`, async () => {
      await withService(async (service, storage, provider) => {
        const started = await service.start(startInput());
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        provider.status = async () => status;
        await service.advanceNow(started.id);
        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "failed",
          error: expect.stringContaining(status === "missing" ? "no longer available" : "failed"),
        });
      });
    });
  }

  test("persists the provider's session failure detail", async () => {
    await withService(async (service, storage, provider) => {
      const { started } = await startBuilding(service, storage);
      provider.status = async () => {
        throw new Error("The codex session failed: stream disconnected before completion");
      };

      await service.advanceNow(started.id);

      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "failed",
        error: "The codex session failed: stream disconnected before completion",
      });
    });
  });

  for (const result of ["rejected", "provider-unavailable"] as const) {
    test(`fails safely when the provider interaction response is ${result}`, async () => {
      await withService(async (service, storage, provider) => {
        const started = await service.start(startInput({ taskId: `task-${result}` }));
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        const running = await pipeline(storage, started.id);
        const session = running.sessions[running.currentSessionIndex]!;
        const request = pendingQuestion(session.sdkSessionId, `${result}-question`);
        (
          provider as unknown as BuildPipelineProvider & {
            interactions: NonNullable<BuildPipelineProvider["interactions"]>;
          }
        ).interactions = {
          async listPendingInteractions() {
            return {
              version: AGENT_INTERACTION_CONTRACT_VERSION,
              revision: 1,
              requests: [request],
            };
          },
          async resolveInteraction(sessionId, interactionId) {
            return { result, sessionId, interactionId, revision: 1 };
          },
        };

        await service.advanceNow(started.id);
        expect(await pipeline(storage, started.id)).toMatchObject({
          phase: "failed",
          failureContext: {
            kind: "interactive-request",
            requestId: request.id,
          },
        });
        const journal = await storage.getAgentInteractionResolutionJournal();
        expect(journal.entries.find((entry) => entry.interactionId === request.id)).toMatchObject({
          state: "workflow-recorded",
          outcome: "failed",
        });
      });
    });
  }

  for (const concurrentAction of ["pause", "cancel"] as const) {
    test(`terminal authorization outcome merges over a concurrent ${concurrentAction}`, async () => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        const started = await service.start(startInput());
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        const running = await pipeline(storage, started.id);
        const session = running.sessions[running.currentSessionIndex]!;
        const request: AgentInteractionRequest = {
          ...pendingQuestion(session.sdkSessionId, `authorization-${concurrentAction}`),
          kind: "permission",
          presentation: {
            title: "Authorize an unexpected privilege",
            questions: [],
          },
        };
        let requests = [request];
        let resolveCalls = 0;
        let resolutionAction = "";
        (
          provider as unknown as BuildPipelineProvider & {
            interactions: NonNullable<BuildPipelineProvider["interactions"]>;
          }
        ).interactions = {
          async listPendingInteractions() {
            return {
              version: AGENT_INTERACTION_CONTRACT_VERSION,
              revision: resolveCalls,
              requests,
            };
          },
          async resolveInteraction(sessionId, interactionId, resolution) {
            resolveCalls += 1;
            resolutionAction = resolution.action;
            requests = [];
            return { result: "applied", sessionId, interactionId, revision: 1 };
          },
        };
        const concurrentStorage = new StorageService(controls.dataDir);
        await concurrentStorage.init();
        const concurrentService = new BuildPipelineService(
          concurrentStorage,
          async <T>(): Promise<T> => {
            throw new Error("No backend command is expected");
          },
          { autoAdvance: false, provider: async () => provider },
        );
        const originalUpdateJournal = storage.updateAgentInteractionResolutionJournal.bind(storage);
        let releaseProviderResolved!: () => void;
        const providerResolved = new Promise<void>((resolve) => {
          releaseProviderResolved = resolve;
        });
        let allowOutcomeSave!: () => void;
        const outcomeSaveAllowed = new Promise<void>((resolve) => {
          allowOutcomeSave = resolve;
        });
        let blockedProviderResolved = false;
        storage.updateAgentInteractionResolutionJournal = async (...args) => {
          const journal = await originalUpdateJournal(...args);
          if (
            !blockedProviderResolved &&
            journal.entries.some(
              (entry) => entry.interactionId === request.id && entry.state === "provider-resolved",
            )
          ) {
            blockedProviderResolved = true;
            releaseProviderResolved();
            await outcomeSaveAllowed;
          }
          return journal;
        };
        try {
          const advancing = service.advanceNow(started.id);
          await providerResolved;

          if (concurrentAction === "pause") {
            const paused = await concurrentService.pause(started.id);
            expect(paused).toMatchObject({
              phase: "paused",
              pausedFromPhase: "building",
            });
          } else {
            const cancelled = await concurrentService.cancel(started.id);
            expect(cancelled).toMatchObject({
              phase: "failed",
              error: "Build cancelled",
            });
          }
          allowOutcomeSave();
          await advancing;

          const resolved = await pipeline(storage, started.id);
          expect(isBuildPipeline(resolved)).toBe(true);
          expect(blockedProviderResolved).toBe(true);
          expect(resolveCalls).toBe(1);
          expect(resolutionAction).toBe("deny");
          expect(resolved.pendingInteractionResolution).toBeUndefined();
          if (concurrentAction === "pause") {
            expect(resolved).toMatchObject({
              phase: "failed",
              error: expect.stringContaining("requested unexpected authorization"),
              failureContext: {
                phase: "building",
                kind: "interactive-request",
                sessionId: session.sdkSessionId,
                requestId: request.id,
              },
            });
            expect(resolved.pausedFromPhase).toBeUndefined();
          } else {
            expect(resolved).toMatchObject({
              phase: "failed",
              error: "Build cancelled",
            });
          }
          const journal = await storage.getAgentInteractionResolutionJournal();
          expect(journal.entries).toContainEqual(
            expect.objectContaining({
              interactionId: request.id,
              state: "workflow-recorded",
              outcome: "denied",
            }),
          );
        } finally {
          allowOutcomeSave();
          storage.updateAgentInteractionResolutionJournal = originalUpdateJournal;
          await concurrentService.shutdown();
        }
      });
    });
  }

  for (const [label, legacyMessage, expectedRequestId] of [
    [
      "nested provider metadata",
      { info: { role: "user", id: "legacy-info-request" } },
      "legacy-info-request",
    ],
    ["an explicit requestId", { requestId: "legacy-explicit-request" }, "legacy-explicit-request"],
    [
      "a top-level user message",
      { id: "legacy-user-request", role: "user" },
      "legacy-user-request",
    ],
  ] as const) {
    test(`recovers a legacy verification request id from ${label}`, async () => {
      await withService(async (service, storage, provider) => {
        const verifying = await startVerifying(service, storage);
        const record = await storage.getBuildPipeline(verifying.id);
        if (!record) throw new Error("Pipeline disappeared");
        const snapshot = record.snapshot as BuildPipeline;
        const session = snapshot.sessions[snapshot.currentSessionIndex]!;
        delete session.structuredRequestId;
        await storage.saveBuildPipeline(
          snapshot.id,
          snapshot.projectId,
          snapshot.environmentId,
          record.version,
          snapshot,
          record.revision,
        );

        provider.messages = async (sessionId) =>
          provider.phases.get(sessionId) === "verify" ? [legacyMessage] : [];
        let observedRequestId = "";
        provider.structured = async <T>(
          sessionId: string,
          requestId: string,
        ): Promise<StructuredOutputResult<T>> => {
          observedRequestId = requestId;
          return {
            ok: true,
            provider: "claude",
            requestId,
            value: (provider.phases.get(sessionId) === "review"
              ? cleanReview
              : { complete: true, rationale: "Recovered." }) as T,
          };
        };

        await service.advanceNow(verifying.id);

        expect(observedRequestId).toBe(expectedRequestId);
        expect((await pipeline(storage, verifying.id)).phase).toBe("creating-pr");
      });
    });
  }

  test("recovers a legacy verification request after its transcript left the control record", async () => {
    await withService(async (service, storage, provider) => {
      const verifying = await startVerifying(service, storage);
      const record = await storage.getBuildPipeline(verifying.id);
      if (!record) throw new Error("Pipeline disappeared");
      const snapshot = record.snapshot as BuildPipeline;
      const session = snapshot.sessions[snapshot.currentSessionIndex]!;
      // A record written before the request id was persisted, whose transcript
      // was still inline.
      delete session.structuredRequestId;
      session.messages = [{ info: { role: "user", id: "legacy-inline-request" } }];
      await storage.saveBuildPipeline(
        snapshot.id,
        snapshot.projectId,
        snapshot.environmentId,
        record.version,
        snapshot,
        record.revision,
      );
      expect(await storage.migrateBuildPipelineTranscripts()).toMatchObject({ migrated: 1 });
      const migrated = (await pipeline(storage, verifying.id)).sessions.at(-1)!;
      expect(migrated.messages).toBeUndefined();
      expect(migrated.legacyStructuredRequestId).toBe("legacy-inline-request");

      // Nothing inline, and the provider has nothing to offer either.
      provider.messages = async () => [];
      let observedRequestId = "";
      provider.structured = async <T>(
        _sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => {
        observedRequestId = requestId;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: { complete: true, rationale: "Recovered." } as T,
        };
      };

      await service.advanceNow(verifying.id);

      expect(observedRequestId).toBe("legacy-inline-request");
      expect((await pipeline(storage, verifying.id)).phase).toBe("creating-pr");
    });
  });

  test("loops through fix work and stops at the verification iteration bound", async () => {
    await withService(async (service, storage, provider) => {
      provider.structured = async <T>(
        sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => ({
        ok: true,
        provider: "claude",
        requestId,
        value: (provider.phases.get(sessionId) === "review"
          ? cleanReview
          : provider.phases.get(sessionId) === "build" || provider.phases.get(sessionId) === "fix"
            ? TEST_REVIEW_PREPARATION
            : { complete: false, rationale: "Still failing acceptance checks." }) as T,
      });
      const started = await service.start(startInput({ maxIterations: 1 }));
      for (let pass = 0; pass < 8; pass += 1) {
        await service.advanceNow(started.id);
      }
      const failed = await pipeline(storage, started.id);
      expect(failed).toMatchObject({
        phase: "failed",
        iteration: 1,
        verificationResult: "fail",
        error: expect.stringContaining("failed after 1 iterations"),
      });
      expect(failed.sessions.map((session) => session.phase)).toEqual([
        "build",
        "review",
        "verify",
        "fix",
        "review",
        "verify",
      ]);
      const retainedReports = failed.sessions.filter((session) => session.reviewReport);
      expect(retainedReports).toHaveLength(1);
      expect(retainedReports[0]?.iteration).toBe(failed.iteration);
    });
  });

  test("persists a conflicting PR and completes only after resolution is verified", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      controls.detection = {
        url: "https://github.com/acme/repo/pull/9",
        state: "open",
        hasMergeConflicts: true,
      };
      const started = await service.start(startInput());
      for (let pass = 0; pass < 6; pass += 1) {
        await service.advanceNow(started.id);
      }
      expect(await pipeline(storage, started.id)).toMatchObject({
        phase: "resolving-conflicts",
      });
      controls.detection = {
        ...controls.detection,
        hasMergeConflicts: null,
      };
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("resolving-conflicts");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/9",
        hasMergeConflicts: null,
      });
      controls.detection = {
        ...controls.detection,
        hasMergeConflicts: false,
      };
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).phase).toBe("complete");
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/9",
        hasMergeConflicts: false,
      });
    });
  });

  for (const result of ["already-resolved", "stale"] as const) {
    for (const kind of ["question", "permission"] as const) {
      test(`reconciles an ${result} ${kind} to a terminal outcome once it is gone`, async () => {
        await withService(async (service, storage, provider) => {
          const { started, session } = await startBuilding(service, storage, {
            taskId: `task-${result}-${kind}`,
          });
          const request: AgentInteractionRequest = {
            ...pendingQuestion(session.sdkSessionId, `${result}-${kind}`),
            kind,
          };
          let requests = [request];
          let resolveCalls = 0;
          installInteractions(provider, {
            async listPendingInteractions() {
              return {
                version: AGENT_INTERACTION_CONTRACT_VERSION,
                revision: 1,
                requests,
              };
            },
            async resolveInteraction(sessionId, interactionId) {
              resolveCalls += 1;
              // The provider had already applied the response; the reconcile
              // read is the only evidence that it is terminal and not failed.
              requests = [];
              return { result, sessionId, interactionId, revision: 2 };
            },
          });

          await service.advanceNow(started.id);

          expect(resolveCalls).toBe(1);
          const resolved = await pipeline(storage, started.id);
          const journalEntry = (await storage.getAgentInteractionResolutionJournal()).entries.find(
            (entry) => entry.interactionId === request.id,
          );
          if (kind === "question") {
            expect(resolved).toMatchObject({
              phase: "building",
              autoDeclineCount: 1,
            });
            expect(journalEntry).toMatchObject({
              state: "workflow-recorded",
              outcome: "auto-declined",
            });
          } else {
            expect(resolved).toMatchObject({
              phase: "failed",
              error: expect.stringContaining("requested unexpected authorization"),
              failureContext: {
                kind: "interactive-request",
                requestId: request.id,
              },
            });
            expect(journalEntry).toMatchObject({
              state: "workflow-recorded",
              outcome: "denied",
            });
          }
        });
      });
    }
  }

  test("refuses to persist a structurally invalid pipeline snapshot", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      await service.advanceNow(started.id);
      // A bridge answering with an empty session id would otherwise commit a
      // snapshot every later read rejects, hiding the pipeline permanently.
      provider.createSession = async () => "";

      await service.advanceNow(started.id);

      const refused = await pipeline(storage, started.id);
      expect(refused).toMatchObject({
        phase: "failed",
        error: `Refusing to persist an invalid build pipeline snapshot: ${started.id}`,
      });
      expect(refused.sessions).toEqual([]);
      expect(isBuildPipeline(refused)).toBe(true);
    });
  });

  for (const action of ["pause", "cancel"] as const) {
    test(`${action} clears a stall warning that no longer applies`, async () => {
      await withService(async (service, storage) => {
        const { started, session } = await startBuilding(service, storage);
        await mutateStored(storage, started.id, (snapshot) => {
          snapshot.stallWarning = {
            sessionId: session.sdkSessionId,
            detectedAt: new Date().toISOString(),
          };
        });

        const result =
          action === "pause" ? await service.pause(started.id) : await service.cancel(started.id);

        // The warning says the stage "is still running"; a stopped build is not,
        // and no later pass would ever clear it.
        expect(result.phase).toBe(action === "pause" ? "paused" : "failed");
        expect(result.stallWarning).toBeUndefined();
        expect((await pipeline(storage, started.id)).stallWarning).toBeUndefined();
      });
    });
  }
});
