import { describe, expect, spyOn, test } from "bun:test";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { advanceUntil, startInput, withPipeline } from "./review-fanout-test-support.js";

describe("build pipeline long checks", () => {
  test("Verify is held while its long check runs and gets the result as a new turn", async () => {
    await withPipeline(
      async ({ service, provider, read, commands, disputeReruns }) => {
        const started = await service.start(startInput());
        const verifying = await advanceUntil(service, read, started.id, "verifying");
        expect(verifying.phase).toBe("verifying");
        const session = verifying.sessions[verifying.currentSessionIndex]!;
        const firstRequestId = session.structuredRequestId;

        // The Verify turn is still running when it hands the check over.
        const observe = spyOn(provider, "observeSession").mockImplementation(async () => ({
          status: "running",
        }));
        const host = service.longCheckHost();
        const summary = await host.start(
          {
            environmentId: "env-1",
            projectId: "project-1",
            tabId: pipelineWorkerTabId(session.sessionKey),
          },
          {
            name: "corpus parity",
            criterion: "The parity run finishes",
            commands: [
              { command: "bun test tests/parity-changed.test.ts", scope: "changed" },
              { command: "bun run parity:full", timeoutMinutes: 45 },
            ],
          },
        );
        expect(summary.status).toBe("running");

        // The turn ends; the fake worker has not finished the run. Verify
        // has a verdict ready, but the stage does not take it.
        observe.mockRestore();
        const sentBefore = provider.sent.length;
        for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);
        const held = await read(started.id);
        expect(held.phase).toBe("verifying");
        expect(held.verificationResult).toBeUndefined();
        expect(held.longChecks![0]).toMatchObject({ status: "running" });
        expect(provider.sent).toHaveLength(sentBefore);

        // The worker finishes. The next pass settles it, writes it on the
        // ticket and sends the stage its result under a new result key.
        disputeReruns.outcome = "passed";
        await service.advanceNow(started.id);
        const delivered = await read(started.id);
        const check = delivered.longChecks![0]!;
        expect(check).toMatchObject({ status: "passed", ticketComment: "posted" });
        expect(check.deliveredAt).toBeDefined();
        expect(commands).toContain("add_kanban_comment");
        expect(provider.sent).toHaveLength(sentBefore + 1);
        const followUp = provider.sent.at(-1)!;
        expect(followUp.sessionId).toBe(session.sdkSessionId);
        expect(followUp.prompt).toContain("**Long check results**");
        expect(followUp.prompt).toContain("“corpus parity”: passed");
        expect(followUp.prompt).toContain(
          "`bun test tests/parity-changed.test.ts` (changed), passed",
        );
        const current = delivered.sessions[delivered.currentSessionIndex]!;
        expect(current.sdkSessionId).toBe(session.sdkSessionId);
        expect(current.structuredRequestId).not.toBe(firstRequestId);

        // With the result delivered, the stage finishes as usual.
        const after = await advanceUntil(service, read, started.id, "creating-pr", 10);
        expect(after.verificationResult).toBe("pass");
        expect(after.longChecks![0]!.deliveredAt).toBe(check.deliveredAt);
        expect(
          provider.sent.filter((entry) => entry.prompt.includes("**Long check results**")),
        ).toHaveLength(1);
      },
      { longCheckPollMs: 0 },
    );
  });

  test("Verify's prompt tells it to hand slow checks to the pipeline", async () => {
    await withPipeline(async ({ service, provider, read }) => {
      const started = await service.start(startInput());
      await advanceUntil(service, read, started.id, "verifying");
      const verify = provider.sent.find((entry) =>
        entry.prompt.includes("Verify the committed branch"),
      );
      expect(verify?.prompt).toContain("`start_long_check`");
      expect(verify?.prompt).toContain("without polling");
    });
  });

  test("cancelling the pipeline cancels its running long check", async () => {
    await withPipeline(
      async ({ service, provider, read, commands }) => {
        const started = await service.start(startInput());
        const verifying = await advanceUntil(service, read, started.id, "verifying");
        const session = verifying.sessions[verifying.currentSessionIndex]!;
        spyOn(provider, "observeSession").mockImplementation(async () => ({ status: "running" }));
        await service.longCheckHost().start(
          {
            environmentId: "env-1",
            projectId: "project-1",
            tabId: pipelineWorkerTabId(session.sessionKey),
          },
          { name: "browser suite", commands: [{ command: "bun run test:browser" }] },
        );
        await service.cancel(started.id);
        expect(commands).toContain("cancel_review_validation");
        const cancelled = await read(started.id);
        expect(cancelled.longChecks![0]!.status).not.toBe("running");
      },
      { longCheckPollMs: 0 },
    );
  });
});
