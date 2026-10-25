import { describe, expect, spyOn, test } from "bun:test";
import type { BuildPipelineSupervisor } from "./build-pipeline-service-supervisor.js";
import { AmbiguousPromptDispatchError } from "./build-pipeline-provider.js";
import { REVIEW_VALIDATION_PLAN_SCHEMA } from "./review-validation-prompts.js";
import { VERIFICATION_SCHEMA } from "./build-pipeline-service-helpers.js";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "@orkestrator/protocol/structured-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  advanceUntil,
  fourReviewers,
  startInput,
  rewritePipeline,
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

// Exercise the stage reminder boundary with real slot preparation and dispatch.
for (const [phase, kind, tool] of [
  ["fixing", "validation-plan", "submit_validation_plan"],
  ["reviewing", "review-report", "submit_review_report"],
  ["verifying", "verification-result", "submit_verification_result"],
] as const) {
  test.each(["present", "missing", "throws", "mismatch"] as const)(
    `${phase} reminder uses its ${kind} binding (%s)`,
    async (bindingState) => {
      await withPipeline(
        async ({ service, provider, read, workflowResults }) => {
          const started = await service.start(startInput());
          const pipeline = await advanceUntil(service, read, started.id, "building");
          const session = pipeline.sessions[pipeline.currentSessionIndex]!;
          pipeline.phase = phase;
          const binding = await workflowResults!.binding(scope, session.structuredRequestId!);
          expect(binding).toBeDefined();
          const lookup = spyOn(workflowResults!, "binding").mockImplementation(async () => {
            if (bindingState === "throws") throw new Error("slot store unavailable");
            if (bindingState === "missing") return null;
            return { ...binding!, kind: bindingState === "mismatch" ? "fix-result" : kind };
          });
          const prepare = spyOn(workflowResults!, "prepare");
          const before = provider.sent.length;
          const supervisor = (service as unknown as { stageSupervisor: BuildPipelineSupervisor })
            .stageSupervisor;
          try {
            expect(await supervisor.remindMissingStageResult(pipeline, provider, session)).toBe(
              bindingState === "present",
            );
            expect(provider.sent.length - before).toBe(bindingState === "present" ? 1 : 0);
            if (bindingState === "present") {
              expect(provider.sent.at(-1)!.prompt).toContain(tool);
              expect(prepare.mock.calls.at(-1)![0].kind).toBe(kind);
              expect(prepare.mock.calls.at(-1)![0].schema).toEqual(
                kind === "validation-plan"
                  ? REVIEW_VALIDATION_PLAN_SCHEMA
                  : kind === "review-report"
                    ? STRUCTURED_REVIEW_REPORT_JSON_SCHEMA
                    : VERIFICATION_SCHEMA,
              );
            } else {
              expect(session.resultReminderSent).toBeUndefined();
              expect(prepare).not.toHaveBeenCalled();
            }
          } finally {
            lookup.mockRestore();
            prepare.mockRestore();
          }
        },
        { toolMode: true, toolKinds: ["review-preparation"] },
      );
    },
  );
}

for (const owner of ["stage", "consolidation"] as const) {
  test.each(["prepared", "ambiguous", "sent"] as const)(
    `${owner} reminder survives service recreation at %s with its identity and one-shot budget`,
    async (boundary) => {
      await withPipeline(
        async ({ service, createService, provider, read }) => {
          const started = await service.start(
            startInput(owner === "consolidation" ? fourReviewers() : undefined),
          );
          let current = await advanceUntil(
            service,
            read,
            started.id,
            owner === "stage" ? "building" : "reviewing",
          );
          if (owner === "stage")
            spyOn(provider, "observeSession").mockResolvedValue({ status: "idle" });
          // Stop immediately after the follow-up intent becomes durable.
          const send = provider.send.bind(provider);
          let failSend = owner === "stage" && boundary !== "sent";
          const sendSpy = spyOn(provider, "send").mockImplementation(
            async (sessionId, prompt, options) => {
              if (failSend && prompt.includes("has not received")) {
                if (boundary === "ambiguous") await send(sessionId, prompt, options);
                throw new AmbiguousPromptDispatchError("acknowledgement lost");
              }
              await send(sessionId, prompt, options);
            },
          );
          const record = () =>
            owner === "stage"
              ? current.sessions[current.currentSessionIndex]!
              : current.reviewFanout!.consolidation!;
          for (let pass = 0; pass < 40 && !record()?.resultReminderSent; pass++) {
            await service.advanceNow(started.id);
            current = await read(started.id);
          }
          expect(record().resultReminderSent).toBe(true);
          if (owner === "consolidation" && boundary !== "prepared") {
            failSend = boundary === "ambiguous";
            await service.advanceNow(started.id);
            current = await read(started.id);
          }
          const requestId =
            owner === "stage"
              ? current.sessions[current.currentSessionIndex]!.structuredRequestId!
              : current.reviewFanout!.consolidation!.requestId;
          const sessionId =
            owner === "stage"
              ? current.sessions[current.currentSessionIndex]!.sdkSessionId
              : current.reviewFanout!.consolidation!.providerSessionId;
          await service.shutdown();
          failSend = false;
          const restored = createService();
          try {
            await restored.init();
            await restored.advanceNow(started.id);
            const reloaded = await read(started.id);
            expect(
              owner === "stage"
                ? reloaded.sessions[reloaded.currentSessionIndex]!.structuredRequestId
                : reloaded.reviewFanout!.consolidation!.requestId,
            ).toBe(requestId);
            const failed = await advanceUntil(restored, read, started.id, "failed", 35);
            expect(failed.phase).toBe("failed");
            const sentIds = provider.sent
              .filter((entry) => entry.sessionId === sessionId)
              .map((entry) => entry.requestId);
            expect(new Set(sentIds).size).toBe(2);
            // A stable ID reconciles or deduplicates a lost acknowledgement.
            expect(sentIds).toHaveLength(2);
          } finally {
            sendSpy.mockRestore();
            await restored.shutdown();
          }
        },
        {
          toolMode: true,
          toolKinds: owner === "stage" ? ["review-preparation"] : ["consolidated-review"],
          structuredResultDeadlineMs: 0,
        },
      );
    },
  );
}

test.each(["structured", "received", "needs-attention", "restart-spent"] as const)(
  "consolidation reminder eligibility: %s",
  async (scenario) => {
    await withPipeline(
      async ({ service, provider, storage, read, workflowResults }) => {
        provider.runningConsolidation = true;
        const started = await service.start(startInput(fourReviewers()));
        let current = await read(started.id);
        for (let pass = 0; pass < 30 && !current.reviewFanout?.consolidation; pass++) {
          await service.advanceNow(started.id);
          current = await read(started.id);
        }
        const consolidation = current.reviewFanout!.consolidation!;
        expect(consolidation.state).toBe("sent");
        await rewritePipeline(storage, started.id, (pipeline) => {
          if (scenario === "restart-spent")
            pipeline.reviewFanout!.consolidation!.restartContinuationSent = true;
        });
        const projection =
          workflowResults &&
          spyOn(workflowResults, "projection").mockResolvedValue(
            scenario === "restart-spent"
              ? undefined
              : scenario === "structured"
                ? undefined
                : scenario,
          );
        const structured =
          workflowResults && spyOn(workflowResults, "structured").mockResolvedValue(null);
        provider.missingConsolidationResult = true;
        provider.runningConsolidation = false;
        try {
          const failed = await advanceUntil(service, read, started.id, "failed", 35);
          expect(failed.phase).toBe("failed");
          expect(failed.reviewFanout!.consolidation!.resultReminderSent).toBe(
            scenario === "restart-spent" ? true : undefined,
          );
          expect(
            provider.sent.filter((entry) => entry.sessionId === consolidation.providerSessionId),
          ).toHaveLength(scenario === "restart-spent" ? 2 : 1);
        } finally {
          projection?.mockRestore();
          structured?.mockRestore();
        }
      },
      { toolMode: scenario !== "structured" },
    );
  },
);

test.each([false, true])(
  "consolidation parks an unaccepted recovered dispatch (continuation %s)",
  async (continuation) => {
    await withPipeline(
      async ({ service, createService, storage, provider, read }) => {
        provider.runningConsolidation = true;
        const started = await service.start(startInput(fourReviewers()));
        let current = await read(started.id);
        for (let pass = 0; pass < 30 && !current.reviewFanout?.consolidation; pass++) {
          await service.advanceNow(started.id);
          current = await read(started.id);
        }
        const original = current.reviewFanout!.consolidation!;
        // Durable dispatch intent before send, or before a continuation lands.
        await rewritePipeline(storage, started.id, (pipeline) => {
          const request = pipeline.reviewFanout!.consolidation!;
          request.requestId = "not-yet-accepted";
          request.state = "dispatching";
          request.continuationPrompt = "Continue the consolidation";
          if (continuation) request.restartContinuationSent = true;
        });
        await service.shutdown();
        const restored = createService();
        const observe = spyOn(provider, "observeSession").mockResolvedValue({
          status: "error",
          interruption: "restart",
        } as Awaited<ReturnType<NonNullable<typeof provider.observeSession>>>);
        try {
          await restored.init();
          const before = provider.sent.length;
          await restored.advanceNow(started.id);
          const parked = (await read(started.id)).reviewFanout!.consolidation!;
          expect(parked).toMatchObject({
            requestId: "not-yet-accepted",
            state: "dispatching",
            continuationPrompt: "Continue the consolidation",
          });
          expect(parked.resultReminderSent).toBeUndefined();
          expect(provider.sent).toHaveLength(before);
          expect(observe).not.toHaveBeenCalled();
          // The old owner's in-flight continuation finally arrives with the same ID.
          await provider.send(original.providerSessionId, "Continue the consolidation", {
            requestId: parked.requestId,
          });
          observe.mockResolvedValue({ status: "running" });
          await restored.advanceNow(started.id);
          expect((await read(started.id)).reviewFanout!.consolidation!.state).toBe("sent");
          expect((await read(started.id)).phase).toBe("reviewing");
        } finally {
          observe.mockRestore();
          await restored.shutdown();
        }
      },
      { toolMode: true },
    );
  },
);
