/**
 * The CLI `review` commands and the review-pass tab's read paths on a
 * graph-engine Multi Review (item 301): `review.launch/get/list/cancel` run
 * the public actions over the real registry, and `reviewerTranscript`,
 * `reviewerHistoryPage` and `stepTranscript` read the projected provider
 * sessions through the provider. Provisional findings and the overlap metrics
 * are read from the projected record, as the tab reads them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { CommandContext } from "./commands-context.js";
import {
  graphReviewIssue,
  graphReviewWorld,
  type GraphReviewWorld,
} from "./multi-review-graph-test-support.js";
import { scriptGraphReview } from "./multi-review-graph-surfaces-test-support.js";
import { stopReconciler } from "./public-api/reconciler.js";
import { reviewLaunchId } from "./public-api/review-recovery.js";
import { createPublicApiHarness, type PublicApiHarness } from "./public-api/test-support.js";
import { consolidationOverlap } from "./review-fanout-provenance.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(provider?: TranscriptProvider): Promise<GraphReviewWorld> {
  const w = await graphReviewWorld(
    provider ? { serviceOptions: { provider: async () => provider.provider } } : {},
  );
  cleanups.push(() => w.close());
  return w;
}

const opus = { agent: "claude", model: "opus" } as const;
const sonnet = { agent: "claude", model: "sonnet" } as const;

// ---------------------------------------------------------------- CLI

/** The public-action harness over the review world's own store and service. */
async function cli(w: GraphReviewWorld): Promise<PublicApiHarness> {
  await w.fixture.storage.updateEnvironment(w.environmentId, { setupPhase: "ready" });
  const harness = await createPublicApiHarness({
    context: {
      storage: w.fixture.storage,
      multiReviews: w.service,
    } as unknown as Partial<CommandContext>,
  });
  cleanups.push(async () => {
    // The reconciler is keyed by the store the actions ran on, not the harness's.
    await stopReconciler(w.fixture.storage);
    await harness.cleanup();
  });
  return harness;
}

function ok<T>(response: Awaited<ReturnType<PublicApiHarness["call"]>>): {
  result: T;
  receipt: NonNullable<typeof response.receipt>;
} {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return { result: response.result as T, receipt: response.receipt! };
}

describe("CLI review commands on a graph-engine review", () => {
  test("review.launch starts it once per request key; get and list read the projected record", async () => {
    const w = await world();
    scriptGraphReview(w, { findings: true });
    w.fakes.held.add("review");
    const harness = await cli(w);
    const input = {
      environmentId: w.environmentId,
      reviewers: [opus, sonnet],
      reviewModel: opus,
      fixModel: opus,
    };
    const launched = ok<{ workflowId: string; phase: string; outcome: string; ui: string }>(
      await harness.call("review.launch", input, { requestId: "graph-review" }),
    );
    // The receipt settles on the launch's own evidence: a saved record and an
    // opened tab. It never waits on the review, so no dispatch journal or turn
    // outcome is read for it on either engine.
    expect(launched.receipt).toMatchObject({ action: "review.launch", state: "succeeded" });
    expect(launched.result).toMatchObject({
      workflowId: reviewLaunchId(launched.receipt.operationId),
      phase: "preparing",
      outcome: "opened",
      ui: "opened",
    });
    const workflowId = launched.result.workflowId;
    expect(await w.workflow(workflowId)).toMatchObject({
      engine: "graph",
      graphRun: { runId: `multi-review-${workflowId}` },
    });

    const replay = await harness.call("review.launch", input, { requestId: "graph-review" });
    expect(replay.receipt).toMatchObject({
      operationId: launched.receipt.operationId,
      replayed: true,
    });
    expect(await w.fixture.storage.listMultiReviewWorkflows(w.environmentId)).toHaveLength(1);
    const receipt = await harness.call("run.get", { operationId: launched.receipt.operationId });
    expect(receipt.receipt?.state).toBe("succeeded");

    await w.drive(workflowId, (current) => current.phase === "reviewing");
    const reviewing = ok<Record<string, unknown>>(
      await harness.call("review.get", { workflowId }),
    ).result;
    expect(reviewing).toMatchObject({
      id: workflowId,
      phase: "reviewing",
      targetBranch: "main",
      automation: { autoFix: false, autoPr: false },
    });
    // The summary is bounded: nothing of the graph run or its sessions.
    expect(JSON.stringify(reviewing)).not.toContain("multi-review-");
    expect(JSON.stringify(reviewing)).not.toContain("ps-");

    w.fakes.held.delete("review");
    await w.settle(workflowId);
    const ready = ok<Record<string, unknown>>(await harness.call("review.get", { workflowId }));
    expect(ready.result).toMatchObject({
      phase: "ready",
      automation: { next: "Waiting for address_multi_review to start the Fix." },
    });
    const listed = ok<{ items: Array<Record<string, unknown>>; total: number }>(
      await harness.call("review.list", { environmentId: w.environmentId }),
    );
    expect(listed.result.total).toBe(1);
    expect(listed.result.items[0]).toEqual(ready.result);
  });

  test("review.cancel stops the graph run; get then reads it cancelled", async () => {
    const w = await world();
    scriptGraphReview(w, { findings: false });
    w.fakes.held.add("review");
    const harness = await cli(w);
    const workflow = await w.start();
    await w.drive(workflow.id, (current) => current.phase === "reviewing");
    const cancelled = ok<{ workflowId: string; phase: string }>(
      await harness.call("review.cancel", { workflowId: workflow.id }, { requestId: "cancel-1" }),
    );
    // The receipt confirms the request the supervisor accepted, as on the
    // bespoke engine; the record says when the run has actually stopped.
    expect(cancelled.receipt.state).toBe("succeeded");
    expect(cancelled.result).toEqual({ workflowId: workflow.id, phase: "cancelling" });
    const settled = await w.settle(workflow.id);
    expect(settled.phase).toBe("cancelled");
    expect((await w.run(settled)).status).toBe("cancelled");
    expect(
      ok<Record<string, unknown>>(await harness.call("review.get", { workflowId: workflow.id }))
        .result,
    ).toMatchObject({
      phase: "cancelled",
      automation: { next: "Nothing else runs automatically." },
    });
    // Cancelling the ended review again answers its settled phase, as on bespoke.
    const again = ok<{ workflowId: string; phase: string }>(
      await harness.call("review.cancel", { workflowId: workflow.id }, { requestId: "cancel-2" }),
    );
    expect(again.result).toEqual({ workflowId: workflow.id, phase: "cancelled" });
  });
});

// ---------------------------------------------------------------- review-pass tab

interface TranscriptProvider {
  provider: BuildPipelineProvider;
  /** Provider sessions read, in order. */
  reads: string[];
}

/** A provider whose every session's transcript names the session. */
function transcriptProvider(messageCount = 3): TranscriptProvider {
  const reads: string[] = [];
  const messagesOf = (sessionId: string) =>
    Array.from({ length: messageCount }, (_, index) => ({
      id: `${sessionId}-m${index}`,
      role: "assistant",
      content: `${sessionId} step ${index}`,
      parts: [{ type: "text", content: `${sessionId} step ${index}` }],
    }));
  const provider = {
    agent: "claude",
    async transcriptSnapshot(sessionId: string, options: { limit: number }) {
      reads.push(sessionId);
      const messages = messagesOf(sessionId);
      return {
        messages: messages.slice(-options.limit),
        complete: messages.length < options.limit,
      };
    },
    async messages(sessionId: string, options?: { limit?: number }) {
      const messages = messagesOf(sessionId);
      return options?.limit ? messages.slice(-options.limit) : messages;
    },
  };
  return { provider: provider as unknown as BuildPipelineProvider, reads };
}

const contentOf = (messages: unknown[]) =>
  messages.map((message) => (message as { content: string }).content);

describe("the review-pass tab's reads on a graph-engine review", () => {
  test("reviewer and step transcripts read each projected provider session", async () => {
    const transcripts = transcriptProvider();
    const w = await world(transcripts);
    scriptGraphReview(w, { findings: true });
    const settled = await w.settle((await w.start()).id);
    expect(settled.phase).toBe("ready");

    for (const reviewer of settled.reviewers) {
      const session = reviewer.providerSessionId!;
      expect(session).toMatch(/^ps-/);
      const read = await w.service.reviewerTranscript(settled.id, reviewer.id);
      expect(read).toMatchObject({
        workflowId: settled.id,
        reviewerId: reviewer.id,
        workflowPhase: "ready",
        status: "completed",
        transcript: "snapshot",
      });
      expect(contentOf(read.messages)).toEqual([0, 1, 2].map((n) => `${session} step ${n}`));
      expect(read.report?.issues).toHaveLength(1);
    }

    const prepare = await w.service.stepTranscript(settled.id, "prepare");
    expect(prepare).toMatchObject({ step: "prepare", session: "own", sessionStatus: "idle" });
    expect(contentOf(prepare.messages)[0]).toBe(
      `${settled.preparationSession!.providerSessionId} step 0`,
    );
    const consolidate = await w.service.stepTranscript(settled.id, "consolidate");
    expect(consolidate).toMatchObject({ session: "own" });
    expect(contentOf(consolidate.messages)[0]).toBe(
      `${settled.reviewSession!.providerSessionId} step 0`,
    );
    // No Fix ran: the step has no session to read.
    expect(await w.service.stepTranscript(settled.id, "fix")).toMatchObject({
      session: "none",
      messages: [],
    });
    expect(transcripts.reads).toEqual([
      settled.reviewers[0]!.providerSessionId!,
      settled.reviewers[1]!.providerSessionId!,
      settled.preparationSession!.providerSessionId,
      settled.reviewSession!.providerSessionId,
    ]);
  });

  test("a reviewer's earlier history pages from its projected session", async () => {
    const w = await world(transcriptProvider(620));
    scriptGraphReview(w, { findings: false });
    const settled = await w.settle((await w.start()).id);
    const reviewer = settled.reviewers[0]!;
    const session = reviewer.providerSessionId!;
    const tail = await w.service.reviewerTranscript(settled.id, reviewer.id);
    expect(tail.truncated).toBe(true);
    expect(typeof tail.historyCursor).toBe("string");
    const page = await w.service.reviewerHistoryPage(settled.id, reviewer.id, tail.historyCursor!, {
      limit: 100,
    });
    if (page.status !== "page") throw new Error(`expected a page, got ${page.status}`);
    const first = (tail.messages[0] as { id: string }).id;
    const firstIndex = Number(first.slice(first.lastIndexOf("-m") + 2));
    expect(page.messages.map((message) => (message as { id: string }).id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `${session}-m${firstIndex - 100 + index}`),
    );
    // Another reviewer's cursor never reads this reviewer's history.
    await expect(
      w.service.reviewerHistoryPage(settled.id, settled.reviewers[1]!.id, tail.historyCursor!),
    ).rejects.toThrow("does not belong to this reviewer");
  });

  test("a running reviewer's progress shows as provisional findings until its report is accepted", async () => {
    const w = await world();
    scriptGraphReview(w, { findings: true });
    w.fakes.held.add("review");
    const workflow = await w.start();
    await w.drive(workflow.id, (current) => current.reviewers[0]?.status === "running");
    const run = await w.run(await w.workflow(workflow.id));
    const activation = run.activations.find(
      (entry) => entry.nodeId === "review" && entry.branchKey === "panel.1",
    )!;
    // A reviewer's report_progress item: an issue as submitted, no provenance.
    const {
      reviewModels: _models,
      reviewSourceIds: _sources,
      alternativeFixes: _alternatives,
      ...issue
    } = graphReviewIssue("Early finding") as StructuredReviewReport["issues"][number] & {
      alternativeFixes?: unknown;
    };
    await w.graphRuns.updateActivation(run.id, activation.key, (current) => ({
      ...current,
      session: {
        ...current.session!,
        progress: [
          { id: "progress-1", port: "report", reportedAt: new Date(0).toISOString(), item: issue },
        ],
      },
    }));
    const running = await w.drive(
      workflow.id,
      (current) => (current.reviewers[0]?.provisionalFindings?.length ?? 0) > 0,
    );
    expect(running.reviewers[0]).toMatchObject({
      status: "running",
      provisionalFindings: [{ issue: { title: "Early finding" } }],
    });
    expect(running.reviewers[1]?.provisionalFindings).toBeUndefined();

    w.fakes.held.delete("review");
    const settled = await w.drive(
      workflow.id,
      (current) => current.reviewers[0]?.status === "completed",
    );
    expect(settled.reviewers[0]!.provisionalFindings).toBeUndefined();
    expect(settled.reviewers[0]!.report!.issues[0]!.title).toBe("Issue from panel.1");
  });

  test("the overlap metrics are what consolidationOverlap gives the equivalent bespoke review", async () => {
    const w = await world();
    scriptGraphReview(w, { findings: true });
    const settled = await w.settle((await w.start()).id);
    const consolidated = settled.consolidatedReport!;
    // The same consolidation as a bespoke consolidator cites it.
    const bespoke: StructuredReviewReport = {
      ...consolidated,
      issues: consolidated.issues.map((finding) => ({
        ...finding,
        reviewSourceIds: ["reviewer-1/issue-1", "reviewer-2/issue-1"],
      })),
      testCoverageGaps: consolidated.testCoverageGaps.map((gap) => ({
        ...gap,
        reviewSourceIds: ["reviewer-2/coverage-gap-1"],
      })),
    };
    expect(settled.consolidationOverlap).toEqual(consolidationOverlap(bespoke, settled.reviewers));
    expect(settled.consolidationOverlap?.positions).toEqual([
      expect.objectContaining({ position: 1, sourceFindings: 2, citedSourceFindings: 1 }),
      expect.objectContaining({ position: 2, sourceFindings: 2, citedSourceFindings: 2 }),
    ]);
  });
});
