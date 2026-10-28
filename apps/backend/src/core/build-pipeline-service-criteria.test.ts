import { describe, expect, test } from "bun:test";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { ticketContentFromSections } from "@orkestrator/protocol/ticket-sections";
import { TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";
import {
  cleanReview,
  pipeline,
  startInput,
  withService,
  type FakeProvider,
} from "./build-pipeline-service-test-support.js";

/**
 * Verify judges each acceptance criterion by the ticket's own id; the session
 * keeps the results, the fix step's feedback names the failed ones, and the
 * Kanban ticket receives the ticks.
 */

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
  }),
};

/** Advances until the first verify session has its verdict. */
async function untilVerified(
  service: Parameters<Parameters<typeof withService>[0]>[0],
  storage: Parameters<Parameters<typeof withService>[0]>[1],
  id: string,
) {
  for (let pass = 0; pass < 12; pass += 1) {
    const current = await pipeline(storage, id);
    if (
      current.sessions.some((session) => session.phase === "verify" && session.verificationResult)
    )
      return current;
    await service.advanceNow(id);
  }
  return pipeline(storage, id);
}

function verdictWith(provider: FakeProvider, verify: Record<string, unknown>) {
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
        : verify) as T,
  });
}

describe("build pipeline acceptance criteria", () => {
  test("records each criterion's result and writes the ticks to the ticket", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      controls.kanbanTasks.set(TICKET.id, TICKET as never);
      verdictWith(provider, {
        complete: false,
        rationale: "One criterion is unmet.",
        acceptanceCriteria: [
          { id: "ac-4", status: "passed", evidence: "bun test runner.test.ts passes" },
          { id: "ac-5", status: "failed", evidence: "The ticket view shows no ticks." },
        ],
      });
      const started = await service.start(
        startInput({
          maxIterations: 1,
          source: { type: "kanban", taskId: TICKET.id },
          taskSnapshot: {
            title: "Backend pipeline",
            description: TICKET.description,
            acceptanceCriteria: TICKET.acceptanceCriteria,
            comments: [],
            images: [],
          },
        }),
      );
      expect(started.taskSnapshot).toMatchObject({
        kind: "work-brief",
        acceptanceCriteriaItems: [
          { id: "ac-4", text: "No renderer orchestration" },
          { id: "ac-5", text: "Ticks show on the ticket" },
        ],
      });
      const stored = await untilVerified(service, storage, started.id);
      const verify = stored.sessions.find((session) => session.phase === "verify")!;
      expect(verify.acceptanceCriteriaResults).toEqual([
        { id: "ac-4", status: "passed", evidence: "bun test runner.test.ts passes" },
        { id: "ac-5", status: "failed", evidence: "The ticket view shows no ticks." },
      ]);
      expect(verify.verificationFeedback).toBe(
        "One criterion is unmet.\n\nUnmet acceptance criteria:\n- ac-5: Ticks show on the ticket (The ticket view shows no ticks.)",
      );
      const recorded = invocations.find(
        (invocation) => invocation.command === "record_kanban_criteria_checks",
      );
      expect(recorded?.args).toMatchObject({
        taskId: TICKET.id,
        checks: [
          {
            id: "ac-4",
            text: "No renderer orchestration",
            check: { status: "passed", source: "verify", pipelineId: started.id },
          },
          {
            id: "ac-5",
            text: "Ticks show on the ticket",
            check: { status: "failed", source: "verify", pipelineId: started.id },
          },
        ],
      });
    });
  });

  test("a criterion Verify skipped is not checked, never passed", async () => {
    await withService(async (service, storage, provider) => {
      verdictWith(provider, { complete: true, rationale: "Done.", acceptanceCriteria: [] });
      const started = await service.start(startInput());
      // The ticket was not found, so ids come from the snapshot's own text.
      expect(started.taskSnapshot.acceptanceCriteriaItems).toEqual([
        { id: "ac-1", text: "No renderer orchestration" },
      ]);
      const stored = await untilVerified(service, storage, started.id);
      const verify = stored.sessions.find((session) => session.phase === "verify")!;
      expect(verify.acceptanceCriteriaResults).toEqual([
        { id: "ac-1", status: "not-checked", evidence: "Verify did not report on this criterion." },
      ]);
      expect(stored.verificationResult).toBe("pass");
    });
  });

  test("an old two-field verdict explicitly records criteria as not checked", async () => {
    await withService(async (service, storage, _provider, invocations) => {
      const started = await service.start(
        startInput({ source: { type: "kanban", taskId: "task-default" } }),
      );
      const stored = await untilVerified(service, storage, started.id);
      const verify = stored.sessions.find((session) => session.phase === "verify")!;
      expect(verify.verificationResult).toBe("pass");
      expect(verify.acceptanceCriteriaResults).toEqual([
        { id: "ac-1", status: "not-checked", evidence: "Verify did not report on this criterion." },
      ]);
      expect(
        invocations.some((invocation) => invocation.command === "record_kanban_criteria_checks"),
      ).toBe(true);
    });
  });
  test("complete true with a failed criterion cannot advance to PR", async () => {
    await withService(async (service, storage, provider) => {
      verdictWith(provider, {
        complete: true,
        rationale: "Contradictory result.",
        acceptanceCriteria: [
          { id: "ac-1", status: "failed", evidence: "Runner still lives in renderer." },
        ],
      });
      const started = await service.start(startInput({ maxIterations: 1 }));
      const stored = await untilVerified(service, storage, started.id);
      expect(stored.verificationResult).toBe("fail");
      expect(stored.sessions.some((session) => session.phase === "pr")).toBe(false);
    });
  });

  test("changed description criteria use the snapshot and cannot tick the live requirement", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      const live = await storage.kanban.addKanbanTask(
        "project-1",
        "T",
        "Summary\n\n## Acceptance criteria\n\n- New requirement",
      );
      controls.kanbanTasks.set(live.id, live);
      verdictWith(provider, {
        complete: true,
        rationale: "Snapshot requirement met.",
        acceptanceCriteria: [
          { id: "ac-1", status: "passed", evidence: "Old requirement implemented." },
        ],
      });
      const started = await service.start(
        startInput({
          taskId: live.id,
          source: { type: "kanban", taskId: live.id },
          taskSnapshot: {
            title: "T",
            description: "Summary\n\n## Acceptance criteria\n\n- Old requirement",
            acceptanceCriteria: "",
            images: [],
            comments: [],
          },
        }),
      );
      expect(started.taskSnapshot.acceptanceCriteriaItems).toEqual([
        { id: "ac-1", text: "Old requirement" },
      ]);
      await untilVerified(service, storage, started.id);
      const recorded = invocations.find(
        (call) => call.command === "record_kanban_criteria_checks",
      )!;
      await storage.kanban.recordKanbanCriteriaChecks(
        live.id,
        recorded.args.checks as Parameters<typeof storage.kanban.recordKanbanCriteriaChecks>[1],
      );
      expect((await storage.kanban.getKanbanTask(live.id))?.sections?.acceptanceCriteria).toEqual([
        { id: "ac-1", text: "New requirement" },
      ]);
    });
  });

  test("a failed live lookup still derives criteria from the snapshot", async () => {
    await withService(async (service, _storage, _provider, _invocations, controls) => {
      controls.failCommands.add("get_kanban_tasks");
      const started = await service.start(startInput());
      expect(started.taskSnapshot.acceptanceCriteriaItems).toEqual([
        { id: "ac-1", text: "No renderer orchestration" },
      ]);
    });
  });

  test("a criterion longer than the tool input limit retains its text for ticket write-back", async () => {
    await withService(async (service, storage, provider, invocations, controls) => {
      const text = "Long criterion " + "x".repeat(10_001);
      const live = await storage.kanban.addKanbanTask("project-1", "T", undefined, {
        markdown: "Summary\n\n## Acceptance criteria\n\n- " + text,
      });
      controls.kanbanTasks.set(live.id, live);
      verdictWith(provider, {
        complete: true,
        rationale: "Criterion implemented.",
        acceptanceCriteria: [
          { id: "ac-1", status: "passed", evidence: "Checked unchanged requirement." },
        ],
      });
      const started = await service.start(
        startInput({
          taskId: live.id,
          source: { type: "kanban", taskId: live.id },
          taskSnapshot: {
            title: "T",
            description: live.description,
            acceptanceCriteria: live.acceptanceCriteria,
            images: [],
            comments: [],
          },
        }),
      );
      expect(started.taskSnapshot.acceptanceCriteriaItems?.[0]?.text).toBe(text);
      await untilVerified(service, storage, started.id);
      const recorded = invocations.find(
        (call) => call.command === "record_kanban_criteria_checks",
      )!;
      await storage.kanban.recordKanbanCriteriaChecks(
        live.id,
        recorded.args.checks as Parameters<typeof storage.kanban.recordKanbanCriteriaChecks>[1],
      );
      expect(
        (await storage.kanban.getKanbanTask(live.id))?.sections?.acceptanceCriteria?.[0],
      ).toMatchObject({ text, check: { status: "passed", pipelineId: started.id } });
    });
  });
});
