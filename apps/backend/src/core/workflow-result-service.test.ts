import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { WorkflowResultService } from "./workflow-result-service.js";

const emptyReport: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "No change.",
    before: "Before.",
    after: "After.",
    keyCodeChanges: [],
    userImpact: "None.",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low." },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "No issues." },
  summaryOfChange: "No change.",
  reviewSummary: "No high-confidence issues were found.",
};

describe("WorkflowResultService", () => {
  let dataDir: string;
  let service: WorkflowResultService;
  const scope = { environmentId: "env-1", projectId: "project-1" };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-workflow-results-"));
    service = new WorkflowResultService(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function prepare(resultKey = crypto.randomUUID()) {
    await service.prepare({
      resultKey,
      kind: "feature-plan-state",
      ...scope,
      provider: "codex",
    });
    return resultKey;
  }

  test("persists an accepted result and receipt across service restarts", async () => {
    const resultKey = await prepare();
    const value = { phase: "confirming", title: "Tool results", summary: "Use callbacks." };
    const accepted = await service.submit(scope, resultKey, value);

    expect(accepted).toMatchObject({ ok: true, duplicate: false, lifecycle: "accepted" });
    const restarted = new WorkflowResultService(dataDir);
    expect(await restarted.structured(resultKey)).toEqual({
      ok: true,
      provider: "codex",
      requestId: resultKey,
      value,
    });
    expect(await restarted.status(scope, resultKey)).toMatchObject({
      resultKey,
      lifecycle: "accepted",
      receipt: accepted.ok ? accepted.receipt : undefined,
    });
  });

  test("returns diagnostics, accepts a correction, and deduplicates a lost response", async () => {
    const resultKey = await prepare();
    const invalid = await service.submit(scope, resultKey, { phase: "invalid" });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "invalid_result", nextAction: "correct" },
    });

    const value = { phase: "collecting", title: "A", summary: "" };
    const first = await service.submit(scope, resultKey, value);
    const retry = await service.submit(scope, resultKey, {
      summary: "",
      title: "A",
      phase: "collecting",
    });
    expect(first.ok).toBe(true);
    expect(retry).toEqual(first.ok ? { ...first, duplicate: true } : first);

    const conflict = await service.submit(scope, resultKey, {
      phase: "collecting",
      title: "Different",
      summary: "",
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: "submission_conflict" } });
  });

  test("serializes simultaneous submissions and enforces caller scope", async () => {
    const resultKey = await prepare();
    const denied = await service.submit(
      { environmentId: "env-2", projectId: "project-1" },
      resultKey,
      { phase: "collecting", title: "Denied", summary: "" },
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "capability_denied" } });

    const secondService = new WorkflowResultService(dataDir);
    const candidates = [
      service.submit(scope, resultKey, { phase: "collecting", title: "First", summary: "" }),
      secondService.submit(scope, resultKey, {
        phase: "collecting",
        title: "Second",
        summary: "",
      }),
    ];
    const results = await Promise.all(candidates);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "submission_conflict" }) }),
    ]);

    const stored = JSON.parse(await readFile(join(dataDir, "workflow-results.json"), "utf8")) as {
      entries: Record<string, { lifecycle: string }>;
    };
    expect(stored.entries[resultKey]?.lifecycle).toBe("accepted");
  });

  test("consumption removes the sensitive payload but retains receipt status", async () => {
    const resultKey = await prepare();
    await service.submit(scope, resultKey, {
      phase: "collecting",
      title: "A",
      summary: "",
    });
    await service.consume(resultKey);

    expect(await service.structured(resultKey)).toBeNull();
    expect(await service.status(scope, resultKey)).toMatchObject({
      resultKey,
      lifecycle: "consumed",
      receipt: expect.any(Object),
    });
  });

  test("rejects a story refinement submitted for another story", async () => {
    const resultKey = crypto.randomUUID();
    await service.prepare({
      resultKey,
      kind: "story-refinement",
      ...scope,
      provider: "codex",
      expectedStoryId: "story-a",
    });

    const submitted = await service.submit(scope, resultKey, {
      storyId: "story-b",
      title: "Wrong story",
      description: "Description",
      acceptanceCriteria: ["Criterion"],
    });
    expect(submitted).toMatchObject({
      ok: false,
      error: {
        code: "invalid_result",
        issues: [expect.objectContaining({ path: "$.storyId", code: "context_mismatch" })],
      },
    });
  });

  test("fails closed when the durable store contains an invalid entry", async () => {
    const resultKey = await prepare();
    const filePath = join(dataDir, "workflow-results.json");
    const stored = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Record<string, { provider: string }>;
    };
    stored.entries[resultKey]!.provider = "unknown";
    await writeFile(filePath, JSON.stringify(stored));

    await expect(service.registered(resultKey)).rejects.toThrow("invalid store");
  });

  test("rejects reconciliation operations that do not match the pinned report and pool", async () => {
    const resultKey = crypto.randomUUID();
    await service.prepare({
      resultKey,
      kind: "review-reconciliation",
      ...scope,
      provider: "codex",
      context: {
        type: "review-reconciliation",
        pool: { issues: [], coverageGaps: [] },
        report: emptyReport,
      },
    });

    const submitted = await service.submit(scope, resultKey, {
      newIssues: [],
      issueUpdates: [],
      newCoverageGaps: [],
      coverageGapUpdates: [],
      issueOutcomes: [{ reportIndex: 0, outcome: "existing", poolId: "invented" }],
      coverageGapOutcomes: [],
    });
    expect(submitted).toMatchObject({
      ok: false,
      error: {
        code: "invalid_result",
        issues: [expect.objectContaining({ code: "missing_outcome" })],
      },
    });
  });
  test("a corrected result is still accepted after the same invalid one is redelivered", async () => {
    const resultKey = await prepare();
    const invalid = { phase: "collecting", title: 7, summary: "" };
    const first = await service.submit(scope, resultKey, invalid);
    const second = await service.submit(scope, resultKey, invalid);
    expect(first).toMatchObject({ ok: false, error: { code: "invalid_result" } });
    // The same payload twice is one diagnostic and one correction-budget entry.
    expect(second).toEqual(first);

    const accepted = await service.submit(scope, resultKey, {
      phase: "collecting",
      title: "Corrected",
      summary: "",
    });
    expect(accepted).toMatchObject({ ok: true, duplicate: false });
    const stored = await service.structured<{ title: string }>(resultKey);
    expect(stored?.ok === true && stored.value.title).toBe("Corrected");
  });

  test("the correction budget closes after four distinct invalid payloads", async () => {
    const resultKey = await prepare();
    const outcomes = [];
    for (let index = 0; index < 4; index += 1) {
      outcomes.push(
        await service.submit(scope, resultKey, {
          phase: "collecting",
          title: index,
          summary: "",
        }),
      );
    }
    expect(outcomes.slice(0, 3).every((outcome) => !outcome.ok)).toBe(true);
    expect(outcomes[3]).toMatchObject({
      ok: false,
      error: { code: "correction_budget_exhausted", nextAction: "stop" },
    });
    expect(await service.projection(resultKey)).toBe("needs-attention");
    const lateValid = await service.submit(scope, resultKey, {
      phase: "collecting",
      title: "Too late",
      summary: "",
    });
    expect(lateValid).toMatchObject({
      ok: false,
      error: { code: "correction_budget_exhausted", nextAction: "stop" },
    });
    expect(await service.structured(resultKey)).toBeNull();
    expect(await service.status(scope, resultKey)).toMatchObject({
      lifecycle: "exhausted",
      completion: "blocked",
    });
  });

  test("two simultaneous identical valid calls produce one receipt", async () => {
    const resultKey = await prepare();
    const payload = { phase: "collecting", title: "Same", summary: "" };
    const second = new WorkflowResultService(dataDir);
    const results = await Promise.all([
      service.submit(scope, resultKey, payload),
      second.submit(scope, resultKey, payload),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const receipts = results.flatMap((result) => (result.ok ? [result.receipt.receiptId] : []));
    expect(new Set(receipts).size).toBe(1);
    expect(results.filter((result) => result.ok && result.duplicate)).toHaveLength(1);
  });

  test("a save failure before acceptance issues no receipt and leaves the slot open", async () => {
    const resultKey = await prepare();
    const filePath = join(dataDir, "workflow-results.json");
    // Replacing the store file with a directory makes the atomic rename fail at
    // the real write boundary rather than at a mocked method.
    await rm(filePath, { force: true });
    await mkdir(filePath, { recursive: true });
    await expect(
      service.submit(scope, resultKey, { phase: "collecting", title: "A", summary: "" }),
    ).rejects.toThrow();
    await rm(filePath, { recursive: true, force: true });

    const reopened = new WorkflowResultService(dataDir);
    await reopened.prepare({ resultKey, kind: "feature-plan-state", ...scope, provider: "codex" });
    expect(await reopened.status(scope, resultKey)).toMatchObject({
      lifecycle: "open",
      completion: "pending",
    });
    expect(await reopened.structured(resultKey)).toBeNull();
  });

  test("a replay after the stage advanced returns the original receipt, not a second acceptance", async () => {
    const resultKey = await prepare();
    const payload = { phase: "collecting", title: "A", summary: "" };
    const accepted = await service.submit(scope, resultKey, payload);
    await service.consume(resultKey);

    const replay = await service.submit(scope, resultKey, payload);
    expect(replay).toMatchObject({ ok: true, duplicate: true, lifecycle: "consumed" });
    if (replay.ok && accepted.ok) {
      expect(replay.receipt.receiptId).toBe(accepted.receipt.receiptId);
    }
    // A replay must not resurrect the consumed payload for a second application.
    expect(await service.structured(resultKey)).toBeNull();
  });

  test("cancellation prevents a later submission and a cancelled slot cannot be consumed", async () => {
    const resultKey = await prepare();
    await service.close(resultKey, "cancelled");
    const late = await service.submit(scope, resultKey, {
      phase: "collecting",
      title: "Late",
      summary: "",
    });
    expect(late).toMatchObject({
      ok: false,
      error: { code: "attempt_closed", nextAction: "stop" },
    });
    expect(await service.status(scope, resultKey)).toMatchObject({
      lifecycle: "cancelled",
      completion: "blocked",
    });
    await expect(service.consume(resultKey)).rejects.toThrow("not accepted");
  });

  test("cancellation after acceptance keeps the receipt and blocks consumption", async () => {
    const resultKey = await prepare();
    await service.submit(scope, resultKey, { phase: "collecting", title: "A", summary: "" });
    await service.close(resultKey, "cancelled");

    const status = await service.status(scope, resultKey);
    expect(status).toMatchObject({ lifecycle: "cancelled", completion: "blocked" });
    expect(status?.receipt).toBeDefined();
    expect(await service.structured(resultKey)).toBeNull();
    expect(
      await service.submit(scope, resultKey, {
        phase: "collecting",
        title: "Late replay",
        summary: "",
      }),
    ).toMatchObject({ ok: false, error: { code: "attempt_closed" } });
  });

  test("terminal slots discard bulky validation context and stay below the byte ceiling", async () => {
    const sources = Object.fromEntries(
      Array.from({ length: 4_096 }, (_, index) => [`reviewer-${index}:0`, "issue" as const]),
    );
    for (let index = 0; index < 24; index += 1) {
      const resultKey = crypto.randomUUID();
      await service.prepare({
        resultKey,
        kind: "consolidated-review",
        ...scope,
        provider: "codex",
        context: { type: "consolidated-review", sources },
      });
      await service.close(resultKey, "superseded");
    }
    const filePath = join(dataDir, "workflow-results.json");
    const raw = await readFile(filePath, "utf8");
    const stored = JSON.parse(raw) as {
      entries: Record<string, { context?: unknown; schema?: unknown; rejectedDigests: string[] }>;
    };
    expect(Buffer.byteLength(raw)).toBeLessThan(256 * 1024);
    expect(
      Object.values(stored.entries).every(
        (entry) =>
          entry.context === undefined &&
          entry.schema === undefined &&
          entry.rejectedDigests.length === 0,
      ),
    ).toBe(true);
    await expect(prepare()).resolves.toBeString();
  });

  test("regenerates a truncated capability identity atomically", async () => {
    await writeFile(join(dataDir, "workflow-result-tools.json"), '{"version":1');
    await expect(service.initializeCapabilityIdentity()).resolves.toBeUndefined();
    const resultKey = await prepare();
    const token = service.capabilityToken(scope, resultKey);
    expect(await service.authenticateCapability(token)).toEqual({
      ...scope,
      workflowResultKey: resultKey,
    });
    expect(JSON.parse(await readFile(join(dataDir, "workflow-result-tools.json"), "utf8"))).toEqual(
      expect.objectContaining({ version: 1, secret: expect.any(String) }),
    );
  });

  test("a superseded attempt does not affect its replacement", async () => {
    const first = await prepare();
    await service.close(first, "superseded");
    const second = await prepare();
    const accepted = await service.submit(scope, second, {
      phase: "collecting",
      title: "Replacement",
      summary: "",
    });
    expect(accepted).toMatchObject({ ok: true, duplicate: false });
    expect(await service.status(scope, first)).toMatchObject({ lifecycle: "superseded" });
  });

  test("rebinding a key to a different attempt is refused", async () => {
    const resultKey = await prepare();
    await expect(
      service.prepare({ resultKey, kind: "review-report", ...scope, provider: "codex" }),
    ).rejects.toThrow("already bound");
  });

  test("an oversized result is refused without entering the correction budget", async () => {
    const resultKey = await prepare();
    const oversized = await service.submit(scope, resultKey, {
      phase: "collecting",
      title: "A",
      summary: "\u00e9".repeat(400_000),
    });
    expect(oversized).toMatchObject({
      ok: false,
      error: { code: "result_too_large", nextAction: "stop" },
    });
    expect(await service.projection(resultKey)).toBe("preparing");
  });

  test("a non-serializable value is refused as invalid input", async () => {
    const resultKey = await prepare();
    const circular: Record<string, unknown> = { phase: "collecting", title: "A", summary: "" };
    circular.self = circular;
    expect(await service.submit(scope, resultKey, circular)).toMatchObject({
      ok: false,
      error: { code: "invalid_result", nextAction: "correct" },
    });
  });

  test("the projected delivery state tracks preparing, correcting, and received", async () => {
    const resultKey = await prepare();
    expect(await service.projection(resultKey)).toBe("preparing");
    await service.submit(scope, resultKey, { phase: "collecting", title: 1, summary: "" });
    expect(await service.projection(resultKey)).toBe("correcting");
    await service.submit(scope, resultKey, { phase: "collecting", title: "A", summary: "" });
    expect(await service.projection(resultKey)).toBe("received");
    await service.consume(resultKey);
    expect(await service.projection(resultKey)).toBeUndefined();
    expect(await service.projection(crypto.randomUUID())).toBeUndefined();
  });

  test("repeated status reads do not manufacture progress", async () => {
    const resultKey = await prepare();
    const reads = await Promise.all(
      Array.from({ length: 5 }, () => service.status(scope, resultKey)),
    );
    expect(reads.every((read) => read?.lifecycle === "open" && read.receipt === undefined)).toBe(
      true,
    );
  });

  test("delivery metrics stay content-free and count distinct corrections once", async () => {
    const resultKey = await prepare();
    const invalid = { phase: "collecting", title: 1, summary: "" };
    await service.submit(scope, resultKey, invalid);
    await service.submit(scope, resultKey, invalid);
    await service.submit(scope, resultKey, { phase: "collecting", title: "A", summary: "" });
    await service.consume(resultKey);

    const snapshot = service.metrics.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(resultKey);
    expect(serialized).not.toContain("summary");
    expect(snapshot.counters["corrections|provider=codex|kind=feature-plan-state"]).toBe(1);
    expect(
      snapshot.counters["submissions|provider=codex|kind=feature-plan-state|outcome=accepted"],
    ).toBe(1);
    expect(
      snapshot.counters[
        "attempts|provider=codex|kind=feature-plan-state|transport=tool-v1|schema=1"
      ],
    ).toBe(1);
    expect(snapshot.durations["acceptance_to_consumption_ms|kind=feature-plan-state"]?.count).toBe(
      1,
    );
  });

  test("a slot closed without any submission is counted as a missing submission", async () => {
    const resultKey = await prepare();
    await service.close(resultKey, "cancelled");
    expect(
      service.metrics.snapshot().counters[
        "missing_submissions|provider=codex|kind=feature-plan-state|reason=cancelled"
      ],
    ).toBe(1);
  });
});
