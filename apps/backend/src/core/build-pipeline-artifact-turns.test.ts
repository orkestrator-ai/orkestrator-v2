/**
 * Transcript-artifact authority for build-pipeline stage turns: every turn
 * that carries a tool-mode connection gets an artifact grant owned by that
 * stage session's own key, and the grant ends with the turn.
 */
import { describe, expect, test } from "bun:test";
import {
  advanceUntil,
  fourReviewers,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";
import type { ArtifactTurnDispatch } from "./workflow-artifact-turns.js";

describe("build-pipeline stage turns' artifact authority", () => {
  test("a tool-mode stage turn publishes as its own stage session, until the turn ends", async () => {
    const begun: Array<Parameters<ArtifactTurnDispatch["beginTurn"]>[0]> = [];
    const settled: Array<[string, string, string]> = [];
    const artifactDispatch: ArtifactTurnDispatch = {
      beginTurn(input) {
        begun.push(input);
        return { grant: `oag1.grant-${input.turnId}` };
      },
      settleTurn(environmentId, conversationKey, turnId) {
        settled.push([environmentId, conversationKey, turnId]);
      },
      toolsEnabled: () => true,
    };
    await withPipeline(
      async ({ service, read, provider }) => {
        const started = await service.start(startInput(fourReviewers()));
        // The consolidation runs in tool mode and never submits, so after its
        // one result reminder the pipeline fails with both turns ended.
        const failed = await advanceUntil(service, read, started.id, "failed", 40);
        const consolidation = failed.sessions.find((session) => session.label === "Consolidation");
        expect(consolidation).toBeDefined();
        expect(failed.reviewFanout?.consolidation?.resultReminderSent).toBe(true);
        const requestIds = provider.sent
          .filter((entry) => entry.sessionId === consolidation!.sdkSessionId)
          .map((entry) => entry.requestId);
        expect(requestIds).toHaveLength(2);
        expect(requestIds.at(-1)).toBe(failed.reviewFanout?.consolidation?.requestId);

        expect(begun).toEqual(
          requestIds.map((requestId) => ({
            environmentId: "env-1",
            projectId: "project-1",
            conversationKey: consolidation!.sessionKey,
            turnId: requestId,
            providerSessionId: consolidation!.sdkSessionId,
            needsGrant: true,
          })),
        );
        for (const requestId of requestIds) {
          const sent = provider.sent.find((entry) => entry.requestId === requestId);
          expect(sent?.agentMcp).toEqual({
            url: "http://127.0.0.1:1234/mcp",
            token: "test-token",
            artifacts: { token: `oag1.grant-${requestId}` },
          });
          expect(settled).toContainEqual(["env-1", consolidation!.sessionKey, requestId]);
        }
        // Structured-output reviewers had no tool-mode connection to carry one.
        expect(
          provider.sent.filter((entry) => !requestIds.includes(entry.requestId) && entry.agentMcp),
        ).toEqual([]);
      },
      { toolMode: true, artifactDispatch },
    );
  });

  test("a single-reviewer review stage turn publishes as its own stage session", async () => {
    const begun: Array<Parameters<ArtifactTurnDispatch["beginTurn"]>[0]> = [];
    const artifactDispatch: ArtifactTurnDispatch = {
      beginTurn(input) {
        begun.push(input);
        return { grant: `oag1.grant-${input.turnId}` };
      },
      settleTurn() {},
    };
    await withPipeline(
      async ({ service, read, provider }) => {
        const started = await service.start(startInput());
        const reviewing = await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        const current = await read(started.id);
        const tooled = provider.sent.filter((entry) => entry.agentMcp);
        // The classic review stage is a supervisor stage turn in tool mode.
        expect(reviewing.phase).toBe("reviewing");
        expect(tooled).toHaveLength(1);
        const stage = current.sessions.find(
          (candidate) => candidate.sdkSessionId === tooled[0]!.sessionId,
        );
        expect(stage?.phase).toBe("review");
        expect(begun).toEqual([
          {
            environmentId: "env-1",
            projectId: "project-1",
            conversationKey: stage!.sessionKey,
            turnId: tooled[0]!.requestId,
            providerSessionId: stage!.sdkSessionId,
            needsGrant: true,
          },
        ]);
        expect(tooled[0]!.agentMcp?.artifacts).toEqual({
          token: `oag1.grant-${tooled[0]!.requestId}`,
        });
      },
      { toolMode: true, toolKinds: ["review-report"], artifactDispatch },
    );
  });
});
