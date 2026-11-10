import { expect, spyOn, test } from "bun:test";
import {
  isBuildPipeline,
  REVIEW_PACKAGE_SESSION_LABEL,
} from "@orkestrator/protocol/build-pipeline";
import { keyInformationTabId } from "@orkestrator/protocol/pane-layout";
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
    // The finished run lands on its notes in the authoritative layout, beside
    // and in place of the pipeline tab's selection.
    const layout = await storage.getPaneLayout("env-1");
    const leaf = layout?.root as { tabs: Array<Record<string, unknown>>; activeTabId: string };
    const notesId = keyInformationTabId("env-1", started.id, "notes");
    expect(leaf.activeTabId).toBe(notesId);
    expect(leaf.tabs.map((tab) => tab.type)).toEqual(["claude-build", "key-information"]);
    expect(leaf.tabs[1]).toMatchObject({
      id: notesId,
      keyInformationTabData: { environmentId: "env-1", pipelineId: started.id, view: "notes" },
    });
  });
});

for (const source of ["kanban", "github"] as const) {
  test(`Notes publication failure preserves completion and ${source} reconciliation`, async () => {
    await withService(async (service, storage, _provider, invocations, controls) => {
      const warning = spyOn(console, "warn").mockImplementation(() => {});
      const publication = spyOn(storage, "ensureBuildPipelineNotesTab").mockImplementation(
        async () => {
          // Make the terminal transition observable even if Ship already moved
          // the ticket to review, then fail before completion reconciliation.
          const task = controls.kanbanTasks.get("task-1");
          if (task) task.status = "in-progress";
          throw new Error("fixture layout publication failure");
        },
      );
      try {
        const started = await service.startFromCompletedBuild(
          startInput({
            source:
              source === "kanban"
                ? { type: "kanban", taskId: "task-1" }
                : {
                    type: "github",
                    repositoryOwner: "acme",
                    repositoryName: "repo",
                    issueNumber: 1,
                    issueUrl: "https://github.com/acme/repo/issues/1",
                    status: "open",
                  },
          }),
          completedBuild(),
        );
        for (let pass = 0; pass < 12; pass += 1) await service.advanceNow(started.id);
        const finished = await pipeline(storage, started.id);
        expect(publication).toHaveBeenCalledWith({
          pipelineId: started.id,
          environmentId: "env-1",
        });
        expect(finished.phase).toBe("complete");
        expect(finished.error).toBeUndefined();
        expect(finished.completionCommentStatus).toBe("posted");
        if (source === "kanban") {
          expect(controls.kanbanTasks.get("task-1")?.status).toBe("review");
          expect(
            invocations.some(
              ({ command, args }) =>
                command === "update_kanban_task" &&
                args.status === "review" &&
                args.preserveDoneStatus === true,
            ),
          ).toBe(true);
        } else {
          expect(finished.completionCommentId).toBe("comment-1");
          expect(
            invocations.some(
              ({ command, args }) =>
                command === "post_github_completion_comment" && args.pipelineId === started.id,
            ),
          ).toBe(true);
        }
        expect(
          warning.mock.calls.some(
            ([line]) =>
              String(line).includes("completion-notes.publish-failed") &&
              String(line).includes(started.id),
          ),
        ).toBe(true);
      } finally {
        publication.mockRestore();
        warning.mockRestore();
      }
    });
  });
}

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

for (const phase of ["complete", "failed"] as const) {
  test(`terminal ${phase} adoption replays its durable identity`, async () => {
    await withService(async (service, storage) => {
      const started = await service.startFromCompletedBuild(startInput(), completedBuild());
      const record = (await storage.getBuildPipeline(started.id))!;
      const snapshot = record.snapshot as typeof started;
      snapshot.phase = phase;
      await storage.saveBuildPipeline(
        started.id,
        started.projectId,
        started.environmentId,
        record.version,
        snapshot,
        record.revision,
      );
      await storage.updateEnvironment("env-1", { status: "stopped" });
      const replay = await service.startFromCompletedBuild(startInput(), completedBuild());
      expect(replay.id).toBe(started.id);
      expect(replay.phase).toBe(phase);
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
    });
  });
}

for (const patch of [
  { commit: "2222222222222222222222222222222222222222" },
  { notes: { summary: "Different notes" } },
  { messages: [{ content: "Different transcript" }] },
]) {
  test(`rejects divergent attempt ${Object.keys(patch)[0]}`, async () => {
    await withService(async (service, storage) => {
      await service.startFromCompletedBuild(startInput(), completedBuild());
      await expect(
        service.startFromCompletedBuild(startInput(), { ...completedBuild(), ...patch }),
      ).rejects.toThrow("different Build attempt");
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
    });
  });
}

test("normal admission cannot take an adopted environment", async () => {
  await withService(async (service, storage) => {
    await service.startFromCompletedBuild(startInput(), completedBuild());
    await expect(service.start(startInput({ taskId: "another" }))).rejects.toThrow(
      "already linked",
    );
    expect(await storage.listBuildPipelines("project-1")).toHaveLength(1);
  });
});

for (const command of ["update_kanban_task", "update_environment_agent_settings"]) {
  test(`bootstrap failure in ${command} retains adoption on retry`, async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      controls.failCommandsOnce.set(command, 1);
      const input = startInput({ source: { type: "kanban", taskId: "task-default" } });
      let id: string;
      if (command === "update_kanban_task") {
        await expect(service.startFromCompletedBuild(input, completedBuild())).rejects.toThrow();
        const replay = await service.startFromCompletedBuild(input, completedBuild());
        id = replay.id;
        expect(replay.phase).toBe("failed");
        await service.retryStage(id);
      } else {
        const started = await service.startFromCompletedBuild(startInput(), completedBuild());
        id = started.id;
        await service.advanceNow(id);
        expect((await pipeline(storage, id)).phase).toBe("failed");
        await service.retryStage(id);
      }
      for (let pass = 0; pass < 12; pass += 1) await service.advanceNow(id);
      const finished = await pipeline(storage, id);
      expect(finished.phase).toBe("complete");
      expect(finished.sessions[0]?.status).toBe("idle");
      expect(provider.created.every((session) => session.phase !== "build")).toBe(true);
      expect(invocations.some((entry) => entry.command === "run_environment_setup")).toBe(false);
    });
  });
}

for (const name of ["circular", "bigint", "uncloneable", "notes"] as const) {
  test(`normalizes malformed ${name} without admission`, async () => {
    await withService(async (service, storage) => {
      const attempt = completedBuild();
      if (name === "circular") attempt.messages.push(attempt.messages);
      if (name === "bigint") attempt.messages.push(1n);
      if (name === "uncloneable") attempt.messages.push(() => {});
      if (name === "notes")
        attempt.notes = { tests: [null] } as unknown as CompletedBuildAttempt["notes"];
      await expect(service.startFromCompletedBuild(startInput(), attempt)).rejects.toThrow(
        "Invalid completed Build attempt",
      );
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
    });
  });
}

test("a completed non-adopted session does not bypass setup", async () => {
  await withService(async (service, storage, _provider, invocations) => {
    const started = await service.startFromCompletedBuild(startInput(), completedBuild());
    const record = (await storage.getBuildPipeline(started.id))!;
    const snapshot = record.snapshot as typeof started;
    snapshot.phase = "waiting-for-setup";
    delete snapshot.sessions[0]!.adoptedFromTabId;
    delete snapshot.sessions[0]!.adoptedAttemptDigest;
    await storage.saveBuildPipeline(
      started.id,
      started.projectId,
      started.environmentId,
      record.version,
      snapshot,
      record.revision,
    );
    await service.advanceNow(started.id);
    expect(invocations.some((entry) => entry.command === "run_environment_setup")).toBe(true);
  });
});

test("code rewind uses the adopted commit and restarts with a new Build", async () => {
  const target = completedBuild().commit;
  const tip = "2222222222222222222222222222222222222222";
  const refs = new Map<string, string>();
  let head = tip;
  const calls: string[][] = [];
  await withService(
    async (service, _storage, provider, _invocations, controls) => {
      const started = await service.startFromCompletedBuild(startInput(), completedBuild());
      for (let pass = 0; pass < 12; pass += 1) await service.advanceNow(started.id);
      controls.currentHead = tip;
      const preview = await service.previewCodeRewind(started.id, "original-session");
      expect(preview.targetCommit).toBe(target);
      expect(preview.blocked).toBeUndefined();
      const rewound = await service.rewindCode(started.id, "original-session", tip);
      expect(calls).toContainEqual(["reset", "--hard", target]);
      expect(rewound.rewinds?.at(-1)?.code).toMatchObject({ from: tip, to: target });
      expect(provider.created.at(-1)?.phase).toBe("build");
      expect(provider.sent.every((turn) => turn.sessionId !== "original-session")).toBe(true);
      expect(refs.size).toBe(1);
    },
    {
      environmentGit: async (_environmentId, args) => {
        calls.push([...args]);
        if (args[0] === "status") return "";
        if (args[0] === "log") return `${tip}\u001fLater work`;
        if (args[0] === "rev-list") return args[2]?.startsWith("HEAD..") ? "0" : "1";
        if (args[0] === "rev-parse") {
          if (args[1] === "HEAD") return head;
          const ref = refs.get(args[1]!);
          if (ref) return ref;
          throw new Error("Unknown ref");
        }
        if (args[0] === "update-ref") {
          refs.set(args[1]!, args[2]!);
          return "";
        }
        if (args[0] === "reset") {
          head = args[2]!;
          return "";
        }
        throw new Error(`Unexpected Git operation: ${args[0]}`);
      },
    },
  );
});

test("review preparation startup failure retries without setup or another Build", async () => {
  let fail = true;
  await withService(
    async (service, storage, provider, invocations) => {
      const started = await service.startFromCompletedBuild(startInput(), completedBuild());
      for (let pass = 0; pass < 4; pass += 1) {
        await service.advanceNow(started.id);
        if ((await pipeline(storage, started.id)).phase === "failed") break;
      }
      const failed = await pipeline(storage, started.id);
      expect(failed.phase).toBe("failed");
      expect(failed.sessions[0]?.status).toBe("idle");
      const retried = await service.retryStage(started.id);
      expect(retried.phase).toBe("fixing");
      expect(retried.sessions.at(-1)?.label).toBe(REVIEW_PACKAGE_SESSION_LABEL);
      expect(retried.sessions.at(-1)?.status).toBe("running");
      expect((await pipeline(storage, started.id)).sessions[0]?.status).toBe("idle");
      expect(provider.created.every((session) => session.phase !== "build")).toBe(true);
      expect(invocations.some((entry) => entry.command === "run_environment_setup")).toBe(false);
    },
    {
      toolMode: true,
      environmentType: "containerized",
      assertAgentToolsReachable: async () => {
        if (fail) {
          fail = false;
          throw new Error("Preparation tools unavailable");
        }
      },
    },
  );
});
