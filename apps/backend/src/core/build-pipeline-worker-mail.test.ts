/**
 * The supervisor's turn-end step for worker mail, through the real
 * `BuildPipelineService`: mail queued for the running worker becomes that
 * worker's next turn before the stage advances, journaled like any prompt.
 */
import { describe, expect, test } from "bun:test";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import {
  pipeline,
  mutateStored,
  startBuilding,
  withService,
} from "./build-pipeline-service-test-support.js";
import { authenticatePipelineWorkerMailCapability } from "./pipeline-worker-identity.js";

describe("worker mail at a pipeline worker's turn end", () => {
  test("is the worker's next turn, and the stage advances only after it", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      const carrier = "<orkestrator-peer-message>Also add docs.</orkestrator-peer-message>";
      const queue = [carrier];
      const claims: string[] = [];
      const settled: Array<{ tabId: string; ids: readonly string[]; outcome: string }> = [];
      service.setWorkerMailbox({
        claim: async (_environmentId, tabId) => {
          claims.push(tabId);
          const text = queue.shift();
          return text ? { text, messageIds: ["mail-1"] } : null;
        },
        settle: async (_environmentId, tabId, ids, outcome) => {
          settled.push({ tabId, ids, outcome });
        },
      });

      // Mid-turn: the worker's mail waits.
      provider.runningPhases.add("build");
      await service.advanceNow(started.id);
      expect(claims).toEqual([]);

      // The turn ends: the queued mail is the build's next turn.
      provider.runningPhases.delete("build");
      const before = provider.sent.length;
      await service.advanceNow(started.id);
      expect(claims).toEqual([pipelineWorkerTabId(session.sessionKey)]);
      expect(provider.sent.slice(before).map((entry) => entry.prompt)).toEqual([carrier]);
      expect(provider.sent.at(-1)!.sessionId).toBe(session.sdkSessionId);
      expect(settled).toEqual([
        { tabId: pipelineWorkerTabId(session.sessionKey), ids: ["mail-1"], outcome: "accepted" },
      ]);
      const delivering = await pipeline(storage, started.id);
      expect(delivering.phase).toBe("building");
      const build = delivering.sessions.find((item) => item.sessionKey === session.sessionKey)!;
      expect(build.mailDeliveries).toEqual([provider.sent.at(-1)!.requestId]);

      // That turn ends with nothing more queued: the pipeline moves on.
      await service.advanceNow(started.id);
      expect(claims).toHaveLength(2);
      // The build's own next step (its package preparation turn), not mail.
      expect(provider.sent.length).toBe(before + 2);
      expect(provider.sent.at(-1)!.prompt).not.toBe(carrier);
    });
  });
});

describe("a stage turn without a workflow-result capability", () => {
  const workerConnection = (tabId: string | undefined) => ({
    url: "http://127.0.0.1:1234/mcp",
    token: `worker:${tabId}`,
  });

  test("a bridge agent's turn connects as its own worker mailbox", async () => {
    const requested: Array<string | undefined> = [];
    await withService(
      async (service, storage, provider) => {
        const { session } = await startBuilding(service, storage);
        const worker = pipelineWorkerTabId(session.sessionKey);
        expect(requested).toContain(worker);
        const turn = provider.sent.find((entry) => entry.sessionId === session.sdkSessionId)!;
        expect(turn.agentMcp).toEqual(workerConnection(worker));
        expect(turn.workerMail).toBeUndefined();
      },
      {
        workflowResultsWithoutTools: true,
        resolveWorkerToolConnection: (_environmentId, _projectId, _target, tabId) => {
          requested.push(tabId);
          return workerConnection(tabId);
        },
      },
    );
  });

  test("an OpenCode turn carries its worker's signed mail capability", async () => {
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        await controls.workflowResults!.initializeCapabilityIdentity();
        const { started, session } = await startBuilding(service, storage, {
          agentType: "opencode",
        });
        const worker = pipelineWorkerTabId(session.sessionKey);
        const turn = provider.sent.find((entry) => entry.sessionId === session.sdkSessionId)!;
        // OpenCode keeps its environment-wide connection; no per-turn one.
        expect(turn.agentMcp).toBeUndefined();
        expect(turn.workerMail).toMatchObject({
          environmentId: started.environmentId,
          tabId: worker,
        });
        expect(
          authenticatePipelineWorkerMailCapability(
            controls.workflowResults!,
            turn.workerMail!.capability,
          ),
        ).toEqual({ environmentId: started.environmentId, projectId: "project-1", tabId: worker });
      },
      {
        workflowResultsWithoutTools: true,
        resolveWorkerToolConnection: (_environmentId, _projectId, _target, tabId) =>
          workerConnection(tabId),
      },
    );
  });
});

import { REVIEW_VALIDATION_PLAN_SCHEMA } from "./review-validation-prompts.js";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";

test("preparation mail retains its validation plan and commands run before review", async () => {
  await withService(async (service, storage, provider, invocations, controls) => {
    const { started } = await startBuilding(service, storage);
    await service.retryReview(started.id);
    const preparing = await pipeline(storage, started.id);
    const session = preparing.sessions.at(-1)!;
    expect(preparing.activePromptContext?.validationPlan).toBe(true);
    let queued = true;
    service.setWorkerMailbox({
      claim: async () => {
        if (!queued) return null;
        queued = false;
        return { text: "Include the targeted check.", messageIds: ["prep-mail"] };
      },
      settle: async () => {},
    });
    provider.structured = async <T>(_id: string, requestId: string) => ({
      ok: true,
      provider: "claude",
      requestId,
      value: {
        headRef: controls.currentHead,
        commands: [
          {
            id: "targeted",
            command: "bun test ./target.test.ts",
            cwd: ".",
            dependsOn: [],
            resources: [],
            weight: 1,
            timeoutMs: 60000,
          },
        ],
        limitations: [],
      } as T,
    });
    await service.advanceNow(started.id);
    expect(provider.sent.at(-1)?.schema).toEqual(REVIEW_VALIDATION_PLAN_SCHEMA);
    const followUp = await pipeline(storage, started.id);
    expect(followUp.activePromptContext?.validationPlan).toBe(true);
    expect(followUp.sessions.at(-1)?.validationPlan).toBe(true);
    await service.advanceNow(started.id);
    expect((await pipeline(storage, started.id)).validationRun?.plan.commands[0]?.id).toBe(
      "targeted",
    );
    await service.advanceNow(started.id);
    expect(invocations.some((entry) => entry.command === "start_review_validation")).toBe(true);
    expect((await pipeline(storage, started.id)).phase).not.toBe("reviewing");
    expect(session.producedReviewPackagePlan).toBe(true);
  });
});

test("command validation advances without a provider when no worker mail is queued", async () => {
  let unavailable = false;
  await withService(
    async (service, storage, _provider, invocations) => {
      const { started } = await startBuilding(service, storage);
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.validationRun = newReviewValidationRun("command-only", {
          headRef: "1".repeat(40),
          commands: [],
          limitations: ["No commands configured."],
        });
      });
      service.setWorkerMailbox({ claim: async () => null, settle: async () => {} });
      unavailable = true;
      await service.advanceNow(started.id);
      expect(invocations.some((entry) => entry.command === "start_review_validation")).toBe(true);
      expect((await pipeline(storage, started.id)).error).toBeUndefined();
    },
    {
      beforeProvider: () => {
        if (unavailable) throw new Error("bridge unavailable");
      },
    },
  );
});

test("preparation mail renews a validation-plan tool slot", async () => {
  await withService(
    async (service, storage, _provider, _invocations, controls) => {
      const { started } = await startBuilding(service, storage);
      await service.retryReview(started.id);
      const before = await pipeline(storage, started.id);
      const oldKey = before.sessions.at(-1)!.structuredRequestId!;
      let queued = true;
      service.setWorkerMailbox({
        claim: async () => {
          if (!queued) return null;
          queued = false;
          return { text: "Clarify the validation plan.", messageIds: ["tool-prep-mail"] };
        },
        settle: async () => {},
      });
      await service.advanceNow(started.id);
      const after = await pipeline(storage, started.id);
      const key = after.sessions.at(-1)!.structuredRequestId!;
      expect(key).not.toBe(oldKey);
      const scope = { environmentId: "env-1", projectId: "project-1" };
      expect(await controls.workflowResults!.binding(scope, key)).toMatchObject({
        kind: "validation-plan",
      });
      expect(
        await controls.workflowResults!.submit(scope, key, {
          headRef: controls.currentHead,
          commands: [],
          limitations: ["No checks configured."],
        }),
      ).toMatchObject({ ok: true });
      await service.advanceNow(started.id);
      expect((await pipeline(storage, started.id)).validationRun?.status).toBe("planned");
    },
    { toolMode: true },
  );
});
