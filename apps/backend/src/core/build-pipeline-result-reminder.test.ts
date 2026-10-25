import { describe, expect, spyOn, test } from "bun:test";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  advanceUntil,
  fourReviewers,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

const scope = { environmentId: "env-1", projectId: "project-1" };

function strictReport(value: unknown) {
  const report = value as StructuredReviewReport;
  return { ...report, issues: report.issues.map((issue) => ({ ...issue, alternativeFixes: [] })) };
}

describe("build pipeline stage result reminder", () => {
  test.each(["delivers", "ignores"] as const)(
    "a tool-mode stage that never submits gets one reminder and %s it",
    async (outcome) => {
      await withPipeline(
        async ({ service, provider, read, workflowResults }) => {
          const started = await service.start(startInput());
          const building = await advanceUntil(service, read, started.id, "building");
          const session = building.sessions[building.currentSessionIndex]!;
          const firstRequestId = session.structuredRequestId!;
          expect(session.resultTransport).toBe("tool-v1");
          const result = await provider.structured<unknown>(session.sdkSessionId, firstRequestId);
          if (!result?.ok) throw new Error("Missing fixture result");
          // The turn ends without a submission.
          spyOn(provider, "observeSession").mockImplementation(async () => ({ status: "idle" }));

          // First idle pass starts the wait; the second is past a zero deadline.
          await service.advanceNow(started.id);
          expect((await read(started.id)).phase).toBe("building");
          const sentBefore = provider.sent.length;
          await service.advanceNow(started.id);

          const reminded = await read(started.id);
          expect(reminded.phase).toBe("building");
          const remindedSession = reminded.sessions[reminded.currentSessionIndex]!;
          expect(remindedSession).toMatchObject({
            sdkSessionId: session.sdkSessionId,
            resultReminderSent: true,
          });
          expect(remindedSession.restartContinuationSent).toBeUndefined();
          expect(provider.sent).toHaveLength(sentBefore + 1);
          const reminder = provider.sent.at(-1)!;
          expect(reminder.sessionId).toBe(session.sdkSessionId);
          expect(reminder.requestId).not.toBe(firstRequestId);
          expect(remindedSession.structuredRequestId).toBe(reminder.requestId);
          expect(reminder.prompt).toContain("has not received your review preparation");
          expect(reminder.prompt).toContain("submit_review_preparation");
          expect(reminder.prompt).toContain(reminder.requestId);
          expect(await workflowResults!.status(scope, firstRequestId)).toMatchObject({
            lifecycle: "superseded",
          });

          if (outcome === "delivers") {
            await workflowResults!.submit(scope, reminder.requestId, result.value);
            await service.advanceNow(started.id);
            expect((await read(started.id)).phase).toBe("reviewing");
            return;
          }
          // The reminder is spent: the next missed deadline fails the stage.
          await service.advanceNow(started.id);
          await service.advanceNow(started.id);
          const failed = await read(started.id);
          expect(failed.phase).toBe("failed");
          expect(failed.error).toContain("without returning its required structured result");
          expect(provider.sent).toHaveLength(sentBefore + 1);
        },
        { toolMode: true, toolKinds: ["review-preparation"], structuredResultDeadlineMs: 0 },
      );
    },
  );

  test("a structured-output stage still fails without a reminder", async () => {
    await withPipeline(
      async ({ service, provider, read }) => {
        const started = await service.start(startInput());
        const building = await advanceUntil(service, read, started.id, "building");
        const session = building.sessions[building.currentSessionIndex]!;
        expect(session.resultTransport).not.toBe("tool-v1");
        provider.structured = async () => null;
        spyOn(provider, "observeSession").mockImplementation(async () => ({ status: "idle" }));
        const sentBefore = provider.sent.length;
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        const failed = await read(started.id);
        expect(failed.phase).toBe("failed");
        expect(failed.sessions[failed.currentSessionIndex]?.resultReminderSent).toBeUndefined();
        expect(provider.sent).toHaveLength(sentBefore);
      },
      { structuredResultDeadlineMs: 0 },
    );
  });
});

describe("build pipeline consolidation result reminder", () => {
  test.each(["delivers", "ignores"] as const)(
    "a tool-mode consolidation that never submits gets one reminder and %s it",
    async (outcome) => {
      await withPipeline(
        async ({ service, provider, read, workflowResults }) => {
          const started = await service.start(startInput(fourReviewers()));
          let current = await read(started.id);
          for (
            let pass = 0;
            pass < 40 && !current.reviewFanout?.consolidation?.resultReminderSent;
            pass++
          ) {
            if (current.phase === "failed") break;
            await service.advanceNow(started.id);
            current = await read(started.id);
          }
          const consolidation = current.reviewFanout!.consolidation!;
          expect(current.phase).toBe("reviewing");
          expect(consolidation).toMatchObject({
            resultTransport: "tool-v1",
            resultReminderSent: true,
            state: "prepared",
          });
          expect(consolidation.restartContinuationSent).toBeUndefined();
          const firstRequestIds = provider.sent
            .filter((entry) => entry.sessionId === consolidation.providerSessionId)
            .map((entry) => entry.requestId);
          expect(firstRequestIds).toHaveLength(1);
          expect(consolidation.requestId).not.toBe(firstRequestIds[0]);
          expect(await workflowResults!.status(scope, firstRequestIds[0]!)).toMatchObject({
            lifecycle: "superseded",
          });

          await service.advanceNow(started.id);
          const reminder = provider.sent.at(-1)!;
          expect(reminder).toMatchObject({
            sessionId: consolidation.providerSessionId,
            requestId: consolidation.requestId,
          });
          expect(reminder.prompt).toContain("has not received your consolidated report");
          expect(reminder.prompt).toContain("submit_consolidated_review");

          if (outcome === "delivers") {
            const value = await provider.structured<unknown>(
              consolidation.providerSessionId,
              consolidation.requestId,
            );
            if (!value?.ok) throw new Error("Missing fixture result");
            expect(
              await workflowResults!.submit(
                scope,
                consolidation.requestId,
                strictReport(value.value),
              ),
            ).toMatchObject({ ok: true });
            const addressed = await advanceUntil(service, read, started.id, "addressing");
            expect(addressed.phase).toBe("addressing");
            expect(addressed.structuredReview).toBeDefined();
            return;
          }
          const failed = await advanceUntil(service, read, started.id, "failed", 30);
          expect(failed.phase).toBe("failed");
          expect(failed.error).toContain(
            "The consolidation session finished without calling submit_consolidated_review",
          );
          expect(
            provider.sent.filter((entry) => entry.sessionId === consolidation.providerSessionId),
          ).toHaveLength(2);
        },
        { toolMode: true },
      );
    },
  );
});
