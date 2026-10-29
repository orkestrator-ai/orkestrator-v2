import { describe, expect, spyOn, test } from "bun:test";
import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { ADDRESS_FIX_RESULT_FRAME_OPEN } from "@orkestrator/protocol/review-evidence-frames";
import {
  advanceUntil,
  rewritePipeline,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";
import { TEST_FIX_RESULT } from "./build-pipeline-test-fixtures.js";
import { REVIEW_FIX_RESULT_JSON_SCHEMA } from "./review-prompts.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { resumePromptFor } from "./build-pipeline-service-helpers.js";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";

const scope = { environmentId: "env-1", projectId: "project-1" };

function current(pipeline: BuildPipeline): PipelineSession {
  return pipeline.sessions[pipeline.currentSessionIndex]!;
}

function verifyPrompt(
  sent: ReadonlyArray<{ sessionId: string; prompt: string }>,
): string | undefined {
  return sent.find((entry) => entry.prompt.startsWith("Verify the committed branch changes"))
    ?.prompt;
}

describe("typed Address report", () => {
  test("an Address submission reaches the Verify prompt as a framed report", async () => {
    await withPipeline(
      async ({ service, provider, read, workflowResults }) => {
        const started = await service.start(startInput());
        const addressing = await advanceUntil(service, read, started.id, "addressing");
        expect(addressing.phase).toBe("addressing");
        const address = current(addressing);
        expect(address).toMatchObject({
          phase: "address",
          addressReportKind: "fix-result",
          resultTransport: "tool-v1",
          structuredResultStatus: "pending",
        });
        const dispatch = provider.sent.find((entry) => entry.sessionId === address.sdkSessionId)!;
        expect(dispatch.prompt).toContain("submit_fix_result");
        expect(dispatch.prompt).toContain("Report your work in the fix result you submit");
        expect(dispatch.workflowResultTool).toBe("submit_fix_result");

        const submitted = {
          ...TEST_FIX_RESULT,
          complete: false,
          summary: "Fixed the inverted branch; lint still fails on origin/main.",
          commandsRun: [
            { command: "bun test src/app.test.ts", result: "passed" as const, summary: "Passes." },
            { command: "bun run lint", result: "failed" as const, summary: "Pre-existing." },
          ],
          limitations: ["Lint fails on origin/main too; reproduced in a detached worktree."],
        };
        expect(
          await workflowResults!.submit(scope, address.structuredRequestId!, submitted),
        ).toMatchObject({ ok: true });

        const verifying = await advanceUntil(service, read, started.id, "verifying");
        expect(verifying.phase).toBe("verifying");
        const accepted = verifying.sessions.find(
          (session) => session.sdkSessionId === address.sdkSessionId,
        )!;
        expect(accepted.structuredResultStatus).toBe("accepted");
        expect(accepted.fixResult).toEqual(submitted);
        expect(await workflowResults!.status(scope, address.structuredRequestId!)).toMatchObject({
          lifecycle: "consumed",
        });

        const prompt = verifyPrompt(provider.sent)!;
        expect(prompt).toContain(ADDRESS_FIX_RESULT_FRAME_OPEN);
        expect(prompt).toContain(submitted.summary);
        expect(prompt).toContain("Lint fails on origin/main too");
        // The transcript is never the report once the session is typed.
        expect(prompt).not.toContain("latest assistant text");
      },
      { toolMode: true, toolKinds: ["fix-result"] },
    );
  });

  test.each(["delivers", "ignores"] as const)(
    "a missing Address result gets one reminder and the stage %s it",
    async (outcome) => {
      await withPipeline(
        async ({ service, provider, read, workflowResults }) => {
          const started = await service.start(startInput());
          const addressing = await advanceUntil(service, read, started.id, "addressing");
          const address = current(addressing);
          const firstRequestId = address.structuredRequestId!;
          let reminded = addressing;
          for (let pass = 0; pass < 5 && !current(reminded).resultReminderSent; pass += 1) {
            await service.advanceNow(started.id);
            reminded = await read(started.id);
          }
          expect(reminded.phase).toBe("addressing");
          const remindedSession = current(reminded);
          expect(remindedSession).toMatchObject({
            sdkSessionId: address.sdkSessionId,
            resultReminderSent: true,
          });
          const reminder = provider.sent.at(-1)!;
          expect(reminder.sessionId).toBe(address.sdkSessionId);
          const remindedRequestId = remindedSession.structuredRequestId;
          if (!remindedRequestId) throw new Error("The reminder opened no result slot");
          expect(reminder.requestId).toBe(remindedRequestId);
          expect(reminder.prompt).toContain("has not received your fix result");
          expect(reminder.prompt).toContain("submit_fix_result");
          expect(await workflowResults!.status(scope, firstRequestId)).toMatchObject({
            lifecycle: "superseded",
          });

          if (outcome === "delivers") {
            await workflowResults!.submit(scope, reminder.requestId, TEST_FIX_RESULT);
            const verifying = await advanceUntil(service, read, started.id, "verifying");
            expect(verifying.phase).toBe("verifying");
            expect(
              verifying.sessions.find((session) => session.sdkSessionId === address.sdkSessionId)
                ?.fixResult,
            ).toEqual(TEST_FIX_RESULT);
            return;
          }
          const sentBefore = provider.sent.length;
          const failed = await advanceUntil(service, read, started.id, "failed", 5);
          expect(failed.phase).toBe("failed");
          expect(failed.error).toBe(
            "The address stage finished without returning its required structured result",
          );
          // The reminder was the stage's only one.
          expect(provider.sent).toHaveLength(sentBefore);
          expect(failed.sessions.some((session) => session.phase === "verify")).toBe(false);
        },
        { toolMode: true, toolKinds: ["fix-result"], structuredResultDeadlineMs: 0 },
      );
    },
  );

  test("a structured-output Address turn carries the schema and a malformed result fails it", async () => {
    await withPipeline(async ({ service, provider, read }) => {
      const started = await service.start(startInput());
      const addressing = await advanceUntil(service, read, started.id, "addressing");
      const address = current(addressing);
      expect(address).toMatchObject({
        addressReportKind: "fix-result",
        resultTransport: "structured-output-v1",
      });
      // The contract rejects a complete result that still reports a failure.
      const structured = provider.structured.bind(provider);
      provider.structured = async (sessionId, requestId) =>
        sessionId === address.sdkSessionId
          ? {
              ok: true,
              provider: "claude",
              requestId,
              value: { ...TEST_FIX_RESULT, limitations: ["Lint still fails."] } as never,
            }
          : structured(sessionId, requestId);
      const failed = await advanceUntil(service, read, started.id, "failed", 5);
      expect(failed.error).toContain("The address stage returned a malformed fix result");
      expect(current(failed).fixResult).toBeUndefined();
    });
  });
});

describe("Address sessions from before the typed report", () => {
  test("a pipeline record from before the upgrade still uses the last assistant text", async () => {
    await withPipeline(async ({ service, storage, provider, read }) => {
      const record = spyOn(compatibilityPathUsage, "record");
      try {
        const started = await service.start(startInput());
        const addressing = await advanceUntil(service, read, started.id, "addressing");
        const address = current(addressing);
        // A pre-upgrade Address session: no marker and no result slot.
        await rewritePipeline(storage, started.id, (pipeline) => {
          const session = current(pipeline);
          delete session.addressReportKind;
          delete session.structuredRequestId;
          delete session.resultTransport;
          delete session.resultSubmission;
          delete session.structuredResultStatus;
        });
        provider.transcriptOverrides.set(address.sdkSessionId, [
          {
            id: "address-final",
            role: "assistant",
            parts: [{ type: "text", content: "LEGACY ADDRESS REPORT: fixed the branch." }],
          },
        ]);
        // A pre-upgrade session never answers a fix-result read.
        const structured = provider.structured.bind(provider);
        const reads: string[] = [];
        provider.structured = async (sessionId, requestId) => {
          if (sessionId === address.sdkSessionId) reads.push(requestId);
          return structured(sessionId, requestId);
        };

        const verifying = await advanceUntil(service, read, started.id, "verifying");
        expect(verifying.phase).toBe("verifying");
        expect(reads).toEqual([]);
        const legacy = verifying.sessions.find(
          (session) => session.sdkSessionId === address.sdkSessionId,
        )!;
        expect(legacy.addressReportKind).toBeUndefined();
        expect(legacy.fixResult).toBeUndefined();
        const prompt = verifyPrompt(provider.sent)!;
        expect(prompt).toContain("the address stage's latest assistant text");
        expect(prompt).toContain("LEGACY ADDRESS REPORT: fixed the branch.");
        expect(prompt).not.toContain(ADDRESS_FIX_RESULT_FRAME_OPEN);
        expect(record).toHaveBeenCalledWith("build-pipeline.address-text-report");
      } finally {
        record.mockRestore();
      }
    });
  });

  test("a clean review goes to Verify with no Address report", async () => {
    await withPipeline(async ({ service, provider, read }) => {
      provider.consolidationFindings = "clean";
      const structured = provider.structured.bind(provider);
      provider.structured = async <T>(
        sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T> | null> => {
        const result = await structured<T>(sessionId, requestId);
        if (!result?.ok || !sessionId.includes("review")) return result;
        // Only an object report reaches here; the copy keeps its shape.
        return { ...result, value: { ...(result.value as object), issues: [] } as T };
      };
      const started = await service.start(startInput());
      const verifying = await advanceUntil(service, read, started.id, "verifying");
      expect(verifying.phase).toBe("verifying");
      expect(verifying.sessions.some((session) => session.phase === "address")).toBe(false);
      expect(verifyPrompt(provider.sent)).toContain("**Address report**: none.");
    });
  });

  test("resume asks for the fix result only from a typed Address session", () => {
    const typed = resumePromptFor("addressing", { addressResult: true })!;
    const legacy = resumePromptFor("addressing")!;
    expect(typed).toContain("finish with the required fix result");
    expect(legacy).not.toContain("fix result");
    expect(legacy).toContain("Resume addressing the review findings");
  });

  test("dispatch recovery re-prepares an Address slot with the fix-result schema", async () => {
    await withPipeline(
      async ({ service, read, workflowResults }) => {
        const prepare = spyOn(workflowResults!, "prepare");
        try {
          const started = await service.start(startInput());
          await advanceUntil(service, read, started.id, "addressing");
          const call = prepare.mock.calls.find(([input]) => input.kind === "fix-result");
          expect(call?.[0].schema).toEqual(REVIEW_FIX_RESULT_JSON_SCHEMA);
        } finally {
          prepare.mockRestore();
        }
      },
      { toolMode: true, toolKinds: ["fix-result"] },
    );
  });
});
