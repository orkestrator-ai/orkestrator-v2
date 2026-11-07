/**
 * A build the coordinator starts reports back to its ticket the way a Build
 * button launch does: the start command links it (`source: kanban`), so Verify's
 * per-criterion results, the status and PR moves and the delivery policy's
 * "too late" comment all reach the ticket.
 */
import { registrarFrom } from "./commands-registry-contracts.js";
import { describe, expect, test } from "bun:test";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { ticketContentFromSections } from "@orkestrator/protocol/ticket-sections";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import {
  cleanReview,
  pipeline,
  startInput,
  withService,
  type FakeProvider,
} from "./build-pipeline-service-test-support.js";
import { TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerControllerWorkflowCommands } from "./commands-registry-controller-workflows.js";
import type { StorageService } from "./storage.js";

const HEAD = "a".repeat(40);
const TICKET = {
  id: "task-default",
  status: "backlog",
  comments: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  ...ticketContentFromSections("work-brief", {
    summary: "Move the runner",
    acceptanceCriteria: [
      { id: "ac-4", text: "No renderer orchestration" },
      { id: "ac-5", text: "Ticks show on the ticket" },
    ],
    delivery: { policy: "open-pr" },
  }),
};

type Controls = Parameters<Parameters<typeof withService>[0]>[4];

/** Verify passes both criteria; every other stage answers as usual. */
function verdicts(provider: FakeProvider): void {
  provider.structured = async <T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T>> => {
    const phase = provider.phases.get(sessionId);
    return {
      ok: true,
      provider: "claude",
      requestId,
      value: (phase === "review"
        ? cleanReview
        : phase === "build" || phase === "fix"
          ? TEST_REVIEW_PREPARATION
          : {
              complete: true,
              rationale: "Done.",
              acceptanceCriteria: [
                { id: "ac-4", status: "passed", evidence: "runner.test.ts passes" },
                { id: "ac-5", status: "passed", evidence: "The board shows both ticks." },
              ],
            }) as T,
    };
  };
}

/**
 * Starts a build the way a coordinator does on a node: through
 * `start_controller_build_pipeline`, which checks the ticket and links it.
 */
async function startAsCoordinator(
  service: BuildPipelineService,
  storage: StorageService,
  controls: Controls,
): Promise<BuildPipeline> {
  await storage.updateEnvironment("env-1", { createdFromCommit: HEAD });
  const registered = new Map<string, CommandHandler>();
  registerControllerWorkflowCommands(
    registrarFrom((name, handler) => registered.set(name, handler)),
    {
      commands: new Map(),
    } as never,
  );
  const context = {
    storage: {
      getProject: async (id: string) => (id === "project-1" ? { id } : null),
      loadConfig: () => storage.loadConfig(),
      getEnvironment: (id: string) => storage.getEnvironment(id),
      kanban: {
        getKanbanTask: async (id: string) => {
          const task = controls.kanbanTasks.get(id);
          return task ? { ...task, projectId: "project-1" } : null;
        },
      },
    },
    buildPipelines: service,
  } as unknown as CommandContext;
  // What the coordinator's tool sends: a taskId and a snapshot, never a source.
  const { source: _source, ...input } = startInput({
    taskSnapshot: {
      title: "Backend pipeline",
      description: TICKET.description,
      acceptanceCriteria: TICKET.acceptanceCriteria,
      comments: [],
      images: [],
    },
    delegationBaseBranch: "main",
    delegationBaseCommit: HEAD,
  });
  return (await registered.get("start_controller_build_pipeline")!(
    { input },
    context,
  )) as BuildPipeline;
}

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

const finished = (snapshot: BuildPipeline) =>
  snapshot.phase === "complete" || snapshot.phase === "failed";

describe("a coordinator-started build and its ticket", () => {
  test("records Verify's results and moves the ticket's status and pull request", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      controls.kanbanTasks.set(TICKET.id, structuredClone(TICKET) as never);
      verdicts(provider);
      const started = await startAsCoordinator(service, storage, controls);
      expect(started.source).toEqual({ type: "kanban", taskId: TICKET.id });

      const completed = await advanceUntil(service, storage, started.id, finished);

      expect(completed.phase).toBe("complete");
      expect(invocations).toContainEqual({
        command: "update_kanban_task",
        args: { taskId: TICKET.id, environmentId: "env-1", buildPipelineId: started.id },
      });
      const task = controls.kanbanTasks.get(TICKET.id) as unknown as {
        status: string;
        prUrl?: string;
        prState?: string;
        criteriaChecks?: unknown;
      };
      expect(task.criteriaChecks).toMatchObject([
        {
          id: "ac-4",
          text: "No renderer orchestration",
          check: {
            status: "passed",
            evidence: "runner.test.ts passes",
            source: "verify",
            pipelineId: started.id,
          },
        },
        {
          id: "ac-5",
          text: "Ticks show on the ticket",
          check: {
            status: "passed",
            evidence: "The board shows both ticks.",
            source: "verify",
            pipelineId: started.id,
          },
        },
      ]);
      expect(task.status).toBe("review");
      expect(task.prUrl).toBe("https://github.com/acme/repo/pull/1");
      expect(task.prState).toBe("open");
    });
  });

  test("a delivery change after the PR stage started comments that it came too late", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      controls.kanbanTasks.set(TICKET.id, structuredClone(TICKET) as never);
      verdicts(provider);
      provider.runningPhases.add("pr");
      const started = await startAsCoordinator(service, storage, controls);
      await advanceUntil(service, storage, started.id, (snapshot) =>
        snapshot.sessions.some((session) => session.phase === "pr"),
      );

      controls.kanbanTasks.get(TICKET.id)!.sections = { delivery: { policy: "push-no-pr" } };
      await service.noteTicketDeliveryChange(TICKET.id, "project-1", "push-no-pr");

      const comments = controls.kanbanTasks.get(TICKET.id)!.comments.map(({ text }) => text);
      const tooLate = comments.filter((text) => text.includes("Too late"));
      expect(tooLate).toHaveLength(1);
      expect(tooLate[0]).toContain("Push, no PR");
    });
  });

  test("an unlinked build, as coordinators started before, reaches none of this", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      controls.kanbanTasks.set(TICKET.id, structuredClone(TICKET) as never);
      verdicts(provider);
      const started = await service.start(startInput());

      await advanceUntil(service, storage, started.id, finished);

      const commands = invocations.map(({ command }) => command);
      expect(commands).not.toContain("record_kanban_criteria_checks");
      expect(commands).not.toContain("update_kanban_task");
    });
  });
});
