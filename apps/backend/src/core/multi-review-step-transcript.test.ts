import { describe, expect, mock, test } from "bun:test";
import {
  MULTI_REVIEW_STEP_TRANSCRIPT_MAX_BYTES,
  MULTI_REVIEW_STEP_TRANSCRIPT_MAX_MESSAGES,
  type MultiReviewSession,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  readMultiReviewStepTranscript,
  readMultiReviewStepToolDetails,
  type StepTranscriptHost,
} from "./multi-review-step-transcript.js";

import {
  bridgeTranscriptSummaryUpdate,
  readBridgeTranscriptDetail,
} from "@orkestrator/protocol/node/bridge-transcript-summary";

const STARTED = "2026-10-16T00:00:00.000Z";

function session(
  providerSessionId: string,
  agent: "codex" | "claude" = "codex",
): MultiReviewSession {
  return {
    agent,
    model: "gpt-6",
    sessionKey: `key-${providerSessionId}`,
    providerSessionId,
    requestIds: ["request-1"],
    status: "running",
    startedAt: STARTED,
  };
}

function workflow(overrides: Partial<MultiReviewWorkflow>): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "consolidating",
    reviewers: [],
    fixModel: { agent: "codex", model: "gpt-6" },
    reviewModel: { agent: "claude", model: "opus" },
    createdAt: STARTED,
    updatedAt: STARTED,
    backendRevision: 1,
    ...overrides,
  };
}

/** A provider whose snapshot surface answers `unchanged` for its current token. */
function snapshotProvider(messages: unknown[]) {
  const calls: Array<{
    sessionId: string;
    limit: number;
    targetBytes: number;
    knownSourceToken?: string;
  }> = [];
  let revision = 1;
  const provider = {
    agent: "codex",
    async messages() {
      throw new Error("the unbounded route must not be used");
    },
    async transcriptSnapshot(
      sessionId: string,
      options: { limit: number; targetBytes: number; knownSourceToken?: string },
    ) {
      calls.push({ sessionId, ...options });
      const token = `rev-${revision}`;
      if (options.knownSourceToken === token) {
        return { unchanged: true as const, sourceToken: token };
      }
      return { messages: messages.slice(-options.limit), sourceToken: token, complete: true };
    },
  };
  return {
    provider: provider as unknown as BuildPipelineProvider,
    calls,
    advance() {
      revision += 1;
    },
  };
}

function host(
  states: MultiReviewWorkflow[],
  provider: BuildPipelineProvider,
): StepTranscriptHost & { reads: string[] } {
  const reads: string[] = [];
  let load = 0;
  return {
    reads,
    async loadWorkflow() {
      const next = states[Math.min(load, states.length - 1)]!;
      load += 1;
      return next;
    },
    async withProvider(_workflow, target, read) {
      reads.push(target.providerSessionId);
      return read(provider);
    },
  };
}

const row = (index: number, text = `step ${index}`) => ({
  id: `m${index}`,
  role: "assistant",
  content: text,
  createdAt: STARTED,
  parts: [{ type: "text", content: text }],
});

describe("step transcript reads", () => {
  test("reads the step's own session within the count bound and echoes a session-scoped token", async () => {
    const target = workflow({ reviewSession: session("consolidation") });
    const messages = Array.from(
      { length: MULTI_REVIEW_STEP_TRANSCRIPT_MAX_MESSAGES + 20 },
      (_, i) => row(i),
    );
    const fake = snapshotProvider(messages);
    const answer = await readMultiReviewStepTranscript(
      host([target], fake.provider),
      "multi-1",
      "consolidate",
      undefined,
    );
    expect(fake.calls[0]).toMatchObject({
      sessionId: "consolidation",
      limit: MULTI_REVIEW_STEP_TRANSCRIPT_MAX_MESSAGES,
      targetBytes: MULTI_REVIEW_STEP_TRANSCRIPT_MAX_BYTES,
    });
    expect(answer).toMatchObject({
      step: "consolidate",
      session: "own",
      agent: "codex",
      transcript: "snapshot",
      sessionStatus: "running",
    });
    expect(answer.messages).toHaveLength(MULTI_REVIEW_STEP_TRANSCRIPT_MAX_MESSAGES);
    expect((answer.messages[0] as { id: string }).id).toBe("m20");
    expect(answer.sourceToken).toMatch(/^rt1\.[0-9a-f]{16}\.rev-1$/);
  });

  test("answers unchanged with no messages while the token is current", async () => {
    const target = workflow({ reviewSession: session("consolidation") });
    const fake = snapshotProvider([row(1)]);
    const first = await readMultiReviewStepTranscript(
      host([target], fake.provider),
      "multi-1",
      "consolidate",
      undefined,
    );
    const second = await readMultiReviewStepTranscript(
      host([target], fake.provider),
      "multi-1",
      "consolidate",
      first.sourceToken,
    );
    expect(fake.calls[1]?.knownSourceToken).toBe("rev-1");
    expect(second).toMatchObject({ transcript: "unchanged", messages: [] });
    expect(second.sourceToken).toBe(first.sourceToken);

    fake.advance();
    const third = await readMultiReviewStepTranscript(
      host([target], fake.provider),
      "multi-1",
      "consolidate",
      first.sourceToken,
    );
    expect(third.transcript).toBe("snapshot");
    expect(third.messages).toHaveLength(1);
  });

  test("never forwards a token minted for another session", async () => {
    const fake = snapshotProvider([row(1)]);
    const consolidation = await readMultiReviewStepTranscript(
      host([workflow({ reviewSession: session("consolidation") })], fake.provider),
      "multi-1",
      "consolidate",
      undefined,
    );
    await readMultiReviewStepTranscript(
      host([workflow({ phase: "fixing", fixSession: session("fix") })], fake.provider),
      "multi-1",
      "fix",
      consolidation.sourceToken,
    );
    expect(fake.calls[1]).toMatchObject({ sessionId: "fix" });
    expect(fake.calls[1]?.knownSourceToken).toBeUndefined();
  });

  test("keeps the tail inside the byte bound", async () => {
    const large = "x".repeat(40 * 1024);
    const fake = snapshotProvider(Array.from({ length: 20 }, (_, i) => row(i, large)));
    const answer = await readMultiReviewStepTranscript(
      host([workflow({ reviewSession: session("consolidation") })], fake.provider),
      "multi-1",
      "consolidate",
      undefined,
    );
    expect(Buffer.byteLength(JSON.stringify(answer.messages))).toBeLessThanOrEqual(
      MULTI_REVIEW_STEP_TRANSCRIPT_MAX_BYTES,
    );
    expect(answer.messages.length).toBeLessThan(20);
    expect(answer.truncated).toBe(true);
  });

  test("does not read a step that has no session yet", async () => {
    const fake = snapshotProvider([row(1)]);
    const reader = host([workflow({ phase: "reviewing" })], fake.provider);
    const answer = await readMultiReviewStepTranscript(reader, "multi-1", "fix", undefined);
    expect(answer).toMatchObject({ session: "none", messages: [], transcript: "snapshot" });
    expect(reader.reads).toEqual([]);
  });

  test("reads a shared session only for the step using it now", async () => {
    // Without a separate preparation model every step ran in the fix session.
    const shared = session("shared");
    const legacy = (phase: MultiReviewWorkflow["phase"]) =>
      workflow({
        phase,
        reviewModel: undefined,
        fixSession: shared,
        ...(phase === "fixing"
          ? {
              activeRequest: {
                kind: "fix" as const,
                requestId: "fix-1",
                state: "sent" as const,
                createdAt: STARTED,
              },
            }
          : {}),
      });
    const fake = snapshotProvider([row(1, "fixing the findings")]);

    const consolidating = host([legacy("consolidating")], fake.provider);
    const fix = await readMultiReviewStepTranscript(consolidating, "multi-1", "fix", undefined);
    expect(fix).toMatchObject({ session: "other-step", sessionStep: "consolidate", messages: [] });
    expect(fix.sourceToken).toBeUndefined();
    expect(consolidating.reads).toEqual([]);

    const fixing = host([legacy("fixing")], fake.provider);
    const consolidation = await readMultiReviewStepTranscript(
      fixing,
      "multi-1",
      "consolidate",
      undefined,
    );
    expect(consolidation).toMatchObject({ session: "other-step", sessionStep: "fix" });
    expect(fixing.reads).toEqual([]);
    const fixTail = await readMultiReviewStepTranscript(fixing, "multi-1", "fix", undefined);
    expect(fixTail).toMatchObject({ session: "own", messages: [row(1, "fixing the findings")] });
    expect(fixing.reads).toEqual(["shared"]);
  });

  test("drops an answer whose session was replaced or handed on while it was read", async () => {
    const fake = snapshotProvider([row(1)]);
    const restarted = host(
      [
        workflow({ reviewSession: session("consolidation") }),
        workflow({ reviewSession: session("consolidation-restarted") }),
      ],
      fake.provider,
    );
    const answer = await readMultiReviewStepTranscript(
      restarted,
      "multi-1",
      "consolidate",
      undefined,
    );
    expect(restarted.reads).toEqual(["consolidation"]);
    expect(answer).toMatchObject({ session: "own", messages: [], transcript: "snapshot" });
    expect(answer.sourceToken).toBeUndefined();
  });
});

describe("step deferred tool details", () => {
  const output = "Deferred step Bash output\n".repeat(400);
  const messages = [
    {
      ...row(1),
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: { command: "pwd" },
          toolOutput: output,
        },
      ],
    },
  ];
  function provider() {
    const transcriptDetail = mock(async (_sessionId: string, ref: string) =>
      readBridgeTranscriptDetail(messages, ref),
    );
    const transcriptSnapshot = mock(
      async (_sessionId: string, options: { representation?: string }) => {
        expect(options.representation).toBe("summary");
        const update = bridgeTranscriptSummaryUpdate(messages, {
          sessionIdentity: "step-session",
          generation: "g",
          contentEpoch: 1,
          revision: 1,
          limit: 100,
          targetBytes: 256 * 1024,
          complete: true,
        });
        if (update.status !== "snapshot") throw new Error("Expected summary snapshot");
        return {
          messages: update.value.messages,
          sourceToken: update.token,
          complete: true,
          representation: "summary",
        };
      },
    );
    return {
      provider: {
        agent: "codex",
        transcriptDetail,
        transcriptSnapshot,
      } as unknown as BuildPipelineProvider,
      transcriptDetail,
      transcriptSnapshot,
    };
  }

  for (const step of ["prepare", "consolidate", "fix"] as const) {
    test(`${step} resolves a summary-only row against the workflow's owned session`, async () => {
      const fake = provider();
      const target = workflow({
        phase: step === "prepare" ? "preparing" : step === "fix" ? "fixing" : "consolidating",
        preparationSession: session("prepare-session"),
        reviewSession: session("consolidate-session"),
        fixSession: session("fix-session"),
      });
      const reader = host([target], fake.provider);
      const loadWorkflow = mock(reader.loadWorkflow);
      const scoped = { ...reader, loadWorkflow };
      const tail = await readMultiReviewStepTranscript(scoped, "workflow-scope", step, undefined);
      const part = (
        tail.messages[0] as { parts: Array<{ detailRef: string; toolOutput?: string }> }
      ).parts[0]!;
      expect(part.toolOutput).toBeUndefined();
      expect(part.detailRef).toStartWith("bd1.");
      await expect(
        readMultiReviewStepToolDetails(scoped, "workflow-scope", step, part.detailRef),
      ).resolves.toMatchObject({ toolOutput: output });
      expect(loadWorkflow).toHaveBeenLastCalledWith("workflow-scope");
      expect(fake.transcriptDetail).toHaveBeenCalledWith(`${step}-session`, part.detailRef);

      const broken = {
        ...fake.provider,
        transcriptDetail: async () => {
          throw new Error("provider unavailable");
        },
      } as BuildPipelineProvider;
      await expect(
        readMultiReviewStepToolDetails(
          host([target], broken),
          "workflow-scope",
          step,
          part.detailRef,
        ),
      ).rejects.toThrow("provider unavailable");
      await expect(
        readMultiReviewStepToolDetails(scoped, "workflow-scope", step, "forged-reference"),
      ).rejects.toThrow("reference is invalid");

      const replacement = {
        ...target,
        preparationSession: session("new-prepare"),
        reviewSession: session("new-consolidate"),
        fixSession: session("new-fix"),
      };
      await expect(
        readMultiReviewStepToolDetails(
          host([target, replacement], fake.provider),
          "workflow-scope",
          step,
          part.detailRef,
        ),
      ).rejects.toThrow("no longer available");
    });
  }

  test("refuses details before and after a shared session handoff", async () => {
    const fake = provider();
    const shared = session("shared");
    const before = workflow({ reviewModel: undefined, fixSession: shared });
    const after = workflow({
      reviewModel: undefined,
      fixSession: shared,
      phase: "fixing",
      activeRequest: { kind: "fix", requestId: "fix-1", state: "sent", createdAt: STARTED },
    });
    const tail = await readMultiReviewStepTranscript(
      host([before], fake.provider),
      "multi-1",
      "consolidate",
      undefined,
    );
    const ref = (tail.messages[0] as { parts: Array<{ detailRef: string }> }).parts[0]!.detailRef;
    await expect(
      readMultiReviewStepToolDetails(host([after], fake.provider), "multi-1", "consolidate", ref),
    ).rejects.toThrow("no longer available");
    expect(fake.transcriptDetail).not.toHaveBeenCalled();
    await expect(
      readMultiReviewStepToolDetails(
        host([before, after], fake.provider),
        "multi-1",
        "consolidate",
        ref,
      ),
    ).rejects.toThrow("no longer available");
    expect(fake.transcriptDetail).toHaveBeenCalledTimes(1);
    await expect(
      readMultiReviewStepToolDetails(
        host([workflow({})], fake.provider),
        "multi-1",
        "prepare",
        ref,
      ),
    ).rejects.toThrow("no longer available");
  });
});
