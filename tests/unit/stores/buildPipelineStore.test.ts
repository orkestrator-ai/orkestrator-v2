import { beforeEach, describe, expect, test } from "bun:test";
import {
  BUILD_PIPELINE_VERSION,
  type BuildPhase,
  type BuildPipeline,
  buildPipelineStore,
  isActiveBuildPhase,
  isBuildPipeline,
  isWorkingBuildPipeline,
} from "../../../apps/web/src/stores/buildPipelineStore";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";

const NOW = "2026-07-29T08:00:00.000Z";

function pipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: NOW,
    taskTitle: "Test task",
    taskSnapshot: {
      title: "Test task",
      description: "Test description",
      acceptanceCriteria: "The behavior works",
      comments: [{ text: "Keep the API compatible" }],
      images: [],
    },
    source: { type: "kanban", taskId: "task-1" },
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}

describe("buildPipelineStore backend projection", () => {
  beforeEach(() => {
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
      activeBuildEnvironmentIds: new Set(),
      viewedSessionIds: new Map(),
    });
  });

  test("starts empty and exposes the current snapshot version", () => {
    expect(appCommandStore(buildPipelineStore).getState().pipelines.size).toBe(0);
    expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds.size).toBe(0);
    expect(BUILD_PIPELINE_VERSION).toBeGreaterThan(0);
  });

  test("classifies terminal and active phases", () => {
    const phases: BuildPhase[] = [
      "creating-environment",
      "starting-environment",
      "waiting-for-setup",
      "building",
      "reviewing",
      "addressing",
      "verifying",
      "fixing",
      "creating-pr",
      "resolving-conflicts",
      "paused",
      "complete",
      "failed",
    ];
    expect(phases.filter(isActiveBuildPhase)).toEqual(phases.slice(0, -3));
  });

  test("accepts a complete backend-owned snapshot", () => {
    const snapshot = pipeline({
      sessions: [
        {
          phase: "build",
          iteration: 0,
          sessionKey: "env-1:build",
          sdkSessionId: "session-1",
          status: "running",
          startedAt: NOW,
          label: "Build",
          messages: [{ role: "assistant", content: "working" }],
        },
      ],
      currentSessionIndex: 0,
      featurePlanId: "feature-1",
      sourceLinkedAt: NOW,
    });

    expect(isBuildPipeline(snapshot)).toBe(true);
    appCommandStore(buildPipelineStore).getState().replacePipeline(snapshot);
    expect(appCommandStore(buildPipelineStore).getState().pipelines.get(snapshot.id)).toBe(
      snapshot,
    );
    expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds).toEqual(
      new Set(["env-1"]),
    );
    expect(appCommandStore(buildPipelineStore).getState().activeBuildEnvironmentIds).toEqual(
      new Set(["env-1"]),
    );
  });

  test.each([
    ["client-authored controller", { controller: "renderer" }],
    ["blank id", { id: "" }],
    ["blank task id", { taskId: "" }],
    ["blank project id", { projectId: "" }],
    ["unknown phase", { phase: "deploying" }],
    ["unknown agent", { agentType: "other" }],
    ["invalid environment type", { environmentType: "remote" }],
    ["negative revision", { backendRevision: -1 }],
    ["fractional iteration", { iteration: 0.5 }],
    ["zero max iterations", { maxIterations: 0 }],
    ["invalid empty-session index", { currentSessionIndex: 0 }],
    ["malformed task snapshot", { taskSnapshot: null }],
  ] as const)("rejects %s", (_label, override) => {
    expect(isBuildPipeline(pipeline(override as Partial<BuildPipeline>))).toBe(false);
  });

  test("rejects malformed sessions and out-of-range current indexes", () => {
    const session = {
      phase: "build" as const,
      iteration: 0,
      sessionKey: "env-1:build",
      sdkSessionId: "session-1",
      status: "idle" as const,
      startedAt: NOW,
      label: "Build",
    };
    expect(
      isBuildPipeline(
        pipeline({
          sessions: [{ ...session, sdkSessionId: "" }],
          currentSessionIndex: 0,
        }),
      ),
    ).toBe(false);
    expect(
      isBuildPipeline(
        pipeline({
          sessions: [session],
          currentSessionIndex: 1,
        }),
      ),
    ).toBe(false);
  });

  test("replacePipeline rejects an invalid trust-boundary snapshot", () => {
    expect(() =>
      appCommandStore(buildPipelineStore)
        .getState()
        .replacePipeline(pipeline({ controller: "renderer" as "backend" })),
    ).toThrow("Invalid backend build pipeline snapshot");
  });

  test("ignores an older revision for the same pipeline", () => {
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(pipeline({ backendRevision: 5, taskTitle: "new" }));
    const mapBefore = appCommandStore(buildPipelineStore).getState().pipelines;

    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(pipeline({ backendRevision: 4, taskTitle: "stale" }));

    expect(appCommandStore(buildPipelineStore).getState().pipelines).toBe(mapBefore);
    expect(
      appCommandStore(buildPipelineStore).getState().getPipelineById("pipeline-1")?.taskTitle,
    ).toBe("new");
  });

  test("accepts an equal revision as an authoritative refresh", () => {
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(pipeline({ backendRevision: 5, taskTitle: "before" }));
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(pipeline({ backendRevision: 5, taskTitle: "after" }));
    expect(
      appCommandStore(buildPipelineStore).getState().getPipelineById("pipeline-1")?.taskTitle,
    ).toBe("after");
  });

  test("rebuilds environment ids when a snapshot changes association", () => {
    appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline());
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        pipeline({
          environmentId: "env-2",
          backendRevision: 2,
        }),
      );
    expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds).toEqual(
      new Set(["env-2"]),
    );
    expect(appCommandStore(buildPipelineStore).getState().activeBuildEnvironmentIds).toEqual(
      new Set(["env-2"]),
    );

    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        pipeline({
          environmentId: "",
          backendRevision: 3,
        }),
      );
    expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds.size).toBe(0);
    expect(appCommandStore(buildPipelineStore).getState().activeBuildEnvironmentIds.size).toBe(0);
  });

  test.each(["complete", "failed", "paused"] as const)(
    "drops activeBuildEnvironmentIds when the pipeline becomes %s",
    (phase) => {
      appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline());
      expect(appCommandStore(buildPipelineStore).getState().activeBuildEnvironmentIds).toEqual(
        new Set(["env-1"]),
      );

      appCommandStore(buildPipelineStore)
        .getState()
        .replacePipeline(
          pipeline({
            phase,
            backendRevision: 2,
          }),
        );

      expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds).toEqual(
        new Set(["env-1"]),
      );
      expect(appCommandStore(buildPipelineStore).getState().activeBuildEnvironmentIds.size).toBe(0);
    },
  );

  test.each(["waiting-for-setup", "creating-environment", "starting-environment"] as const)(
    "does not treat setup phase %s as a working environment",
    (phase) => {
      appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline({ phase }));
      expect(isWorkingBuildPipeline(pipeline({ phase }))).toBe(false);
      expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds).toEqual(
        new Set(["env-1"]),
      );
      expect(appCommandStore(buildPipelineStore).getState().activeBuildEnvironmentIds.size).toBe(0);
    },
  );

  test("drops activeBuildEnvironmentIds when the pipeline carries a stallWarning", () => {
    appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline());
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        pipeline({
          backendRevision: 2,
          stallWarning: { sessionId: "session-1", detectedAt: NOW },
        }),
      );
    expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds).toEqual(
      new Set(["env-1"]),
    );
    expect(appCommandStore(buildPipelineStore).getState().activeBuildEnvironmentIds.size).toBe(0);
  });

  test("removes one pipeline and no-ops for an unknown id", () => {
    appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline());
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        pipeline({
          id: "pipeline-2",
          taskId: "task-2",
          environmentId: "env-2",
        }),
      );
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-1", "session-1");
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-2", "session-2");

    appCommandStore(buildPipelineStore).getState().removePipeline("pipeline-1");
    expect([...appCommandStore(buildPipelineStore).getState().pipelines.keys()]).toEqual([
      "pipeline-2",
    ]);
    expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds).toEqual(
      new Set(["env-2"]),
    );
    expect(appCommandStore(buildPipelineStore).getState().viewedSessionIds).toEqual(
      new Map([["pipeline-2", "session-2"]]),
    );

    const stateBefore = appCommandStore(buildPipelineStore).getState();
    appCommandStore(buildPipelineStore).getState().removePipeline("missing");
    expect(appCommandStore(buildPipelineStore).getState()).toBe(stateBefore);
  });

  test("removes all task projections while retaining unrelated pipelines", () => {
    appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline());
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        pipeline({
          id: "pipeline-2",
          environmentId: "env-2",
          backendRevision: 2,
        }),
      );
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        pipeline({
          id: "pipeline-3",
          taskId: "task-3",
          environmentId: "env-3",
        }),
      );
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-1", "session-1");
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-2", "session-2");
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-3", "session-3");

    appCommandStore(buildPipelineStore).getState().removePipelinesForTask("task-1");
    expect([...appCommandStore(buildPipelineStore).getState().pipelines.keys()]).toEqual([
      "pipeline-3",
    ]);
    expect(appCommandStore(buildPipelineStore).getState().buildEnvironmentIds).toEqual(
      new Set(["env-3"]),
    );
    expect(appCommandStore(buildPipelineStore).getState().viewedSessionIds).toEqual(
      new Map([["pipeline-3", "session-3"]]),
    );
  });

  test("removes all projections for a deleted environment", () => {
    appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline());
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        pipeline({
          id: "pipeline-2",
          taskId: "task-2",
          environmentId: "env-1",
        }),
      );
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(
        pipeline({
          id: "pipeline-3",
          taskId: "task-3",
          environmentId: "env-3",
        }),
      );
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-1", "session-1");
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-2", "session-2");
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-3", "session-3");

    appCommandStore(buildPipelineStore).getState().removePipelinesForEnvironment("env-1");
    expect([...appCommandStore(buildPipelineStore).getState().pipelines.keys()]).toEqual([
      "pipeline-3",
    ]);
    expect(appCommandStore(buildPipelineStore).getState().viewedSessionIds).toEqual(
      new Map([["pipeline-3", "session-3"]]),
    );
  });

  test("sets, preserves, and clears the viewed session for one pipeline", () => {
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-1", "session-1");
    expect(appCommandStore(buildPipelineStore).getState().viewedSessionIds).toEqual(
      new Map([["pipeline-1", "session-1"]]),
    );

    const stateBefore = appCommandStore(buildPipelineStore).getState();
    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-1", "session-1");
    expect(appCommandStore(buildPipelineStore).getState()).toBe(stateBefore);

    appCommandStore(buildPipelineStore).getState().setViewedSessionId("pipeline-1", null);
    expect(appCommandStore(buildPipelineStore).getState().viewedSessionIds.size).toBe(0);
  });

  test("queries by task, id, and active environment", () => {
    const active = pipeline();
    const complete = pipeline({
      id: "pipeline-2",
      taskId: "task-2",
      environmentId: "env-2",
      phase: "complete",
    });
    appCommandStore(buildPipelineStore).getState().replacePipeline(active);
    appCommandStore(buildPipelineStore).getState().replacePipeline(complete);

    const state = appCommandStore(buildPipelineStore).getState();
    expect(state.getPipelineByTaskId("task-1")).toBe(active);
    expect(state.getPipelineByTaskId("missing")).toBeUndefined();
    expect(state.getPipelineById("pipeline-2")).toBe(complete);
    expect(state.getActivePipelineForEnvironment("env-1")).toBe(active);
    expect(state.getActivePipelineForEnvironment("env-2")).toBeUndefined();
    expect(state.isBuildEnvironment("env-2")).toBe(true);
    expect(state.isBuildEnvironment("missing")).toBe(false);
  });

  test("queries GitHub issues by repository identity and active state", () => {
    const oldComplete = pipeline({
      id: "pipeline-complete",
      phase: "complete",
      source: {
        type: "github",
        repositoryOwner: "acme",
        repositoryName: "widget",
        issueNumber: 42,
        issueUrl: "https://github.test/acme/widget/issues/42",
        status: "Done",
      },
    });
    const active = pipeline({
      id: "pipeline-active",
      backendRevision: 2,
      source: {
        type: "github",
        repositoryOwner: "acme",
        repositoryName: "widget",
        issueNumber: 43,
        issueUrl: "https://github.test/acme/widget/issues/43",
        status: "In progress",
      },
    });
    appCommandStore(buildPipelineStore).getState().replacePipeline(oldComplete);
    appCommandStore(buildPipelineStore).getState().replacePipeline(active);

    const state = appCommandStore(buildPipelineStore).getState();
    expect(state.getPipelineForGitHubIssue("acme", "widget", 42)).toBe(oldComplete);
    expect(state.getPipelineForGitHubIssue("acme", "widget", 42, true)).toBeUndefined();
    expect(state.getPipelineForGitHubIssue("acme", "widget", 43, true)).toBe(active);
    expect(state.getPipelineForGitHubIssue("other", "widget", 43)).toBeUndefined();
  });
});
