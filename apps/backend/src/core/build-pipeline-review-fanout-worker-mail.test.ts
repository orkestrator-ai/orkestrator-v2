/**
 * Every review worker carries its own mail identity on a turn without a
 * workflow-result capability: each parallel reviewer and the consolidation
 * session get a connection scoped to their own mailbox, and an OpenCode
 * reviewer, whose connection is environment-wide, its signed capability.
 */
import { describe, expect, test } from "bun:test";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { authenticatePipelineWorkerMailCapability } from "./pipeline-worker-identity.js";
import {
  advanceUntil,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

describe("review workers' mail identity", () => {
  test("each reviewer and the consolidation act as their own mailbox", async () => {
    await withPipeline(
      async ({ service, read, providers, workflowResults }) => {
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
            { agent: "opencode", model: "provider/model" },
          ]),
        );
        const addressing = await advanceUntil(service, read, started.id, "addressing");
        expect(addressing.error ?? addressing.phase).toBe("addressing");

        const reviewSessions = addressing.sessions.filter((session) => session.phase === "review");
        // Three reviewers and the consolidation, each its own worker.
        expect(new Set(reviewSessions.map((session) => session.sessionKey)).size).toBe(4);
        const sent = [...providers.values()].flatMap((provider) => provider.sent);
        for (const session of reviewSessions) {
          const tabId = pipelineWorkerTabId(session.sessionKey);
          const turns = sent.filter((entry) => entry.sessionId === session.sdkSessionId);
          expect(turns.length).toBeGreaterThan(0);
          for (const turn of turns) {
            if (session.agent === "opencode") {
              expect(turn.agentMcp).toBeUndefined();
              expect(turn.workerMail).toMatchObject({ environmentId: "env-1", tabId });
              expect(
                authenticatePipelineWorkerMailCapability(
                  workflowResults!,
                  turn.workerMail!.capability,
                ),
              ).toMatchObject({ environmentId: "env-1", tabId });
            } else {
              expect(turn.agentMcp?.token).toBe(`worker:${tabId}`);
              expect(turn.workerMail).toBeUndefined();
            }
          }
        }
      },
      { workerMail: true },
    );
  });
});
