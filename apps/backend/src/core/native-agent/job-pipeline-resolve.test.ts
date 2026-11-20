import { describe, expect, mock, test } from "bun:test";
import {
  isBuildPipeline,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import type { CommandContext } from "../commands-context.js";
import type { PersistedBuildPipeline } from "../models.js";
import {
  adoptPipelineResolveSessionIntoTab,
  latestPipelineResolveSession,
  pipelineResolveTabId,
} from "./job-pipeline-resolve.js";
import { NativeAgentProviderSessionMissingError } from "./service.js";

function session(overrides: Partial<PipelineSession> = {}): PipelineSession {
  return {
    phase: "resolve-conflicts",
    agent: "codex",
    model: "gpt-resolve",
    reasoningEffort: "high",
    iteration: 1,
    sessionKey: "pipeline-1:resolve-conflicts:1:a",
    sdkSessionId: "provider-pipeline-resolve",
    status: "idle",
    startedAt: "2026-11-15T10:00:00.000Z",
    completedAt: "2026-11-15T10:10:00.000Z",
    label: "Resolve Conflicts",
    ...overrides,
  };
}

function pipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "claude",
    phase: "complete",
    sessions: [session()],
    currentSessionIndex: 0,
    iteration: 1,
    maxIterations: 3,
    createdAt: "2026-11-15T09:00:00.000Z",
    taskTitle: "Conflicts",
    taskSnapshot: {
      title: "Conflicts",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}

function record(snapshot: BuildPipeline): PersistedBuildPipeline {
  return {
    version: 1,
    id: snapshot.id,
    projectId: snapshot.projectId,
    environmentId: snapshot.environmentId,
    snapshot: snapshot as unknown as Record<string, unknown>,
    updatedAt: snapshot.createdAt,
    revision: snapshot.backendRevision,
  } as PersistedBuildPipeline;
}

const anyAgent = () => true;

describe("latestPipelineResolveSession", () => {
  test("the fixture is a pipeline the storage reader accepts", () => {
    expect(isBuildPipeline(pipeline())).toBe(true);
  });

  test("picks the newest resolve session of a settled pipeline in this environment", () => {
    const older = pipeline({ id: "older", sessions: [session({ sdkSessionId: "older" })] });
    const newer = pipeline({
      id: "newer",
      phase: "failed",
      sessions: [
        session({ phase: "build", sdkSessionId: "build" }),
        session({ sdkSessionId: "newer", completedAt: "2026-11-15T11:00:00.000Z" }),
      ],
    });
    const elsewhere = pipeline({
      id: "elsewhere",
      environmentId: "env-2",
      sessions: [session({ sdkSessionId: "elsewhere", completedAt: "2026-11-16T00:00:00.000Z" })],
    });
    expect(
      latestPipelineResolveSession([older, newer, elsewhere], "env-1", anyAgent),
    ).toMatchObject({ pipelineId: "newer", agent: "codex", session: { sdkSessionId: "newer" } });
  });

  test("leaves a session the pipeline may still drive", () => {
    expect(
      latestPipelineResolveSession([pipeline({ phase: "resolving-conflicts" })], "env-1", anyAgent),
    ).toBeNull();
    expect(
      latestPipelineResolveSession([pipeline({ phase: "paused" })], "env-1", anyAgent),
    ).toBeNull();
    expect(
      latestPipelineResolveSession(
        [pipeline({ sessions: [session({ status: "running" })] })],
        "env-1",
        anyAgent,
      ),
    ).toBeNull();
  });

  test("falls back to the pipeline's agent and honours the caller's agent filter", () => {
    const legacy = pipeline({ sessions: [session({ agent: undefined })] });
    expect(latestPipelineResolveSession([legacy], "env-1", anyAgent)?.agent).toBe("claude");
    expect(
      latestPipelineResolveSession([pipeline()], "env-1", (agent) => agent === "claude"),
    ).toBeNull();
  });
});

describe("adoptPipelineResolveSessionIntoTab", () => {
  function harness(
    options: {
      tabs?: unknown[];
      pipelines?: BuildPipeline[];
      adoptError?: Error;
      authorized?: boolean;
    } = {},
  ) {
    const adoptSession = mock(async (input: { providerSessionId: string }) => {
      if (options.adoptError) throw options.adoptError;
      return { providerSessionId: input.providerSessionId };
    });
    const ensureNativeAgentJobTab = mock(async () => ({}));
    const context = {
      nativeAgents: { adoptSession },
      storage: {
        getPaneLayout: async () => ({
          root: { kind: "leaf", id: "default", tabs: options.tabs ?? [], activeTabId: null },
        }),
        getEnvironment: async (id: string) =>
          id === "env-1" ? { id: "env-1", projectId: "project-1" } : null,
        listBuildPipelinesForEnvironment: async () =>
          (options.pipelines ?? [pipeline()]).map(record),
        ensureNativeAgentJobTab,
      },
    } as unknown as CommandContext;
    const adopt = () =>
      adoptPipelineResolveSessionIntoTab(context, {
        environmentId: "env-1",
        agent: "claude",
        enabledAgents: ["claude", "codex"],
        tabReuse: "any-agent",
        title: "Resolve",
        authorized: async () => options.authorized !== false,
      });
    return { adopt, adoptSession, ensureNativeAgentJobTab };
  }

  test("opens the pipeline's resolve session as the Resolve tab", async () => {
    const h = harness();
    const tabId = await h.adopt();
    const expectedTabId = pipelineResolveTabId("env-1", {
      pipelineId: "pipeline-1",
      session: session(),
    });
    expect(tabId).toBe(expectedTabId);
    expect(h.adoptSession).toHaveBeenCalledTimes(1);
    expect(h.adoptSession.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: `env-env-1:${expectedTabId}`,
      providerSessionId: "provider-pipeline-resolve",
      origin: "interactive-native",
      model: "gpt-resolve",
      reasoningEffort: "high",
      sessionMode: "build",
    });
    expect(h.ensureNativeAgentJobTab).toHaveBeenCalledWith({
      environmentId: "env-1",
      tabId: expectedTabId,
      agent: "codex",
      providerSessionId: "provider-pipeline-resolve",
      title: "Resolve",
      activate: false,
      completionAction: "refresh-pr-after-agent-completion",
    });
  });

  test("leaves an open Resolve tab alone", async () => {
    const h = harness({
      tabs: [
        {
          id: "agent-job-open",
          type: "agent-native",
          title: "Resolve",
          jobCompletionAction: "refresh-pr-after-agent-completion",
          nativeAgentData: { platform: "claude" },
        },
      ],
    });
    expect(await h.adopt()).toBeNull();
    expect(h.adoptSession).not.toHaveBeenCalled();
  });

  test("does nothing without a candidate or once the launch is no longer authorized", async () => {
    const none = harness({ pipelines: [pipeline({ sessions: [session({ phase: "build" })] })] });
    expect(await none.adopt()).toBeNull();
    expect(none.adoptSession).not.toHaveBeenCalled();
    const revoked = harness({ authorized: false });
    expect(await revoked.adopt()).toBeNull();
    expect(revoked.adoptSession).not.toHaveBeenCalled();
  });

  test("a session the provider no longer has leaves the caller to open a new tab", async () => {
    const h = harness({ adoptError: new NativeAgentProviderSessionMissingError() });
    expect(await h.adopt()).toBeNull();
    expect(h.ensureNativeAgentJobTab).not.toHaveBeenCalled();
  });
});
