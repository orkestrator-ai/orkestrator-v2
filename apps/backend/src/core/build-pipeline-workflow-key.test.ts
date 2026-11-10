import { expect, test } from "bun:test";
import { AmbiguousPromptDispatchError } from "./build-pipeline-provider.js";
import {
  advanceUntil,
  reportFor,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

test.each([false, true])("read-only Review result key survives recovery=%s", async (recover) => {
  await withPipeline(
    async ({ service, provider, read, workflowResults }) => {
      const send = provider.send.bind(provider);
      let heldKey: string | undefined;
      provider.send = async (sessionId, prompt, options) => {
        if (recover && options.workflowResultTool === "submit_review_report" && !heldKey) {
          heldKey = options.requestId;
          // No provider admission: its complete journal will prove absence.
          throw new AmbiguousPromptDispatchError("acknowledgement lost");
        }
        await send(sessionId, prompt, options);
      };
      const started = await service.start(startInput());
      let reviewing = await advanceUntil(service, read, started.id, "reviewing");
      const reviewer = reviewing.sessions.find((session) => session.phase === "review")!;
      const requestId = reviewer.structuredRequestId!;
      expect(requestId).toBeTruthy();
      if (recover) {
        expect(heldKey).toBe(requestId);
        expect(reviewing.pendingPromptAttempt?.requestId).toBe(requestId);
        expect(provider.sent.some((entry) => entry.requestId === requestId)).toBe(false);
        expect(await provider.dispatchStatus(reviewer.sdkSessionId, requestId)).toBe("absent");
        await service.advanceNow(started.id);
        reviewing = await read(started.id);
        expect(reviewing.pendingPromptAttempt).toBeUndefined();
      }
      const dispatches = provider.sent.filter((entry) => entry.requestId === requestId);
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({
        sessionId: reviewer.sdkSessionId,
        mode: "plan",
        readOnly: true,
        workflowResultTool: "submit_review_report",
        workflowResultKey: requestId,
      });
      expect(dispatches[0]?.prompt).toContain(requestId);
      expect(dispatches[0]?.agentMcp).toBeDefined();
      expect(
        await workflowResults!.submit(
          { environmentId: "env-1", projectId: "project-1" },
          requestId,
          reportFor("Review accepted"),
        ),
      ).toMatchObject({ ok: true });
      const verifying = await advanceUntil(service, read, started.id, "verifying");
      expect(verifying.phase).toBe("verifying");
      expect(
        verifying.sessions.find((session) => session.sdkSessionId === reviewer.sdkSessionId),
      ).toMatchObject({ structuredResultStatus: "accepted" });
    },
    { toolMode: true, toolKinds: ["review-report"] },
  );
});
