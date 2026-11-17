import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { stopAfterBuild } from "./build-pipeline-build-stop.js";
import {
  applyBuildOutcomeReport,
  createBuildPipelineKeyInformationHost,
  keyInformationView,
  type BuildPipelineKeyInformationHost,
  type KeyInformationView,
} from "./build-pipeline-key-information.js";
import {
  registerKeyInformationTools,
  splitKeyInformationUpdate,
} from "./build-pipeline-key-information-tools.js";
import { keyInformationInstruction } from "./build-pipeline-prompts.js";
import { resumePromptFor } from "./build-pipeline-service-helpers.js";
import { callToolInProcess } from "./mcp-in-process.js";
import type { PersistedBuildPipeline } from "./models.js";
import {
  pipeline as stored,
  startBuilding,
  withService,
} from "./build-pipeline-service-test-support.js";

const AT = "2026-11-17T10:00:00.000Z";
const SCOPE = { environmentId: "env-1", projectId: "project-1" };

function buildSession(overrides: Partial<PipelineSession> = {}): PipelineSession {
  return {
    phase: "build",
    iteration: 0,
    sessionKey: "pipeline-1:build:0:a",
    sdkSessionId: "sdk-build",
    status: "idle",
    startedAt: AT,
    label: "Build Session",
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
    phase: "building",
    sessions: [buildSession()],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: AT,
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
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

function host() {
  const calls: string[] = [];
  return {
    calls,
    stopHost: {
      complete: async (target: BuildPipeline) => {
        calls.push("complete");
        target.phase = "complete";
      },
      save: async () => {
        calls.push("save");
      },
    },
  };
}

describe("stopAfterBuild", () => {
  test("completes the pipeline when Build found no work, once", async () => {
    const target = pipeline();
    const session = target.sessions[0]!;
    session.buildOutcome = {
      continueReview: false,
      stopKind: "no-work-needed",
      stopReason: "Already implemented.",
      reportedAt: AT,
    };
    const { calls, stopHost } = host();
    expect(await stopAfterBuild(target, session, stopHost, AT)).toBe(true);
    expect(calls).toEqual(["complete"]);
    expect(session.buildOutcome.appliedAt).toBe(AT);
    target.phase = "building";
    expect(await stopAfterBuild(target, session, stopHost, AT)).toBe(false);
  });

  test("pauses from Build with the reason when Build is blocked", async () => {
    const target = pipeline({ stallWarning: { sessionId: "sdk-build", detectedAt: AT } });
    const session = target.sessions[0]!;
    session.buildOutcome = {
      continueReview: false,
      stopKind: "blocked",
      stopReason: "The API key for the payment sandbox is missing.",
      reportedAt: AT,
    };
    const { calls, stopHost } = host();
    expect(await stopAfterBuild(target, session, stopHost, AT)).toBe(true);
    expect(calls).toEqual(["save"]);
    expect(target).toMatchObject({
      phase: "paused",
      pausedFromPhase: "building",
      pauseCause: "supervisor",
    });
    expect(target.error).toContain("The API key for the payment sandbox is missing.");
    expect(target.stallWarning).toBeUndefined();
  });

  test("leaves every other turn to the usual path", async () => {
    const { calls, stopHost } = host();
    const unreported = pipeline();
    expect(await stopAfterBuild(unreported, unreported.sessions[0]!, stopHost)).toBe(false);
    const continuing = pipeline({
      sessions: [buildSession({ buildOutcome: { continueReview: true, reportedAt: AT } })],
    });
    expect(await stopAfterBuild(continuing, continuing.sessions[0]!, stopHost)).toBe(false);
    const rework = pipeline({ phase: "reworking" });
    const reworkSession = buildSession({ phase: "rework" });
    expect(await stopAfterBuild(rework, reworkSession, stopHost)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("reporting the Build outcome", () => {
  test("is recorded on the running Build session and shown back in the view", () => {
    const target = pipeline();
    applyBuildOutcomeReport(
      target,
      { continueReview: false, stopKind: "blocked", stopReason: "Needs a decision." },
      AT,
    );
    expect(target.sessions[0]!.buildOutcome).toEqual({
      continueReview: false,
      stopKind: "blocked",
      stopReason: "Needs a decision.",
      reportedAt: AT,
    });
    expect(keyInformationView(target).buildOutcome).toEqual({
      continueReview: false,
      stopKind: "blocked",
      stopReason: "Needs a decision.",
    });
    // A later report replaces it, and clears an earlier applied stop.
    target.sessions[0]!.buildOutcome!.appliedAt = AT;
    applyBuildOutcomeReport(target, { continueReview: true }, AT);
    expect(target.sessions[0]!.buildOutcome).toEqual({ continueReview: true, reportedAt: AT });
  });

  test("is refused outside a running Build turn and without a reason", () => {
    for (const target of [
      pipeline({ phase: "reviewing" }),
      pipeline({ phase: "paused", pausedFromPhase: "building" }),
      pipeline({ sessions: [buildSession({ supersededBy: "rewind-1" })] }),
      pipeline({ sessions: [buildSession({ phase: "rework" })] }),
    ]) {
      expect(() => applyBuildOutcomeReport(target, { continueReview: true }, AT)).toThrow(
        "Only the Build stage",
      );
      expect(keyInformationView(target).buildOutcome).toBeUndefined();
    }
    expect(() => applyBuildOutcomeReport(pipeline(), { continueReview: false }, AT)).toThrow(
      "`stopReason` is required",
    );
  });

  test("the host writes nothing, brief included, when the outcome is refused", async () => {
    const store = new Map([["pipeline-1", pipeline({ phase: "reviewing" })]]);
    const keyHost = createBuildPipelineKeyInformationHost({
      listPipelines: async () =>
        [...store.values()].map(
          (snapshot) =>
            ({
              version: 1,
              id: snapshot.id,
              projectId: snapshot.projectId,
              environmentId: snapshot.environmentId,
              snapshot,
              updatedAt: AT,
              revision: 1,
            }) as unknown as PersistedBuildPipeline,
        ),
      mutate: async (id, mutation) => {
        const candidate = structuredClone(store.get(id)!);
        await mutation(candidate);
        store.set(id, candidate);
        return candidate;
      },
    });
    await expect(
      keyHost.update(SCOPE, { summary: "Nothing to do." }, { continueReview: true }),
    ).rejects.toThrow("Only the Build stage");
    expect(store.get("pipeline-1")!.keyInformation).toBeUndefined();

    store.set("pipeline-1", pipeline());
    const view = await keyHost.update(
      SCOPE,
      {},
      { continueReview: false, stopReason: "The behaviour already exists." },
    );
    expect(view.buildOutcome).toMatchObject({ continueReview: false, stopKind: "no-work-needed" });
    expect(store.get("pipeline-1")!.keyInformation).toBeUndefined();
  });
});

describe("the update_key_information tool", () => {
  const view: KeyInformationView = {
    pipelineId: "pipeline-1",
    taskTitle: "Task",
    phase: "building",
    round: 1,
    maxRounds: 3,
    author: "build",
    keyInformation: null,
  };

  function recordingHost(): BuildPipelineKeyInformationHost & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      read: async () => view,
      update: async (_scope, patch, outcome) => {
        calls.push([patch, outcome]);
        return view;
      },
    };
  }

  test("passes the outcome apart from the brief, alone or with sections", async () => {
    const keyHost = recordingHost();
    const factory = async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      await registerKeyInformationTools(server, keyHost, SCOPE);
      return server;
    };
    const alone = await callToolInProcess(factory, "update_key_information", {
      continueReview: false,
      stopKind: "no-work-needed",
      stopReason: "Already done.",
    });
    expect(alone.isError).toBe(false);
    const withBrief = await callToolInProcess(factory, "update_key_information", {
      summary: "Done.",
      continueReview: true,
    });
    expect(withBrief.isError).toBe(false);
    expect(keyHost.calls).toEqual([
      [{}, { continueReview: false, stopKind: "no-work-needed", stopReason: "Already done." }],
      [{ summary: "Done." }, { continueReview: true }],
    ]);

    const orphanReason = await callToolInProcess(factory, "update_key_information", {
      stopReason: "Why?",
    });
    expect(orphanReason.isError).toBe(true);
    const badKind = await callToolInProcess(factory, "update_key_information", {
      continueReview: false,
      stopKind: "later",
      stopReason: "x",
    });
    expect(badKind.isError).toBe(true);
    expect(keyHost.calls).toHaveLength(2);
  });

  test("splitKeyInformationUpdate leaves a brief-only update alone", () => {
    expect(splitKeyInformationUpdate({ summary: "A" })).toEqual({ patch: { summary: "A" } });
    expect(() => splitKeyInformationUpdate({ stopKind: "blocked" })).toThrow();
  });
});

describe("the Build prompts", () => {
  test("ask Build, and a resumed Build, whether review should continue", () => {
    const build = keyInformationInstruction("build");
    expect(build).toContain("`continueReview`");
    expect(build).toContain("no-work-needed");
    expect(build).toContain("blocked");
    expect(keyInformationInstruction("rework")).not.toContain("continueReview");
    expect(resumePromptFor("building")).toContain("continueReview: false");
  });
});

describe("the pipeline after a Build turn that stops it", () => {
  test("no work needed: completes without opening review, and tells the ticket why", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const { started } = await startBuilding(service, storage, {
        taskId: "task-1",
        source: { type: "kanban", taskId: "task-1" },
      });
      await service.keyInformationHost().update(
        SCOPE,
        { summary: "The ticket's behaviour already exists." },
        {
          continueReview: false,
          stopKind: "no-work-needed",
          stopReason: "The export button already exists.",
        },
      );
      await service.advanceNow(started.id);

      const done = await stored(storage, started.id);
      expect(done.phase).toBe("complete");
      expect(done.sessions.map((session) => session.phase)).toEqual(["build"]);
      expect(provider.created.map((session) => session.phase)).toEqual(["build"]);
      expect(done.sessions[0]!.buildOutcome?.appliedAt).toBeDefined();
      const ticket = controls.kanbanTasks.get("task-1");
      expect(ticket?.status).toBe("review");
      expect(
        ticket?.comments.some((entry) => entry.text.includes("The export button already exists.")),
      ).toBe(true);
    });
  });

  test("blocked: pauses, and Resume gives Build another turn before review", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      await service.keyInformationHost().update(
        SCOPE,
        {},
        {
          continueReview: false,
          stopKind: "blocked",
          stopReason: "The ticket asks for two contradictory defaults.",
        },
      );
      await service.advanceNow(started.id);

      const paused = await stored(storage, started.id);
      expect(paused).toMatchObject({
        phase: "paused",
        pausedFromPhase: "building",
        pauseCause: "supervisor",
      });
      expect(paused.error).toContain("two contradictory defaults");
      expect(provider.created.map((entry) => entry.phase)).toEqual(["build"]);

      const sentBefore = provider.sent.length;
      await service.resume(started.id);
      // Resume journals the turn; the next pass sends it to the same session.
      await service.advanceNow(started.id);
      expect(provider.sent.slice(sentBefore).map((entry) => entry.sessionId)).toEqual([
        session.sdkSessionId,
      ]);
      // The resumed turn reported nothing new, so the applied stop is spent and
      // the pipeline goes on toward review.
      for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);
      const next = await stored(storage, started.id);
      expect(next.phase).not.toBe("paused");
      expect(next.phase).not.toBe("complete");
      expect(provider.created.length).toBeGreaterThan(1);
    });
  });

  test("a Build that continues, or says nothing, goes on to review as before", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      await service.keyInformationHost().update(SCOPE, {}, { continueReview: true });
      await service.advanceNow(started.id);
      const next = await stored(storage, started.id);
      expect(["building", "reworking", "reviewing"]).toContain(next.phase);
      expect(next.error).toBeUndefined();
    });
  });
});
