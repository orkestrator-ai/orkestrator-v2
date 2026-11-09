import { expect, test } from "bun:test";
import { isBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { CompletedBuildAttempt } from "./build-pipeline-completed-build.js";
import { pipeline, startInput, withService } from "./build-pipeline-service-test-support.js";

function completedBuild(): CompletedBuildAttempt {
  return {
    tabId: "original-tab",
    sessionId: "original-session",
    agent: "codex",
    model: "fixture-model",
    reasoningEffort: "high",
    startedAt: "2026-11-09T01:00:00.000Z",
    completedAt: "2026-11-09T01:10:00.000Z",
    commit: "1111111111111111111111111111111111111111",
    messages: [{ id: "answer", role: "assistant", content: "Finished the interactive work." }],
    notes: {
      summary: "Interactive work is ready for review.",
      workDone: ["Updated the fixture."],
      notDone: ["Review and verification remain."],
      tests: [{ name: "fixture checks", result: "passed" }],
    },
  };
}

test("adopts the completed original session before publishing the pipeline", async () => {
  await withService(async (service, storage, provider, invocations) => {
    const attempt = completedBuild();
    const started = await service.startFromCompletedBuild(startInput(), attempt);
    expect(isBuildPipeline(started)).toBe(true);
    expect(started.sessions).toHaveLength(1);
    expect(started.sessions[0]).toMatchObject({
      phase: "build",
      iteration: 0,
      sdkSessionId: attempt.sessionId,
      agent: "codex",
      model: "fixture-model",
      reasoningEffort: "high",
      status: "idle",
      headAtStart: attempt.commit,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    });
    expect(started.keyInformation).toMatchObject({
      summary: attempt.notes.summary,
      notDone: attempt.notes.notDone,
      tests: attempt.notes.tests,
      updates: [{ author: "build", round: 0 }],
    });
    const saved = await pipeline(storage, started.id);
    expect(saved.sessions[0]?.sdkSessionId).toBe(attempt.sessionId);
    expect(provider.sent).toEqual([]);
    expect(invocations.some((entry) => entry.command === "create_environment")).toBe(false);
    const layout = await storage.getPaneLayout("env-1");
    expect(JSON.stringify(layout)).toContain(started.id);
    attempt.messages.length = 0;
    const original = (await pipeline(storage, started.id)).sessions[0]!;
    const transcript = await storage.readBuildPipelineTranscript(started.id, original);
    expect(transcript.status).toBe("found");
    if (transcript.status === "found") expect(transcript.messages).toHaveLength(1);
  });
});

test("continues through the normal Review and PR path without a second Build or setup", async () => {
  await withService(async (service, storage, provider, invocations) => {
    const started = await service.startFromCompletedBuild(startInput(), completedBuild());
    for (let pass = 0; pass < 12; pass += 1) await service.advanceNow(started.id);
    const finished = await pipeline(storage, started.id);
    expect(finished.phase).toBe("complete");
    expect(finished.sessions.filter((session) => session.phase === "build")).toHaveLength(1);
    expect(finished.sessions[0]?.sdkSessionId).toBe("original-session");
    expect(finished.sessions.some((session) => session.phase === "review")).toBe(true);
    expect(finished.sessions.some((session) => session.phase === "verify")).toBe(true);
    expect((await storage.getEnvironment("env-1"))?.prUrl).toBe(
      "https://github.com/acme/repo/pull/1",
    );
    expect(finished.keyInformation?.summary).toBe(completedBuild().notes.summary);
    expect(provider.sent.every((turn) => turn.sessionId !== "original-session")).toBe(true);
    expect(provider.created.every((session) => session.phase !== "build")).toBe(true);
    expect(invocations.some((entry) => entry.command === "run_environment_setup")).toBe(false);
  });
});

test("restarting Build opens a normal attempt and retains the original transcript", async () => {
  await withService(async (service, storage, provider) => {
    const started = await service.startFromCompletedBuild(startInput(), completedBuild());
    for (let pass = 0; pass < 12; pass += 1) await service.advanceNow(started.id);
    const restarted = await service.restartStep(started.id, "original-session");
    expect(restarted.phase).toBe("building");
    expect(restarted.sessions[0]).toMatchObject({
      sdkSessionId: "original-session",
      iteration: 0,
      status: "idle",
    });
    expect(restarted.sessions[0]?.supersededBy).toBeDefined();
    expect(restarted.sessions.at(-1)).toMatchObject({ phase: "build", status: "running" });
    expect(provider.created.some((session) => session.phase === "build")).toBe(true);
    const original = (await pipeline(storage, started.id)).sessions[0]!;
    const transcript = await storage.readBuildPipelineTranscript(started.id, original);
    expect(transcript.status).toBe("found");
    if (transcript.status === "found") expect(transcript.messages).toHaveLength(1);
    expect(provider.sent.every((turn) => turn.sessionId !== "original-session")).toBe(true);
  });
});

for (const [name, patch] of [
  ["missing session", { sessionId: " " }],
  ["missing tab", { tabId: "" }],
  ["invalid commit", { commit: "HEAD" }],
  ["invalid completion", { completedAt: "invalid" }],
  ["completion before start", { completedAt: "2020-01-01T00:00:00.000Z" }],
  ["too many transcript rows", { messages: Array.from({ length: 10_001 }, () => ({})) }],
] as const) {
  test(`refuses ${name} before admission`, async () => {
    await withService(async (service, storage, provider) => {
      await expect(
        service.startFromCompletedBuild(startInput(), {
          ...completedBuild(),
          ...patch,
        }),
      ).rejects.toThrow("Invalid completed Build attempt");
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
      expect(provider.created).toEqual([]);
    });
  });
}

test("requires an existing running environment", async () => {
  await withService(async (service, storage) => {
    await expect(
      service.startFromCompletedBuild(
        startInput({ existingEnvironmentId: undefined }),
        completedBuild(),
      ),
    ).rejects.toThrow("running existing environment");
    await storage.updateEnvironment("env-1", { status: "stopped" });
    await expect(service.startFromCompletedBuild(startInput(), completedBuild())).rejects.toThrow(
      "running existing environment",
    );
    expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
  });
});

test("same-intent confirmation replays the admitted attempt", async () => {
  await withService(async (service, storage, provider) => {
    const first = await service.startFromCompletedBuild(startInput(), completedBuild());
    const replay = await service.startFromCompletedBuild(startInput(), completedBuild());
    expect(replay.id).toBe(first.id);
    expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
    expect(replay.sessions.filter((session) => session.phase === "build")).toHaveLength(1);
    expect(provider.sent.every((turn) => turn.sessionId !== "original-session")).toBe(true);
  });
});

test("refuses an environment already linked to another pipeline", async () => {
  await withService(async (service, storage) => {
    await service.start(startInput({ taskId: "other-task" }));
    await expect(service.startFromCompletedBuild(startInput(), completedBuild())).rejects.toThrow(
      "already linked",
    );
    expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
  });
});

test("same ticket cannot replay a normal Build as an adopted attempt", async () => {
  await withService(async (service, storage) => {
    await service.start(startInput());
    await expect(service.startFromCompletedBuild(startInput(), completedBuild())).rejects.toThrow(
      "different Build attempt",
    );
    expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
  });
});

test("racing promotions for different tickets admit only one pipeline", async () => {
  await withService(async (service, storage) => {
    const results = await Promise.allSettled([
      service.startFromCompletedBuild(startInput({ taskId: "left-task" }), completedBuild()),
      service.startFromCompletedBuild(startInput({ taskId: "right-task" }), completedBuild()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
  });
});

test("rejects a transcript over the byte budget without publishing a pipeline", async () => {
  await withService(async (service, storage) => {
    await expect(
      service.startFromCompletedBuild(startInput(), {
        ...completedBuild(),
        messages: [{ text: "x".repeat(8 * 1024 * 1024) }],
      }),
    ).rejects.toThrow("Invalid completed Build attempt");
    expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
  });
});
