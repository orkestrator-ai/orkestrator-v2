import { expect, spyOn, test } from "bun:test";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

function strictReport(value: unknown) {
  const report = value as StructuredReviewReport;
  return { ...report, issues: report.issues.map((issue) => ({ ...issue, alternativeFixes: [] })) };
}
import {
  advanceUntil,
  fourReviewers,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

for (const toolMode of [false, true]) {
  test.each(["accepted", "continue", "second-restart"] as const)(
    `pipeline consolidation handles %s after restart (${toolMode ? "tool" : "structured"})`,
    async (outcome) => {
      await withPipeline(
        async ({ service, provider, read, workflowResults }) => {
          provider.runningConsolidation = true;
          const started = await service.start(startInput(fourReviewers()));
          let current = await read(started.id);
          for (let pass = 0; pass < 20 && !current.reviewFanout?.consolidation; pass++) {
            await service.advanceNow(started.id);
            current = await read(started.id);
          }
          const first = current.reviewFanout!.consolidation!;
          const submitted = await provider.structured<unknown>(
            first.providerSessionId,
            first.requestId,
          );
          if (toolMode && outcome === "accepted") {
            expect(submitted?.ok).toBe(true);
            if (submitted?.ok)
              expect(
                await workflowResults!.submit(
                  { environmentId: "env-1", projectId: "project-1" },
                  first.requestId,
                  strictReport(submitted.value),
                ),
              ).toMatchObject({ ok: true });
          }
          provider.missingConsolidationResult = outcome !== "accepted";
          let interrupted = true;
          spyOn(provider, "observeSession").mockImplementation(async (sessionId) =>
            sessionId === first.providerSessionId && interrupted
              ? { status: "error", interruption: "restart", error: "Claude restarted" }
              : { status: await provider.status(sessionId) },
          );
          const sentBefore = provider.sent.length;
          await service.advanceNow(started.id);
          current = await read(started.id);
          if (outcome === "accepted") {
            expect(current.phase).toBe("addressing");
            expect(current.structuredReview).toBeDefined();
            expect(
              provider.sent.filter((entry) => entry.sessionId === first.providerSessionId),
            ).toHaveLength(1);
            return;
          }
          const continuation = current.reviewFanout!.consolidation!;
          expect(continuation).toMatchObject({
            state: "prepared",
            restartContinuationSent: true,
            providerSessionId: first.providerSessionId,
          });
          expect(continuation.requestId).not.toBe(first.requestId);
          expect(provider.sent).toHaveLength(sentBefore);
          interrupted = false;
          await service.advanceNow(started.id);
          expect(provider.sent.at(-1)).toMatchObject({
            sessionId: first.providerSessionId,
            requestId: continuation.requestId,
          });
          expect(provider.sent.at(-1)?.prompt).toContain("stopped partway");
          if (outcome === "second-restart") {
            interrupted = true;
            await service.advanceNow(started.id);
            expect((await read(started.id)).phase).toBe("failed");
          } else {
            provider.missingConsolidationResult = false;
            provider.runningConsolidation = false;
            if (toolMode) {
              const result = await provider.structured<unknown>(
                first.providerSessionId,
                continuation.requestId,
              );
              if (!result?.ok) throw new Error("Missing fixture result");
              await workflowResults!.submit(
                { environmentId: "env-1", projectId: "project-1" },
                continuation.requestId,
                strictReport(result.value),
              );
            }
            expect((await advanceUntil(service, read, started.id, "addressing")).phase).toBe(
              "addressing",
            );
          }
        },
        { toolMode },
      );
    },
  );

  test.each(["accepted", "continue", "second-restart", "stale-notice"] as const)(
    `pipeline stage handles %s after restart (${toolMode ? "tool" : "structured"})`,
    async (outcome) => {
      await withPipeline(
        async ({ service, provider, read, workflowResults }) => {
          const started = await service.start(startInput());
          const building = await advanceUntil(service, read, started.id, "building");
          const session = building.sessions[building.currentSessionIndex]!;
          const firstRequestId = session.structuredRequestId!;
          const result = await provider.structured<unknown>(session.sdkSessionId, firstRequestId);
          if (toolMode && outcome === "accepted" && result?.ok) {
            await workflowResults!.submit(
              { environmentId: "env-1", projectId: "project-1" },
              firstRequestId,
              result.value,
            );
          }
          const originalStructured = provider.structured.bind(provider);
          if (outcome !== "accepted") provider.structured = async () => null;
          let interrupted = true;
          spyOn(provider, "observeSession").mockImplementation(async (sessionId) =>
            sessionId === session.sdkSessionId && interrupted
              ? {
                  status: "error",
                  interruption: "restart",
                  error: "Claude restarted",
                  // A bridge that names the request the restart cut short.
                  ...(outcome === "stale-notice" ? { interruptedRequestId: firstRequestId } : {}),
                }
              : { status: "idle" },
          );
          const sentBefore = provider.sent.length;
          await service.advanceNow(started.id);
          const current = await read(started.id);
          if (outcome === "accepted") {
            expect(current.phase).toBe("reviewing");
            expect(current.error).toBeUndefined();
            return;
          }
          expect(current.phase).toBe("building");
          expect(current.sessions[current.currentSessionIndex]).toMatchObject({
            sdkSessionId: session.sdkSessionId,
            restartContinuationSent: true,
          });
          expect(provider.sent).toHaveLength(sentBefore + 1);
          const nextId = provider.sent.at(-1)!.requestId;
          expect(nextId).not.toBe(firstRequestId);
          expect(provider.sent.at(-1)?.prompt).toContain("stopped partway");
          if (outcome === "second-restart") {
            await service.advanceNow(started.id);
            expect((await read(started.id)).phase).toBe("failed");
          } else {
            if (outcome === "stale-notice") {
              // Sent, not started: the notice still names the original
              // request, so it is not the continuation's second restart (0112).
              spyOn(provider, "dispatchStatus").mockImplementation(async (_sessionId, requestId) =>
                requestId === nextId ? "pending" : "dispatched",
              );
              await service.advanceNow(started.id);
              const waiting = await read(started.id);
              expect(waiting.phase).toBe("building");
              expect(waiting.error).toBeUndefined();
              expect(provider.sent).toHaveLength(sentBefore + 1);
            }
            interrupted = false;
            provider.structured = originalStructured;
            if (toolMode && result?.ok)
              await workflowResults!.submit(
                { environmentId: "env-1", projectId: "project-1" },
                nextId,
                result.value,
              );
            await service.advanceNow(started.id);
            expect((await read(started.id)).phase).toBe("reviewing");
          }
        },
        { toolMode, toolKinds: ["review-preparation"] },
      );
    },
  );
}
