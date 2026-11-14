/**
 * What a build does once Verify passes, by the ticket's delivery policy: read
 * from the ticket at that moment, held from then on, and still known if the
 * ticket is deleted during the run.
 */
import { describe, expect, test } from "bun:test";
import {
  BRANCH_PUSH_SESSION_LABEL,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import type { DeliveryPolicy } from "@orkestrator/protocol/ticket-sections";
import { createFeatureBuild, FeatureBuildTasks } from "./features/index.js";
import { launchBuildPipeline } from "./build-pipeline-launch.js";
import { pushBranchPrompt } from "./build-pipeline-prompts.js";
import { readEnvironmentBranchPushState } from "./build-pipeline-branch-push.js";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import { pipeline, startInput, withService } from "./build-pipeline-service-test-support.js";
import type { StorageService } from "./storage.js";

const TICKET = "task-default";
const KANBAN_SOURCE = { type: "kanban", taskId: TICKET } as const;
const HEAD = "a".repeat(40);

async function advanceUntil(
  service: BuildPipelineService,
  storage: StorageService,
  id: string,
  done: (snapshot: BuildPipeline) => boolean,
): Promise<BuildPipeline> {
  for (let pass = 0; pass < 30; pass += 1) {
    const snapshot = await pipeline(storage, id);
    if (done(snapshot)) return snapshot;
    await service.advanceNow(id);
  }
  throw new Error(`Pipeline stuck in ${(await pipeline(storage, id)).phase}`);
}

const verifying = (snapshot: BuildPipeline) =>
  snapshot.phase === "verifying" && snapshot.sessions.at(-1)?.phase === "verify";
const finished = (snapshot: BuildPipeline) =>
  snapshot.phase === "complete" || snapshot.phase === "failed";

type Controls = Parameters<Parameters<typeof withService>[0]>[4];

function setTicketPolicy(controls: Controls, policy: DeliveryPolicy | undefined): void {
  controls.kanbanTasks.set(TICKET, {
    ...(controls.kanbanTasks.get(TICKET) ?? { id: TICKET, status: "backlog", comments: [] }),
    sections: policy ? { delivery: { policy } } : {},
  });
}

function commentTexts(controls: Controls): string[] {
  return (controls.kanbanTasks.get(TICKET)?.comments ?? []).map((comment) => comment.text);
}

describe("delivery after a passed Verify", () => {
  test.each([["open-pr" as const], [undefined]])(
    "policy %s opens the pull request as it always has",
    async (policy) => {
      await withService(async (service, storage, provider, invocations, controls) => {
        setTicketPolicy(controls, policy);
        const started = await service.start(startInput({ source: KANBAN_SOURCE }));

        const completed = await advanceUntil(service, storage, started.id, finished);

        expect(completed.phase).toBe("complete");
        expect(completed.delivery?.policy).toBe("open-pr");
        const ship = completed.sessions.find((session) => session.phase === "pr")!;
        expect(ship.label).toBe("PR Creation Session");
        const prompt = provider.sent.find((sent) => sent.sessionId === ship.sdkSessionId)?.prompt;
        expect(prompt).toContain("gh pr create");
        expect(invocations.some(({ command }) => command === "detect_pr_local")).toBe(true);
        const task = controls.kanbanTasks.get(TICKET)!;
        expect(task.prUrl).toBe("https://github.com/acme/repo/pull/1");
        expect(commentTexts(controls).some((text) => text.startsWith("🔗 PR raised"))).toBe(true);
      });
    },
  );

  test("push-no-pr pushes, opens no pull request and finishes as a success", async () => {
    await withService(
      async (service, storage, provider, invocations, controls) => {
        setTicketPolicy(controls, "push-no-pr");
        const started = await service.start(startInput({ source: KANBAN_SOURCE }));

        const completed = await advanceUntil(service, storage, started.id, finished);

        expect(completed.phase).toBe("complete");
        expect(completed.error).toBeUndefined();
        expect(completed.delivery?.policy).toBe("push-no-pr");
        const pushes = completed.sessions.filter((session) => session.phase === "pr");
        expect(pushes.map((session) => session.label)).toEqual([BRANCH_PUSH_SESSION_LABEL]);
        const prompt = provider.sent.find(
          (sent) => sent.sessionId === pushes[0]!.sdkSessionId,
        )?.prompt;
        expect(prompt).toContain("Push the current branch to origin");
        expect(prompt).not.toContain("gh pr create");

        const commands = invocations.map(({ command }) => command);
        expect(commands).not.toContain("detect_pr_local");
        expect(commands).not.toContain("pr_monitor_watch");
        expect(completed.sessions.some((entry) => entry.phase === "resolve-conflicts")).toBe(false);

        const task = controls.kanbanTasks.get(TICKET)!;
        expect(task.status).toBe("review");
        expect(task.prUrl).toBeUndefined();
        expect(commentTexts(controls)).toContain(
          "✅ The branch was pushed and no pull request was opened.",
        );
        expect((await storage.getEnvironment("env-1"))?.prUrl).toBeNull();
      },
      { branchPushState: async () => ({ branch: "build", head: HEAD, remoteHead: HEAD }) },
    );
  });

  test("a push session that did not push fails, and a retry can finish it", async () => {
    let remoteHead: string | null = null;
    await withService(
      async (service, storage, _provider, _invocations, controls) => {
        setTicketPolicy(controls, "push-no-pr");
        const started = await service.start(startInput({ source: KANBAN_SOURCE }));

        const failed = await advanceUntil(service, storage, started.id, finished);

        expect(failed.phase).toBe("failed");
        expect(failed.error).toContain("does not have commit");
        expect(failed.failureContext?.phase).toBe("creating-pr");

        remoteHead = HEAD;
        await service.retryStage(started.id);
        const completed = await advanceUntil(service, storage, started.id, finished);

        expect(completed.phase).toBe("complete");
        expect(completed.sessions.filter((session) => session.phase === "pr").at(-1)?.label).toBe(
          BRANCH_PUSH_SESSION_LABEL,
        );
      },
      { branchPushState: async () => ({ branch: "build", head: HEAD, remoteHead }) },
    );
  });

  test("commit-only pushes nothing and says the commits stayed in the environment", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      setTicketPolicy(controls, "commit-only");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));

      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(completed.sessions.some((session) => session.phase === "pr")).toBe(false);
      expect(provider.created.some((created) => created.phase === "pr")).toBe(false);
      expect(invocations.map(({ command }) => command)).not.toContain("pr_monitor_watch");
      const task = controls.kanbanTasks.get(TICKET)!;
      expect(task.status).toBe("review");
      expect(commentTexts(controls).join("\n")).toContain("commits were kept in the environment");
      expect(commentTexts(controls).join("\n")).toContain("nothing was pushed");
    });
  });

  test("commit-only reports uncommitted paths it could not commit", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "commit-only");
      // Present before Verify's baseline: Verify refuses a path that appears during it.
      controls.uncommittedPaths.push("notes.txt");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));

      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(completed.delivery?.uncommittedPaths).toBe(1);
      expect(commentTexts(controls).join("\n")).toContain("1 uncommitted path also remains");
    });
  });
});

describe("the ticket decides at the moment Verify passes", () => {
  test("a change before Verify passes changes what happens", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "open-pr");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      expect((await pipeline(storage, started.id)).deliveryPolicy).toBe("open-pr");
      await advanceUntil(service, storage, started.id, verifying);

      setTicketPolicy(controls, "commit-only");
      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(completed.delivery?.policy).toBe("commit-only");
      expect(completed.sessions.some((session) => session.phase === "pr")).toBe(false);
    });
  });

  test("the latest passing Verify is the one that counts after fix rounds", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      setTicketPolicy(controls, "open-pr");
      let verdicts = 0;
      const structured = provider.structured.bind(provider);
      provider.structured = async <T>(sessionId: string, requestId: string) => {
        if (provider.phases.get(sessionId) !== "verify") {
          return structured<T>(sessionId, requestId);
        }
        verdicts += 1;
        // The first verdict fails; the ticket changes while the fix round runs.
        if (verdicts === 1) setTicketPolicy(controls, "push-no-pr");
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: (verdicts === 1
            ? { complete: false, rationale: "Not yet." }
            : { complete: true, rationale: "Done." }) as T,
        };
      };
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));

      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(verdicts).toBeGreaterThan(1);
      expect(completed.delivery?.policy).toBe("push-no-pr");
      expect(completed.sessions.filter((session) => session.phase === "pr")[0]?.label).toBe(
        BRANCH_PUSH_SESSION_LABEL,
      );
    });
  });

  test("a change after the PR stage started keeps the run and says it came too late", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      setTicketPolicy(controls, "open-pr");
      provider.runningPhases.add("pr");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      await advanceUntil(service, storage, started.id, (snapshot) =>
        snapshot.sessions.some((session) => session.phase === "pr"),
      );

      setTicketPolicy(controls, "push-no-pr");
      await service.noteTicketDeliveryChange(TICKET, "project-1", "push-no-pr");
      // The same change again adds no second comment.
      await service.noteTicketDeliveryChange(TICKET, "project-1", "push-no-pr");

      const tooLate = commentTexts(controls).filter((text) => text.includes("Too late"));
      expect(tooLate).toHaveLength(1);
      expect(tooLate[0]).toContain("Open a PR, don't merge");
      expect(tooLate[0]).toContain("Push, no PR");

      provider.runningPhases.delete("pr");
      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(completed.delivery?.policy).toBe("open-pr");
      expect(controls.kanbanTasks.get(TICKET)?.prUrl).toBe("https://github.com/acme/repo/pull/1");
    });
  });

  test("a change back to the decided policy is not too late", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      setTicketPolicy(controls, "open-pr");
      provider.runningPhases.add("pr");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      await advanceUntil(service, storage, started.id, (snapshot) =>
        snapshot.sessions.some((session) => session.phase === "pr"),
      );

      await service.noteTicketDeliveryChange(TICKET, "project-1", undefined);

      expect(commentTexts(controls).some((text) => text.includes("Too late"))).toBe(false);
    });
  });

  test("a deleted ticket's run follows the policy captured at launch", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "commit-only");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      await advanceUntil(service, storage, started.id, verifying);

      controls.kanbanTasks.delete(TICKET);
      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(completed.delivery?.policy).toBe("commit-only");
      expect(completed.completionCommentStatus).toBe("posted");
    });
  });

  test("a deleted ticket's run follows the last change it saw, not the launch value", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "open-pr");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      await advanceUntil(service, storage, started.id, verifying);

      await service.noteTicketDeliveryChange(TICKET, "project-1", "commit-only");
      controls.kanbanTasks.delete(TICKET);
      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(completed.delivery?.policy).toBe("commit-only");
    });
  });

  test("a failed read of the ticket fails the stage rather than guess", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "commit-only");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      await advanceUntil(service, storage, started.id, verifying);

      controls.failCommands.add("get_kanban_tasks");
      const failed = await advanceUntil(service, storage, started.id, finished);

      expect(failed.phase).toBe("failed");
      expect(failed.delivery).toBeUndefined();
    });
  });

  test("skipping Verify still follows the policy", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      setTicketPolicy(controls, "commit-only");
      provider.runningPhases.add("verify");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      await advanceUntil(service, storage, started.id, verifying);
      const verify = (await pipeline(storage, started.id)).sessions.at(-1)!;

      await service.skipStep(started.id, verify.sdkSessionId);
      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(completed.sessions.some((session) => session.phase === "pr")).toBe(false);
    });
  });
});

describe("a build with no Kanban ticket", () => {
  test.each([
    ["push-no-pr" as const, "The branch was pushed and no pull request was opened."],
    ["commit-only" as const, "The commits were kept in the environment"],
  ])("a Linear build honours %s from the launch dialog", async (deliveryPolicy, sentence) => {
    await withService(async (service, storage, _provider, invocations) => {
      const started = await service.start(
        startInput({
          taskId: "linear-1",
          source: { type: "linear", issueId: "issue-1", issueIdentifier: "ENG-1" },
          deliveryPolicy,
        }),
      );

      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(completed.delivery?.policy).toBe(deliveryPolicy);
      const comment = invocations.find(
        ({ command }) => command === "post_linear_completion_comment",
      );
      expect(String(comment?.args.body)).toContain(sentence);
    });
  });

  test("a Linear build with no selection opens the pull request", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(
        startInput({
          taskId: "linear-1",
          source: { type: "linear", issueId: "issue-1", issueIdentifier: "ENG-1" },
        }),
      );

      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.delivery?.policy).toBe("open-pr");
      expect(completed.sessions.some((session) => session.phase === "pr")).toBe(true);
    });
  });
});

describe("restarting a run that ended without a pull request", () => {
  test("restarting Verify reads the ticket again", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "commit-only");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      const completed = await advanceUntil(service, storage, started.id, finished);
      const verify = completed.sessions.find((session) => session.phase === "verify")!;

      setTicketPolicy(controls, "push-no-pr");
      const restarted = await service.restartStep(started.id, verify.sdkSessionId);
      expect(restarted.delivery).toBeUndefined();
      const recompleted = await advanceUntil(service, storage, started.id, finished);

      expect(recompleted.phase).toBe("complete");
      expect(recompleted.delivery?.policy).toBe("push-no-pr");
    });
  });

  test("restarting the push pushes again and the policy edit stays too late", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      setTicketPolicy(controls, "push-no-pr");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      const completed = await advanceUntil(service, storage, started.id, finished);
      const push = completed.sessions.find((session) => session.phase === "pr")!;

      setTicketPolicy(controls, "open-pr");
      await service.restartStep(started.id, push.sdkSessionId);
      const recompleted = await advanceUntil(service, storage, started.id, finished);

      expect(recompleted.delivery?.policy).toBe("push-no-pr");
      const pushes = recompleted.sessions.filter((session) => session.phase === "pr");
      expect(pushes.map((session) => session.label)).toEqual([
        BRANCH_PUSH_SESSION_LABEL,
        BRANCH_PUSH_SESSION_LABEL,
      ]);
      const prompt = provider.sent.find((sent) => sent.sessionId === pushes[1]!.sdkSessionId);
      expect(prompt?.prompt).not.toContain("gh pr create");
    });
  });

  test("an older merged pull request on a reused environment does not block a restart", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "push-no-pr");
      await storage.updateEnvironment("env-1", {
        prUrl: "https://github.com/acme/repo/pull/9",
        prState: "merged",
      });
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      const completed = await advanceUntil(service, storage, started.id, finished);
      const verify = completed.sessions.find((session) => session.phase === "verify")!;

      const restarted = await service.restartStep(started.id, verify.sdkSessionId);

      expect(restarted.phase).toBe("verifying");
    });
  });

  test("a push after a code rewind that dropped pushed commits uses a lease", () => {
    const prompt = pushBranchPrompt({ forcePushUpstream: "origin/build" });
    expect(prompt).toContain("git push --force-with-lease");
    expect(prompt).toContain("Never use plain `--force`");
    expect(prompt).not.toContain("gh pr create");
    expect(pushBranchPrompt()).not.toContain("force-with-lease");
  });

  test("the push prompt promises no automatic review", () => {
    expect(pushBranchPrompt()).toContain("do not start a review");
    expect(pushBranchPrompt()).not.toContain("Multi Review");
  });
});

describe("launching saves the choice", () => {
  async function kanbanFixture(
    run: (
      service: BuildPipelineService,
      storage: StorageService,
      taskId: string,
      launch: (
        taskId: string,
        deliveryPolicy: DeliveryPolicy | undefined,
      ) => Promise<BuildPipeline>,
    ) => Promise<void>,
    options: { description?: string } = {},
  ): Promise<void> {
    await withService(async (service, storage) => {
      const task = await storage.kanban.addKanbanTask(
        "project-1",
        "Ticket",
        options.description ?? "Do the thing",
      );
      await run(service, storage, task.id, async (taskId, deliveryPolicy) => {
        const current = (await storage.kanban.getKanbanTask(taskId))!;
        return launchBuildPipeline(
          startInput({
            taskId,
            source: { type: "kanban", taskId },
            taskTitle: current.title,
            taskSnapshot: {
              title: current.title,
              description: current.description,
              acceptanceCriteria: current.acceptanceCriteria,
              comments: [],
              images: [],
            },
            ...(deliveryPolicy ? { deliveryPolicy } : {}),
          }),
          { storage, buildPipelines: service } as never,
        );
      });
    });
  }

  test("a choice is written to the ticket and captured on the pipeline", async () => {
    await kanbanFixture(async (_service, storage, taskId, launch) => {
      const launched = await launch(taskId, "push-no-pr");

      const ticket = await storage.kanban.getKanbanTask(taskId);
      expect(ticket?.sections?.delivery?.policy).toBe("push-no-pr");
      expect(ticket?.description).toContain("Policy: push-no-pr");
      expect(launched.deliveryPolicy).toBe("push-no-pr");
      // The run's own ticket text is the saved text, so it does not read as edited.
      expect(launched.taskSnapshot.description).toBe(ticket!.description);
    });
  });

  test("the delivery note survives the write", async () => {
    await kanbanFixture(
      async (_service, storage, taskId, launch) => {
        await launch(taskId, "push-no-pr");
        expect((await storage.kanban.getKanbanTask(taskId))?.sections?.delivery).toEqual({
          policy: "push-no-pr",
          note: "Mail the coordinator.",
        });
      },
      { description: "Do it\n\n## Delivery\n\nMail the coordinator." },
    );
  });

  test("a ticket that already has commit-only is not rewritten by keeping it", async () => {
    await kanbanFixture(
      async (_service, storage, taskId, launch) => {
        const before = await storage.kanban.getKanbanTask(taskId);
        await launch(taskId, "commit-only");
        const after = await storage.kanban.getKanbanTask(taskId);
        expect(after?.sections?.delivery?.policy).toBe("commit-only");
        expect(after?.description).toBe(before?.description);
      },
      { description: "Do it\n\n## Delivery\n\nPolicy: commit-only" },
    );
  });

  test("a launch with no choice leaves the ticket alone", async () => {
    await kanbanFixture(
      async (_service, storage, taskId, launch) => {
        const before = await storage.kanban.getKanbanTask(taskId);
        const launched = await launch(taskId, undefined);
        expect((await storage.kanban.getKanbanTask(taskId))?.description).toBe(before?.description);
        expect(launched.deliveryPolicy).toBeUndefined();
      },
      { description: "Do it\n\n## Delivery\n\nPolicy: push-no-pr" },
    );
  });
});

describe("reading whether the branch was pushed", () => {
  const environment = { id: "env-1", branch: "recorded" };
  const storage = { getEnvironment: async () => environment as never };

  test("compares HEAD with origin's copy of the current branch", async () => {
    const remoteArgs: string[][] = [];
    const state = await readEnvironmentBranchPushState(
      storage,
      {
        git: async (_environment, args) =>
          args[0] === "rev-parse" && args[1] === "HEAD" ? `${HEAD}\n` : "work\n",
        remoteGit: async (_environment, _command, args) => {
          remoteArgs.push(args);
          return `${HEAD}\trefs/heads/work\n`;
        },
      },
      "env-1",
    );
    expect(state).toEqual({ branch: "work", head: HEAD, remoteHead: HEAD });
    expect(remoteArgs).toEqual([["origin", "refs/heads/work"]]);
  });

  test("a branch origin does not have reads as no remote head; detached HEAD uses the record", async () => {
    const state = await readEnvironmentBranchPushState(
      storage,
      {
        git: async (_environment, args) => (args[1] === "HEAD" ? `${HEAD}\n` : "HEAD\n"),
        remoteGit: async () => "",
      },
      "env-1",
    );
    expect(state).toEqual({ branch: "recorded", head: HEAD, remoteHead: null });
  });
});

describe("delivery recovery regressions", () => {
  test("a pre-session Ship failure retains the push-only decision on retry", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      setTicketPolicy(controls, "push-no-pr");
      const create = provider.createSession.bind(provider);
      let fail = true;
      provider.createSession = async (phase, label, options) => {
        if (phase === "pr" && fail) {
          fail = false;
          throw new Error("temporary session creation failure");
        }
        return create(phase, label, options);
      };
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      const failed = await advanceUntil(service, storage, started.id, finished);
      expect(failed.phase).toBe("failed");
      expect(failed.delivery?.policy).toBe("push-no-pr");
      await service.retryStage(started.id);
      const completed = await advanceUntil(service, storage, started.id, finished);
      expect(completed.phase).toBe("complete");
      expect(completed.sessions.find((entry) => entry.phase === "pr")?.label).toBe(
        BRANCH_PUSH_SESSION_LABEL,
      );
      expect(provider.sent.at(-1)?.prompt).toContain("Push the current branch to origin");
      expect(
        invocations.some(
          ({ command }) => command === "detect_pr_local" || command === "pr_monitor_watch",
        ),
      ).toBe(false);
    });
  });

  test("a paused push-only Ship resumes without authorizing a PR", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      setTicketPolicy(controls, "push-no-pr");
      provider.runningPhases.add("pr");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      await advanceUntil(
        service,
        storage,
        started.id,
        (state) =>
          state.phase === "creating-pr" &&
          state.sessions.at(-1)?.phase === "pr" &&
          state.sessions.at(-1)?.status === "running",
      );
      await service.pause(started.id);
      provider.runningPhases.delete("pr");
      const resumed = await service.resume(started.id);
      expect(resumed.pendingPromptAttempt?.prompt).toContain(
        "Do not create, edit, or reopen a pull request",
      );
      const completed = await advanceUntil(service, storage, started.id, finished);
      expect(provider.sent.at(-1)?.prompt).toContain(
        "Do not create, edit, or reopen a pull request",
      );
      expect(completed.phase).toBe("complete");
      expect(completed.delivery?.policy).toBe("push-no-pr");
      expect(invocations.some(({ command }) => command === "pr_monitor_watch")).toBe(false);
    });
  });

  test("launch fails before admission when the ticket policy cannot be captured", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "commit-only");
      controls.failCommands.add("get_kanban_tasks");
      await expect(service.start(startInput({ source: KANBAN_SOURCE }))).rejects.toThrow(
        "get_kanban_tasks failed",
      );
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
    });
  });

  test("completed builds and a later launch do not post too-late comments", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      setTicketPolicy(controls, "open-pr");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      await advanceUntil(service, storage, started.id, finished);
      await service.noteTicketDeliveryChange(TICKET, "project-1", "push-no-pr");
      expect(commentTexts(controls).some((text) => text.includes("Too late"))).toBe(false);
    });
  });

  test("a legacy active PR session still warns on a late policy change", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      provider.runningPhases.add("pr");
      const started = await service.start(startInput({ source: KANBAN_SOURCE }));
      const active = await advanceUntil(
        service,
        storage,
        started.id,
        (state) => state.phase === "creating-pr",
      );
      delete active.delivery;
      await storage.saveBuildPipeline(
        active.id,
        active.projectId,
        active.environmentId,
        1,
        active,
        active.backendRevision,
      );
      await service.noteTicketDeliveryChange(TICKET, "project-1", "commit-only");
      expect(commentTexts(controls).join("\n")).toContain("Too late for this build");
    });
  });

  test("a real ticket edit then deletion wins while Verify holds the pipeline lock", async () => {
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "Body", {
          sections: { delivery: { policy: "open-pr" } },
        });
        const notifications: Promise<void>[] = [];
        storage.kanban.onDeliveryPolicyChange((id, projectId, policy) => {
          notifications.push(service.noteTicketDeliveryChange(id, projectId, policy));
        });
        const started = await service.start(
          startInput({ taskId: task.id, source: { type: "kanban", taskId: task.id } }),
        );
        await advanceUntil(service, storage, started.id, verifying);
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const structured = provider.structured.bind(provider);
        provider.structured = async <T>(sessionId: string, requestId: string) => {
          if (provider.phases.get(sessionId) === "verify") {
            entered();
            await held;
          }
          return structured<T>(sessionId, requestId);
        };
        const advancing = service.advanceNow(started.id);
        try {
          await ready;
          await storage.kanban.updateKanbanTask(task.id, {
            sections: { delivery: { policy: "commit-only" } },
          });
          await storage.kanban.deleteKanbanTask(task.id);
          // The fallback is durable even before the listener obtains the lock.
          const reopened = new (storage.constructor as typeof StorageService)(controls.dataDir);
          expect(await reopened.kanban.getDeletedKanbanDeliveryPolicy(task.id, "project-1")).toBe(
            "commit-only",
          );
        } finally {
          release();
        }
        await advancing;
        await Promise.all(notifications);
        const completed = await advanceUntil(service, storage, started.id, finished);
        expect(completed.phase).toBe("complete");
        expect(completed.delivery?.policy).toBe("commit-only");
        expect(provider.created.some((entry) => entry.phase === "pr")).toBe(false);
      },
      { realKanban: true },
    );
  });
});

test("feature builds retain commit-only through ticket deletion and reject failed launch capture", async () => {
  await withService(
    async (service, storage, provider, _invocations, controls) => {
      await storage.addProject({
        id: "project-1",
        name: "Project",
        localPath: "/tmp/repo",
        addedAt: new Date().toISOString(),
      } as import("./models.js").Project);
      const context = {
        storage,
        runtime: { featureBuilds: new FeatureBuildTasks() },
        buildPipelines: service,
      };
      const input = {
        projectId: "project-1",
        title: "Feature",
        description: "Keep changes local",
        environmentType: "local" as const,
        agentType: "claude" as const,
        deliveryPolicy: "commit-only" as const,
      };
      controls.failCommands.add("get_kanban_tasks");
      await expect(
        createFeatureBuild({ ...input, requestId: "feature-delivery" }, context),
      ).rejects.toThrow("get_kanban_tasks failed");
      expect(await storage.listBuildPipelines("project-1")).toHaveLength(0);
      controls.failCommands.clear();
      const started = await createFeatureBuild(
        { ...input, requestId: "feature-delivery" },
        context,
      );
      expect((await pipeline(storage, started.pipelineId)).deliveryPolicy).toBe("commit-only");
      await storage.kanban.deleteKanbanTask(started.taskId);
      const completed = await advanceUntil(service, storage, started.pipelineId, finished);
      expect(completed.phase).toBe("complete");
      expect(completed.delivery?.policy).toBe("commit-only");
      expect(provider.created.some((entry) => entry.phase === "pr")).toBe(false);
    },
    { realKanban: true },
  );
});

test("an identical feature retry follows the user's edited policy through Verify", async () => {
  await withService(
    async (service, storage, provider) => {
      await storage.addProject({
        id: "project-1",
        name: "Project",
        localPath: "/tmp/repo",
        addedAt: new Date().toISOString(),
      } as import("./models.js").Project);
      const context = {
        storage,
        runtime: { featureBuilds: new FeatureBuildTasks() },
        buildPipelines: service,
      };
      const request = {
        projectId: "project-1",
        title: "Feature",
        description: "Respect edited delivery",
        environmentType: "local" as const,
        agentType: "claude" as const,
        deliveryPolicy: "open-pr" as const,
        requestId: "edited-feature",
      };
      const first = await createFeatureBuild(request, context);
      await storage.kanban.updateKanbanTask(first.taskId, {
        sections: { delivery: { policy: "commit-only" } },
      });
      const retried = await createFeatureBuild(request, context);
      expect(retried.pipelineId).toBe(first.pipelineId);
      const completed = await advanceUntil(service, storage, first.pipelineId, finished);
      expect(completed.delivery?.policy).toBe("commit-only");
      expect(provider.created.some((entry) => entry.phase === "pr")).toBe(false);
    },
    { realKanban: true },
  );
});
