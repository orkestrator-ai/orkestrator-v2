/**
 * The supervisor's turn-end step for worker mail, through the real
 * `BuildPipelineService`: mail queued for the running worker becomes that
 * worker's next turn before the stage advances, journaled like any prompt.
 */
import { describe, expect, test } from "bun:test";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { pipeline, startBuilding, withService } from "./build-pipeline-service-test-support.js";

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
