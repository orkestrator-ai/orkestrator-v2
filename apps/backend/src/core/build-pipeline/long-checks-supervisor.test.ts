import { describe, expect, spyOn, test } from "bun:test";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { taskSnapshotCriteria } from "@orkestrator/protocol/build-pipeline";
import { AgentToolsServer } from "../agent-tools.js";
import { graphWorkspaceAllows } from "../graph-run-scheduling.js";
import { WorkspaceWriters } from "../workspace-writers.js";
import { advanceUntil, startInput, withPipeline } from "./review-fanout-test-support.js";

describe("build pipeline long checks", () => {
  test("Verify is held while its long check runs and gets the result as a new turn", async () => {
    await withPipeline(
      async ({ service, provider, read, commands, disputeReruns }) => {
        const started = await service.start({ ...startInput(), environmentType: "containerized" });
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
      { longCheckPollMs: 0, environmentType: "containerized" },
    );
  });

  test("a paused check keeps the workspace until settlement and its old attempt cannot deliver to a replacement", async () => {
    await withPipeline(
      async ({ service, provider, storage, read, worktree, disputeReruns }) => {
        const started = await service.start({ ...startInput(), environmentType: "containerized" });
        const verifying = await advanceUntil(service, read, started.id, "verifying");
        const session = verifying.sessions[verifying.currentSessionIndex]!;
        const observe = spyOn(provider, "observeSession").mockResolvedValue({ status: "running" });
        await service.longCheckHost().start(
          {
            environmentId: "env-1",
            projectId: "project-1",
            tabId: pipelineWorkerTabId(session.sessionKey),
          },
          { name: "old checkout", commands: [{ command: "true" }] },
        );
        observe.mockRestore();
        await service.pause(started.id);
        await expect(service.restartCurrentStep(started.id)).rejects.toThrow(
          "detached long check to settle",
        );
        const writers = new WorkspaceWriters(storage);
        try {
          await writers.ready();
          expect(graphWorkspaceAllows(writers.externalHold("env-1")!, "write")).toBe(false);
          disputeReruns.outcome = "passed";
          await service.advanceNow(started.id);
          const paused = await read(started.id);
          expect(paused.phase).toBe("paused");
          expect(paused.longChecks?.[0]).toMatchObject({
            status: "passed",
            ticketComment: "posted",
          });
          writers.notePipeline(started.id, paused, paused.backendRevision);
          expect(graphWorkspaceAllows(writers.externalHold("env-1")!, "write")).toBe(true);
        } finally {
          writers.dispose();
        }
        worktree.head = "9".repeat(40);
        await service.restartCurrentStep(started.id);
        const replacement = await advanceUntil(service, read, started.id, "verifying");
        expect(replacement.sessions[replacement.currentSessionIndex]?.sessionKey).not.toBe(
          session.sessionKey,
        );
        await advanceUntil(service, read, started.id, "creating-pr");
        expect(provider.sent.some(({ prompt }) => prompt.includes("**Long check results**"))).toBe(
          false,
        );
      },
      { longCheckPollMs: 0, environmentType: "containerized" },
    );
  });

  test("a newly submitted passing verdict cannot ship incomplete criterion evidence", async () => {
    await withPipeline(
      async ({ service, provider, read, disputeReruns }) => {
        const started = await service.start({ ...startInput(), environmentType: "containerized" });
        const verifying = await advanceUntil(service, read, started.id, "verifying");
        const session = verifying.sessions[verifying.currentSessionIndex]!;
        const criterion = taskSnapshotCriteria(verifying.taskSnapshot)[0]!;
        const observe = spyOn(provider, "observeSession").mockResolvedValue({ status: "running" });
        await service.longCheckHost().start(
          {
            environmentId: "env-1",
            projectId: "project-1",
            tabId: pipelineWorkerTabId(session.sessionKey),
          },
          { name: "parity", criterion: criterion.id, commands: [{ command: "true" }] },
        );
        observe.mockRestore();
        disputeReruns.outcome = "incomplete";
        await service.advanceNow(started.id);
        const delivered = await read(started.id);
        const followUp = delivered.sessions[delivered.currentSessionIndex]!;
        expect(followUp.structuredRequestId).not.toBe(session.structuredRequestId);
        expect(delivered.longChecks?.[0]?.status).toBe("incomplete");
        spyOn(provider, "structured").mockImplementation(async (_sessionId, requestId) => ({
          ok: true,
          provider: "claude",
          requestId,
          value: {
            complete: true,
            rationale: "Passed",
            acceptanceCriteria: [
              { id: criterion.id, status: "passed", evidence: "Parities matched" },
            ],
          } as never,
        }));
        await service.advanceNow(started.id);
        const settled = await read(started.id);
        const original = settled.sessions.find(
          ({ sessionKey }) => sessionKey === session.sessionKey,
        );
        expect(settled.verificationResult).toBe("fail");
        expect(original?.acceptanceCriteriaResults).toEqual([
          {
            id: criterion.id,
            status: "not-checked",
            evidence: expect.stringContaining("incomplete"),
          },
        ]);
        expect(settled.phase).not.toBe("creating-pr");
      },
      { longCheckPollMs: 0, environmentType: "containerized" },
    );
  });

  test("an authenticated managed local Codex stage cannot start a detached shell", async () => {
    await withPipeline(async ({ service, storage, read, commands }) => {
      await storage.updateEnvironment("env-1", {
        agentSettings: {
          executionPolicy: { sandbox: "provider", networkAccess: "restricted", approvals: "deny" },
        },
      });
      const started = await service.start({ ...startInput(), agentType: "codex" });
      const verifying = await advanceUntil(service, read, started.id, "verifying");
      const session = verifying.sessions[verifying.currentSessionIndex]!;
      const server = new AgentToolsServer(storage, "127.0.0.1");
      server.setLongCheckToolHost(service.longCheckHost());
      await server.start();
      try {
        const { url, token } = server.connection(
          "env-1",
          "project-1",
          "host",
          pipelineWorkerTabId(session.sessionKey),
        );
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "start_long_check",
              arguments: { name: "safe probe", commands: [{ command: "true" }] },
            },
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Detached long checks require a container");
        expect((await read(started.id)).longChecks ?? []).toHaveLength(0);
        expect(commands).not.toContain("start_review_validation");
      } finally {
        await server.stop();
      }
    });
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
        const started = await service.start({ ...startInput(), environmentType: "containerized" });
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
      { longCheckPollMs: 0, environmentType: "containerized" },
    );
  });
});
