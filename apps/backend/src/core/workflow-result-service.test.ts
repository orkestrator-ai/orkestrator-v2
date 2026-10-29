import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  WORKFLOW_RESULT_MAX_ENTRIES,
  WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY,
} from "@orkestrator/protocol/workflow-results";
import { StorageDatabase } from "./storage-database.js";
import {
  readStoredValue,
  seedStore,
  seedUnreadableStore,
  storageFilesContain,
} from "./storage-test-support.js";
import { WorkflowResultService } from "./workflow-result-service.js";

const STORE = "workflow-results.json";

type StoredValue = {
  version: number;
  entries: Record<string, Record<string, unknown> & { lifecycle: string }>;
};

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
  let services: WorkflowResultService[] = [];
  const scope = { environmentId: "env-1", projectId: "project-1" };

  /** Another service on the same data directory: its own connection, like another backend. */
  function open(): WorkflowResultService {
    const opened = new WorkflowResultService(dataDir);
    services.push(opened);
    return opened;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-workflow-results-"));
    services = [];
    service = open();
  });

  afterEach(async () => {
    for (const opened of services) opened.closeStorage();
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

  test("environment deletion removes only that environment's slots, open or settled", async () => {
    const open = await prepare();
    const accepted = await prepare();
    await service.submit(scope, accepted, { phase: "confirming", title: "T", summary: "S" });
    const other = crypto.randomUUID();
    await service.prepare({
      resultKey: other,
      kind: "feature-plan-state",
      environmentId: "env-2",
      projectId: scope.projectId,
      provider: "codex",
    });

    expect(await service.deleteByEnvironment(scope.environmentId)).toBe(2);
    expect(await service.registered(open)).toBe(false);
    expect(await service.registered(accepted)).toBe(false);
    expect(await service.registered(other)).toBe(true);
    expect(await service.deleteByEnvironment(scope.environmentId)).toBe(0);
  });

  test("announces a first acceptance after its commit, once, to isolated listeners", async () => {
    const resultKey = await prepare();
    const seen: { resultKey: string; environmentId: string; kind: string; committed: boolean }[] =
      [];
    service.onAccepted(() => {
      throw new Error("a faulty listener must not fail the submission");
    });
    const unsubscribe = service.onAccepted((event) => {
      // Fired after the durable commit: a fresh service already reads it.
      void open()
        .structured(event.resultKey)
        .then((result) => {
          seen.push({ ...event, committed: result !== null });
        });
    });
    const value = { phase: "confirming", title: "Tool results", summary: "Use callbacks." };
    expect(await service.submit(scope, resultKey, value)).toMatchObject({ ok: true });
    // A duplicate submission of the same result is not a new acceptance.
    expect(await service.submit(scope, resultKey, value)).toMatchObject({ duplicate: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The event names the slot's kind, so a listener can skip other kinds unread.
    expect(seen).toEqual([
      { resultKey, environmentId: "env-1", kind: "feature-plan-state", committed: true },
    ]);
    unsubscribe();
    const second = await prepare();
    await service.submit(scope, second, value);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
  });

  test("persists an accepted result and receipt across service restarts", async () => {
    const resultKey = await prepare();
    const value = { phase: "confirming", title: "Tool results", summary: "Use callbacks." };
    const accepted = await service.submit(scope, resultKey, value);

    expect(accepted).toMatchObject({ ok: true, duplicate: false, lifecycle: "accepted" });
    const restarted = open();
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

  test("preflight validation is read-only and does not consume the correction budget", async () => {
    const resultKey = await prepare();
    const invalid = { phase: "collecting", title: 7, summary: "" };
    for (let index = 0; index < 6; index += 1) {
      expect(await service.validate(scope, resultKey, invalid)).toMatchObject({
        ok: false,
        error: { code: "invalid_result", nextAction: "correct" },
      });
    }
    expect(await service.projection(resultKey)).toBe("preparing");

    const valid = { phase: "collecting", title: "Final", summary: "Complete result." };
    expect(await service.validate(scope, resultKey, valid)).toEqual({
      ok: true,
      valid: true,
      validatedDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(service.metrics.snapshot()).toMatchObject({
      counters: {
        "preflights|outcome=invalid_result": 6,
        "preflights|outcome=valid": 1,
      },
      durations: {
        "validation_ms|kind=feature-plan-state": { count: 7 },
      },
    });
    expect(await service.projection(resultKey)).toBe("preparing");
    expect(await service.submit(scope, resultKey, valid)).toMatchObject({
      ok: true,
      duplicate: false,
    });
  });

  describe("committing a validated result by digest", () => {
    const valid = { phase: "collecting", title: "Final", summary: "Complete result." };

    async function validated() {
      const resultKey = await prepare();
      const outcome = await service.validate(scope, resultKey, valid);
      if (!outcome.ok || !outcome.validatedDigest) throw new Error("validation failed");
      return { resultKey, digest: outcome.validatedDigest };
    }

    test("accepts exactly the payload that was validated", async () => {
      const { resultKey, digest } = await validated();
      expect(service.heldValidation(resultKey)).toMatchObject({ digest });
      const accepted = await service.submitValidated(scope, resultKey, digest);
      expect(accepted).toMatchObject({ ok: true, duplicate: false });
      expect(await service.structured(resultKey)).toMatchObject({ value: valid });
      expect(service.heldValidation(resultKey)).toBeUndefined();
      // A retry with the same payload in full is an idempotent duplicate.
      expect(await service.submit(scope, resultKey, valid)).toMatchObject({
        ok: true,
        duplicate: true,
      });
    });

    test("replays the original digest receipt after acceptance, consumption and restart", async () => {
      const { resultKey, digest } = await validated();
      const accepted = await service.submitValidated(scope, resultKey, digest);
      if (!accepted.ok) throw new Error("acceptance failed");
      for (const lifecycle of ["accepted", "consumed"] as const) {
        if (lifecycle === "consumed") await service.consume(resultKey);
        for (const reader of [service, open()]) {
          expect(await reader.submitValidated(scope, resultKey, digest)).toEqual({
            ...accepted,
            lifecycle,
            duplicate: true,
          });
          expect(await reader.submitValidated(scope, resultKey, "0".repeat(64))).toMatchObject({
            ok: false,
            error: { code: "submission_conflict", nextAction: "stop" },
          });
          for (const deniedScope of [
            { ...scope, projectId: "other" },
            { ...scope, environmentId: "other" },
          ]) {
            expect(await reader.submitValidated(deniedScope, resultKey, digest)).toMatchObject({
              ok: false,
              error: { code: "capability_denied" },
            });
          }
        }
      }
      expect(await service.structured(resultKey)).toBeNull();
    });

    test("concurrent digest commits accept once and wake once", async () => {
      const { resultKey, digest } = await validated();
      const events: unknown[] = [];
      service.onAccepted((event) => events.push(event));
      const outcomes = await Promise.all([
        service.submitValidated(scope, resultKey, digest),
        service.submitValidated(scope, resultKey, digest),
      ]);
      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(outcomes.filter((outcome) => outcome.ok && !outcome.duplicate)).toHaveLength(1);
      expect(
        new Set(outcomes.flatMap((outcome) => (outcome.ok ? [outcome.receipt.receiptId] : [])))
          .size,
      ).toBe(1);
      expect(events).toHaveLength(1);
    });

    test("retains the validated candidate when the acceptance commit fails", async () => {
      const { resultKey, digest } = await validated();
      const events: unknown[] = [];
      service.onAccepted((event) => events.push(event));
      const database = (service as unknown as { database: StorageDatabase }).database;
      const realUpdate = database.updateStoreRow.bind(database);
      const update = spyOn(database, "updateStoreRow").mockImplementationOnce(
        (...args: Parameters<StorageDatabase["updateStoreRow"]>) => {
          // The acceptance row is written inside the transaction; failing
          // after it must roll the accepted row back with the whole commit.
          realUpdate(...args);
          throw new Error("disk I/O error");
        },
      );
      try {
        await expect(service.submitValidated(scope, resultKey, digest)).rejects.toThrow(
          "disk I/O error",
        );
      } finally {
        update.mockRestore();
      }
      expect(readStoredValue<StoredValue>(dataDir, STORE)?.entries[resultKey]?.lifecycle).toBe(
        "open",
      );
      expect(events).toHaveLength(0);
      expect(service.heldValidation(resultKey)).toMatchObject({ digest });
      expect(await service.status(scope, resultKey)).toMatchObject({ lifecycle: "open" });
      const accepted = await service.submitValidated(scope, resultKey, digest);
      expect(accepted).toMatchObject({ ok: true, duplicate: false });
      if (!accepted.ok) throw new Error("acceptance failed");
      expect(await service.submitValidated(scope, resultKey, digest)).toEqual({
        ...accepted,
        duplicate: true,
      });
      expect(events).toHaveLength(1);
      expect(service.heldValidation(resultKey)).toBeUndefined();
      expect(await open().structured(resultKey)).toMatchObject({
        value: valid,
      });
    });

    test.each(["cancelled", "superseded"] as const)(
      "digest replay preserves %s denial",
      async (lifecycle) => {
        const { resultKey, digest } = await validated();
        await service.submitValidated(scope, resultKey, digest);
        await service.close(resultKey, lifecycle);
        expect(await service.submitValidated(scope, resultKey, digest)).toMatchObject({
          ok: false,
          error: { code: "attempt_closed", nextAction: "stop" },
        });
      },
    );

    test("an unknown or unauthorized slot is denied without a cached candidate", async () => {
      const resultKey = await prepare();
      for (const key of [resultKey, crypto.randomUUID()]) {
        expect(
          await service.submitValidated({ ...scope, projectId: "other" }, key, "0".repeat(64)),
        ).toMatchObject({
          ok: false,
          error: { code: "capability_denied" },
        });
      }
    });

    test("an exhausted slot keeps its closed-state response for digest commits", async () => {
      const { resultKey, digest } = await validated();
      for (let title = 0; title < 4; title += 1)
        await service.submit(scope, resultKey, { ...valid, title });
      expect(service.heldValidation(resultKey)).toBeUndefined();
      expect(await service.submitValidated(scope, resultKey, digest)).toMatchObject({
        ok: false,
        error: { code: "correction_budget_exhausted" },
      });
    });

    test.each([true, false])(
      "validation and close cannot orphan a candidate (close first: %s)",
      async (closeFirst) => {
        const resultKey = await prepare();
        const operations = closeFirst
          ? [service.close(resultKey, "cancelled"), service.validate(scope, resultKey, valid)]
          : [service.validate(scope, resultKey, valid), service.close(resultKey, "cancelled")];
        await Promise.all(operations);
        expect(service.heldValidation(resultKey)).toBeUndefined();
        expect(await service.validate(scope, resultKey, valid)).toMatchObject({
          ok: false,
          error: { code: "attempt_closed" },
        });
        expect(service.heldValidation(resultKey)).toBeUndefined();
        expect(await service.status(scope, resultKey)).toMatchObject({ lifecycle: "cancelled" });
      },
    );

    test("the one-shot nudge claim survives candidate replacement and clears on settlement", async () => {
      const { resultKey } = await validated();
      expect(service.claimCommitNudge(resultKey)).toBe(true);
      await service.validate(scope, resultKey, { ...valid, title: "Updated" });
      expect(service.claimCommitNudge(resultKey)).toBe(false);
      await service.close(resultKey, "cancelled");
      expect(service.claimCommitNudge(resultKey)).toBe(false);
      const next = await validated();
      expect(service.claimCommitNudge(next.resultKey)).toBe(true);
    });

    test("an unknown digest is correctable feedback that spends no budget", async () => {
      const { resultKey } = await validated();
      for (let index = 0; index < 6; index += 1) {
        expect(await service.submitValidated(scope, resultKey, "0".repeat(64))).toMatchObject({
          ok: false,
          error: {
            code: "invalid_result",
            nextAction: "correct",
            issues: [{ path: "$.validatedDigest", code: "unknown_validation" }],
          },
        });
      }
      expect(await service.projection(resultKey)).toBe("preparing");
    });

    test("an invalid later validation does not replace the held payload", async () => {
      const { resultKey, digest } = await validated();
      const invalid = { phase: "collecting", title: 7, summary: "" };
      expect(await service.validate(scope, resultKey, invalid)).toMatchObject({ ok: false });
      expect(service.heldValidation(resultKey)).toMatchObject({ digest });
    });

    test("a caller outside the slot's scope cannot commit it", async () => {
      const { resultKey, digest } = await validated();
      expect(
        await service.submitValidated({ ...scope, projectId: "other" }, resultKey, digest),
      ).toMatchObject({ ok: false, error: { code: "capability_denied" } });
      expect(await service.projection(resultKey)).toBe("preparing");
    });

    test("closing the slot drops the held payload", async () => {
      const { resultKey, digest } = await validated();
      await service.close(resultKey, "cancelled");
      expect(service.heldValidation(resultKey)).toBeUndefined();
      expect(await service.submitValidated(scope, resultKey, digest)).toMatchObject({
        ok: false,
      });
    });

    test("holds a bounded number of payloads, dropping the oldest first", async () => {
      const first = await validated();
      let last = first;
      for (let index = 0; index < 64; index += 1) last = await validated();
      expect(service.heldValidation(first.resultKey)).toBeUndefined();
      expect(service.heldValidation(last.resultKey)).toMatchObject({ digest: last.digest });
    });

    test("an expired payload is not committed", async () => {
      const { resultKey, digest } = await validated();
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 31 * 60_000;
        expect(service.heldValidation(resultKey)).toBeUndefined();
        expect(await service.submitValidated(scope, resultKey, digest)).toMatchObject({
          ok: false,
          error: { code: "invalid_result" },
        });
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe("delivery evidence in status", () => {
    const valid = { phase: "collecting", title: "Final", summary: "Complete result." };

    test("does not infer client parsing faults from zero completed calls", async () => {
      const resultKey = await prepare();
      const status = await service.status(scope, resultKey);
      expect(status?.delivery).toMatchObject({ validationCalls: 0, submissionCalls: 0 });
      expect(status?.delivery?.hint).toContain("No validation or submission has been processed");
      expect(status?.delivery?.hint).toContain("service size or capacity limits");
      expect(status?.delivery?.hint).not.toContain("malformed");
    });

    test.each(["validate", "submit"] as const)(
      "%s size rejection does not imply malformed client JSON",
      async (method) => {
        const resultKey = await prepare();
        expect(
          await service[method](scope, resultKey, { ...valid, summary: "x".repeat(800_000) }),
        ).toMatchObject({
          ok: false,
          error: { code: "result_too_large" },
        });
        const delivery = (await service.status(scope, resultKey))?.delivery;
        expect(delivery).toMatchObject({ validationCalls: 0, submissionCalls: 0 });
        expect(delivery?.hint).toContain("service size or capacity limits");
        expect(delivery?.hint).not.toContain("malformed");
      },
    );

    test.each(["validate", "submit"] as const)(
      "%s backpressure rejection does not imply malformed client JSON",
      async (method) => {
        const resultKey = await prepare();
        // Occupy admission without completing validation or submission work.
        const admission = service as unknown as {
          beginPending(key: string, bytes: number): boolean;
          endPending(key: string, bytes: number): void;
        };
        for (let i = 0; i < WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY; i += 1)
          expect(admission.beginPending(resultKey, 0)).toBe(true);
        try {
          expect(await service[method](scope, resultKey, valid)).toMatchObject({
            ok: false,
            error: { code: "backpressure" },
          });
          const delivery = (await service.status(scope, resultKey))?.delivery;
          expect(delivery).toMatchObject({ validationCalls: 0, submissionCalls: 0 });
          expect(delivery?.hint).toContain("service size or capacity limits");
          expect(delivery?.hint).not.toContain("malformed");
        } finally {
          for (let i = 0; i < WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY; i += 1)
            admission.endPending(resultKey, 0);
        }
      },
    );

    test("points at the held digest after a successful validation", async () => {
      const resultKey = await prepare();
      const outcome = await service.validate(scope, resultKey, valid);
      const digest = outcome.ok ? outcome.validatedDigest : undefined;
      const status = await service.status(scope, resultKey);
      expect(status?.delivery).toMatchObject({
        validationCalls: 1,
        submissionCalls: 0,
        lastValidation: "valid",
        validatedDigest: digest,
      });
      expect(status?.delivery?.hint).toContain("submit_feature_plan_state");
      expect(status?.delivery?.hint).toContain("validatedDigest");
    });

    test("reports invalid validation and counts submissions that arrived", async () => {
      const resultKey = await prepare();
      await service.validate(scope, resultKey, { phase: "collecting", title: 7, summary: "" });
      await service.submit(scope, resultKey, { phase: "collecting", title: 7, summary: "" });
      const status = await service.status(scope, resultKey);
      expect(status?.delivery).toMatchObject({
        validationCalls: 1,
        submissionCalls: 1,
        lastValidation: "invalid",
      });
      expect(status?.delivery?.hint).toContain("last validation reported problems");
    });

    test("is omitted once the slot is no longer open", async () => {
      const resultKey = await prepare();
      await service.submit(scope, resultKey, valid);
      expect((await service.status(scope, resultKey))?.delivery).toBeUndefined();
    });
  });

  test("preflight validation enforces per-key backpressure", async () => {
    const resultKey = await prepare();
    const payload = { phase: "collecting", title: "Final", summary: "Complete result." };
    // Validation commits synchronously, so calls no longer overlap on their
    // own; occupy the key's admission as calls still in flight would.
    const admission = service as unknown as {
      beginPending(key: string, bytes: number): boolean;
      endPending(key: string, bytes: number): void;
    };
    for (let i = 0; i < WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY - 1; i += 1)
      expect(admission.beginPending(resultKey, 0)).toBe(true);
    try {
      expect(await service.validate(scope, resultKey, payload)).toMatchObject({ ok: true });
      expect(admission.beginPending(resultKey, 0)).toBe(true);
      expect(await service.validate(scope, resultKey, payload)).toMatchObject({
        ok: false,
        error: { code: "backpressure" },
      });
      // Another key is admitted independently.
      expect(await service.validate(scope, await prepare(), payload)).toMatchObject({ ok: true });
    } finally {
      for (let i = 0; i < WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY; i += 1)
        admission.endPending(resultKey, 0);
    }
    expect(service.metrics.snapshot().gauges).toMatchObject({ pending_calls: 0, pending_bytes: 0 });
  });

  test("preflight validation covers scope, lifecycle, size, and serialization denials", async () => {
    const openKey = await prepare();
    expect(
      await service.validate({ environmentId: "env-2", projectId: scope.projectId }, openKey, {
        phase: "collecting",
        title: "Final",
        summary: "",
      }),
    ).toMatchObject({ ok: false, error: { code: "capability_denied" } });

    const closedKey = await prepare();
    await service.close(closedKey, "cancelled");
    expect(
      await service.validate(scope, closedKey, {
        phase: "collecting",
        title: "Final",
        summary: "",
      }),
    ).toMatchObject({ ok: false, error: { code: "attempt_closed" } });

    const exhaustedKey = await prepare();
    for (let index = 0; index < 4; index += 1) {
      await service.submit(scope, exhaustedKey, {
        phase: "collecting",
        title: index,
        summary: "",
      });
    }
    expect(
      await service.validate(scope, exhaustedKey, {
        phase: "collecting",
        title: "Final",
        summary: "",
      }),
    ).toMatchObject({ ok: false, error: { code: "correction_budget_exhausted" } });

    expect(
      await service.validate(scope, openKey, {
        phase: "collecting",
        title: "Final",
        summary: "é".repeat(400_000),
      }),
    ).toMatchObject({ ok: false, error: { code: "result_too_large" } });

    const circular: Record<string, unknown> = {
      phase: "collecting",
      title: "Final",
      summary: "",
    };
    circular.self = circular;
    expect(await service.validate(scope, openKey, circular)).toMatchObject({
      ok: false,
      error: { code: "invalid_result" },
    });
  });

  test("serializes simultaneous submissions and enforces caller scope", async () => {
    const resultKey = await prepare();
    const denied = await service.submit(
      { environmentId: "env-2", projectId: "project-1" },
      resultKey,
      { phase: "collecting", title: "Denied", summary: "" },
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "capability_denied" } });

    const secondService = open();
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

    const stored = readStoredValue<StoredValue>(dataDir, STORE)!;
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
    const other = await prepare();
    const stored = readStoredValue<StoredValue>(dataDir, STORE)!;
    stored.entries[resultKey]!.provider = "unknown";
    // Written by another connection, as another backend sharing the directory would.
    seedStore(dataDir, STORE, stored);

    await expect(service.registered(resultKey)).rejects.toThrow("invalid store");
    await expect(service.structured(resultKey)).rejects.toThrow("invalid store");
    // A read of a valid row still works; every mutation revalidates the store.
    expect(await service.registered(other)).toBe(true);
    await expect(service.close(other, "cancelled")).rejects.toThrow("invalid store");
    await expect(prepare()).rejects.toThrow("invalid store");
    expect(readStoredValue<StoredValue>(dataDir, STORE)?.entries[other]?.lifecycle).toBe("open");
  });

  test.each([
    ["an unreadable store", () => seedUnreadableStore(dataDir, STORE, "{not-json")],
    ["another store version", () => seedStore(dataDir, STORE, { version: 2, entries: {} })],
    ["entries that are not a record", () => seedStore(dataDir, STORE, { version: 1, entries: [] })],
  ])("fails closed on %s instead of replacing it", async (_label, corrupt) => {
    const resultKey = await prepare();
    corrupt();
    await expect(service.registered(resultKey)).rejects.toThrow("invalid store");
    await expect(service.status(scope, resultKey)).rejects.toThrow("invalid store");
    await expect(prepare()).rejects.toThrow("invalid store");
    await expect(open().deleteByEnvironment(scope.environmentId)).rejects.toThrow("invalid store");
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

  describe("an acceptance check", () => {
    const valid = { phase: "collecting", title: "Final", summary: "Complete result." };
    const refusal = {
      code: "worktree_changed" as const,
      nextAction: "correct" as const,
      message: "Remove the stray path.",
    };

    test("refuses validation and submission without spending the correction budget", async () => {
      const resultKey = await prepare();
      const asked: unknown[] = [];
      let blocked = true;
      service.addAcceptanceCheck("feature-plan-state", async (attempt) => {
        asked.push(attempt);
        return blocked ? refusal : null;
      });

      expect(await service.validate(scope, resultKey, valid)).toEqual({
        ok: false,
        error: refusal,
      });
      // Nothing is held, so the refusal cannot be bypassed by digest.
      expect((await service.status(scope, resultKey))?.delivery).toMatchObject({
        validationCalls: 1,
        lastValidation: "invalid",
      });
      expect((await service.status(scope, resultKey))?.delivery?.validatedDigest).toBeUndefined();
      for (let index = 0; index < 6; index += 1) {
        expect(await service.submit(scope, resultKey, valid)).toEqual({
          ok: false,
          error: refusal,
        });
      }
      expect(await service.projection(resultKey)).toBe("preparing");
      expect(asked[0]).toEqual({ resultKey, kind: "feature-plan-state", ...scope });

      blocked = false;
      expect(await service.submit(scope, resultKey, valid)).toMatchObject({ ok: true });
      // An accepted result's duplicate is answered from its receipt, unchecked.
      blocked = true;
      expect(await service.submit(scope, resultKey, valid)).toMatchObject({
        ok: true,
        duplicate: true,
      });
    });

    test("refuses a commit by digest when the environment changed after validation", async () => {
      const resultKey = await prepare();
      let blocked = false;
      service.addAcceptanceCheck("feature-plan-state", async () => (blocked ? refusal : null));
      const validation = await service.validate(scope, resultKey, valid);
      if (!validation.ok) throw new Error("expected a valid result");

      blocked = true;
      expect(await service.submitValidated(scope, resultKey, validation.validatedDigest!)).toEqual({
        ok: false,
        error: refusal,
      });
    });

    for (const transport of ["full", "digest"] as const) {
      for (const lifecycle of ["accepted", "consumed"] as const) {
        test(`an overlapping ${transport} submission replays the ${lifecycle} receipt after a late refusal`, async () => {
          const resultKey = await prepare();
          const validation = await service.validate(scope, resultKey, valid);
          if (!validation.ok) throw new Error("expected a valid result");
          const probe = Promise.withResolvers<typeof refusal | null>();
          let checks = 0;
          service.addAcceptanceCheck("feature-plan-state", () =>
            ++checks === 1 ? probe.promise : Promise.resolve(null),
          );
          const pending =
            transport === "full"
              ? service.submit(scope, resultKey, valid)
              : service.submitValidated(scope, resultKey, validation.validatedDigest!);
          const accepted = await service.submit(scope, resultKey, valid);
          if (!accepted.ok) throw new Error("expected an accepted result");
          if (lifecycle === "consumed") await service.consume(resultKey);
          probe.resolve(refusal);
          expect(await pending).toEqual({ ...accepted, lifecycle, duplicate: true });
        });
      }
    }

    test("an overlapping different result wins over a late refusal with a conflict", async () => {
      const resultKey = await prepare();
      const probe = Promise.withResolvers<typeof refusal | null>();
      let checks = 0;
      service.addAcceptanceCheck("feature-plan-state", () =>
        ++checks === 1 ? probe.promise : Promise.resolve(null),
      );
      const pending = service.submit(scope, resultKey, valid);
      expect(
        await service.submit(scope, resultKey, { ...valid, title: "Different" }),
      ).toMatchObject({ ok: true });
      probe.resolve(refusal);
      expect(await pending).toMatchObject({ ok: false, error: { code: "submission_conflict" } });
    });

    for (const lifecycle of ["cancelled", "superseded"] as const) {
      test(`closing an attempt as ${lifecycle} during the probe wins over refusal`, async () => {
        const resultKey = await prepare();
        const probe = Promise.withResolvers<typeof refusal | null>();
        service.addAcceptanceCheck("feature-plan-state", () => probe.promise);
        const pending = service.submit(scope, resultKey, valid);
        await service.close(resultKey, lifecycle);
        probe.resolve(refusal);
        expect(await pending).toMatchObject({ ok: false, error: { code: "attempt_closed" } });
      });
    }

    for (const identical of [false, true]) {
      for (const refused of [false, true]) {
        test(`an older ${refused ? "refused" : "successful"} validation preserves the newer ${identical ? "identical" : "different"} candidate`, async () => {
          const resultKey = await prepare();
          const probe = Promise.withResolvers<typeof refusal | null>();
          let checks = 0;
          service.addAcceptanceCheck("feature-plan-state", () =>
            ++checks === 1 ? probe.promise : Promise.resolve(null),
          );
          const pending = service.validate(scope, resultKey, valid);
          // A pending probe must never expose a candidate for digest submission.
          expect(service.heldValidation(resultKey)).toBeUndefined();
          const newer = identical ? valid : { ...valid, title: "Newer" };
          const validation = await service.validate(scope, resultKey, newer);
          if (!validation.ok) throw new Error("expected a valid result");
          probe.resolve(refused ? refusal : null);
          expect((await pending).ok).toBe(!refused);
          expect((await service.status(scope, resultKey))?.delivery?.lastValidation).toBe("valid");
          expect(
            await service.submitValidated(scope, resultKey, validation.validatedDigest!),
          ).toMatchObject({ ok: true });
          expect(await service.structured(resultKey)).toMatchObject({ value: newer });
        });
      }
    }

    test("lets the result through when the check throws, and ignores other kinds", async () => {
      const resultKey = await prepare();
      service.addAcceptanceCheck("verification-result", async () => refusal);
      expect(await service.validate(scope, resultKey, valid)).toMatchObject({ ok: true });
      service.addAcceptanceCheck("feature-plan-state", async () => {
        throw new Error("probe failed");
      });
      expect(await service.submit(scope, resultKey, valid)).toMatchObject({ ok: true });
    });

    test("runs every check registered for a kind, each skipping attempts it does not own", async () => {
      const ownedByFirst = await prepare();
      const ownedBySecond = await prepare();
      const unowned = await prepare();
      const asked = { first: [] as string[], second: [] as string[] };
      const blocked = new Set<string>([ownedByFirst, ownedBySecond]);
      const ownerCheck =
        (name: keyof typeof asked, owned: string) => async (attempt: { resultKey: string }) => {
          asked[name].push(attempt.resultKey);
          if (attempt.resultKey !== owned) return null;
          return blocked.has(owned) ? { ...refusal, message: `${name} refuses` } : null;
        };
      service.addAcceptanceCheck("feature-plan-state", ownerCheck("first", ownedByFirst));
      const removeSecond = service.addAcceptanceCheck(
        "feature-plan-state",
        ownerCheck("second", ownedBySecond),
      );

      // Registering a second check did not replace the first: both refuse
      // their own attempt, and neither refuses an attempt it does not own.
      expect(await service.submit(scope, ownedByFirst, valid)).toMatchObject({
        ok: false,
        error: { message: "first refuses" },
      });
      expect(await service.submit(scope, ownedBySecond, valid)).toMatchObject({
        ok: false,
        error: { message: "second refuses" },
      });
      expect(await service.submit(scope, unowned, valid)).toMatchObject({ ok: true });
      expect(asked.first).toEqual([ownedByFirst, ownedBySecond, unowned]);
      expect(asked.second).toEqual([ownedBySecond, unowned]);

      // Removing one registration leaves the other in place.
      removeSecond();
      expect(await service.submit(scope, ownedBySecond, valid)).toMatchObject({ ok: true });
      expect(asked.second).toEqual([ownedBySecond, unowned]);
      blocked.delete(ownedByFirst);
      expect(await service.submit(scope, ownedByFirst, valid)).toMatchObject({ ok: true });
    });

    test("a throwing check does not hide another owner's refusal", async () => {
      const resultKey = await prepare();
      service.addAcceptanceCheck("feature-plan-state", async () => {
        throw new Error("probe failed");
      });
      service.addAcceptanceCheck("feature-plan-state", async () => refusal);
      expect(await service.submit(scope, resultKey, valid)).toEqual({ ok: false, error: refusal });
    });
  });

  test("two simultaneous identical valid calls produce one receipt", async () => {
    const resultKey = await prepare();
    const payload = { phase: "collecting", title: "Same", summary: "" };
    const second = open();
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
    const update = spyOn(StorageDatabase.prototype, "updateStoreRow").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      await expect(
        service.submit(scope, resultKey, { phase: "collecting", title: "A", summary: "" }),
      ).rejects.toThrow("disk full");
    } finally {
      update.mockRestore();
    }

    const reopened = open();
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
    const stored = readStoredValue<{
      entries: Record<string, { context?: unknown; schema?: unknown; rejectedDigests: string[] }>;
    }>(dataDir, STORE)!;
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(256 * 1024);
    expect(service.metrics.snapshot().gauges.retained_bytes).toBeLessThan(256 * 1024);
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
    seedUnreadableStore(dataDir, "workflow-result-tools.json", '{"version":1');
    await expect(service.initializeCapabilityIdentity()).resolves.toBeUndefined();
    const resultKey = await prepare();
    const token = service.capabilityToken(scope, resultKey);
    expect(await service.authenticateCapability(token)).toEqual({
      ...scope,
      workflowResultKey: resultKey,
    });
    expect(readStoredValue(dataDir, "workflow-result-tools.json")).toEqual(
      expect.objectContaining({ version: 1, secret: expect.any(String) }),
    );
  });

  test("two backends starting together agree on one capability identity, and keep the port", async () => {
    const other = open();
    await Promise.all([
      service.initializeCapabilityIdentity(),
      other.initializeCapabilityIdentity(),
    ]);
    const resultKey = await prepare();
    expect(await other.authenticateCapability(service.capabilityToken(scope, resultKey))).toEqual({
      ...scope,
      workflowResultKey: resultKey,
    });
    await service.recordCapabilityPort(4321);
    const restarted = open();
    await restarted.initializeCapabilityIdentity();
    expect(restarted.capabilityPort()).toBe(4321);
    expect(restarted.capabilityToken(scope, resultKey)).toBe(
      service.capabilityToken(scope, resultKey),
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
  describe("database storage", () => {
    const valid = { phase: "collecting", title: "Final", summary: "Complete result." };

    test("polled reads parse one row, never the whole store", async () => {
      await service.initializeCapabilityIdentity();
      const resultKey = await prepare();
      await prepare();
      await service.submit(scope, resultKey, valid);
      const readStore = spyOn(StorageDatabase.prototype, "readStore");
      const readWhole = spyOn(StorageDatabase.prototype, "readStoreValueInTransaction");
      try {
        for (const reader of [service, open()]) {
          expect(await reader.projection(resultKey)).toBe("received");
          expect(await reader.status(scope, resultKey)).toMatchObject({ lifecycle: "accepted" });
          expect(await reader.structured(resultKey)).toMatchObject({ value: valid });
          expect(await reader.registered(resultKey)).toBe(true);
          expect(await reader.lookup(resultKey)).toMatchObject({ registered: true });
          expect(await reader.binding(scope, resultKey)).toMatchObject({ provider: "codex" });
          expect(await reader.validate(scope, resultKey, valid)).toMatchObject({
            error: { code: "attempt_closed" },
          });
        }
        expect(
          await service.authenticateCapability(service.capabilityToken(scope, resultKey)),
        ).toMatchObject({ workflowResultKey: resultKey });
        expect(readStore).not.toHaveBeenCalled();
        expect(readWhole).not.toHaveBeenCalled();
      } finally {
        readStore.mockRestore();
        readWhole.mockRestore();
      }
    });

    test("two backends' interleaved corrections share one budget", async () => {
      const resultKey = await prepare();
      const other = open();
      // Each read-modify-write commits in one transaction, so neither backend
      // overwrites the rejection the other just recorded.
      const outcomes = [];
      for (let title = 0; title < 4; title += 1) {
        const writer = title % 2 === 0 ? service : other;
        outcomes.push(await writer.submit(scope, resultKey, { ...valid, title }));
      }
      expect(outcomes.map((outcome) => !outcome.ok && outcome.error.code)).toEqual([
        "invalid_result",
        "invalid_result",
        "invalid_result",
        "correction_budget_exhausted",
      ]);
      const stored = readStoredValue<StoredValue>(dataDir, STORE)!;
      expect(stored.entries[resultKey]).toMatchObject({ lifecycle: "exhausted" });
      expect((stored.entries[resultKey]!.rejectedDigests as string[]).length).toBe(4);
    });

    test("slots prepared by two backends are both kept and counted", async () => {
      const other = open();
      const first = await prepare();
      const second = crypto.randomUUID();
      await other.prepare({
        resultKey: second,
        kind: "feature-plan-state",
        ...scope,
        provider: "codex",
      });
      const third = await prepare();
      for (const reader of [service, other]) {
        for (const key of [first, second, third]) expect(await reader.registered(key)).toBe(true);
      }
      // The gauges follow the other backend's commit, not only this one's.
      expect(service.metrics.snapshot().gauges.active_slots).toBe(3);
      await other.close(first, "cancelled");
      await service.close(third, "cancelled");
      expect(service.metrics.snapshot().gauges.active_slots).toBe(1);
    });

    test.each(["consume", "close", "deleteByEnvironment"] as const)(
      "%s leaves the payload unrecoverable from the database files",
      async (operation) => {
        const resultKey = await prepare();
        const marker = `private-payload-${crypto.randomUUID()}`;
        await service.submit(scope, resultKey, { ...valid, summary: marker });
        expect(storageFilesContain(dataDir, marker)).toBe(true);
        if (operation === "consume") await service.consume(resultKey);
        else if (operation === "close") await service.close(resultKey, "cancelled");
        else await service.deleteByEnvironment(scope.environmentId);
        expect(storageFilesContain(dataDir, marker)).toBe(false);
      },
    );

    function settledEntry(resultKey: string, updatedAt: string) {
      return {
        resultKey,
        kind: "feature-plan-state",
        ...scope,
        provider: "codex",
        schemaVersion: 1,
        lifecycle: "cancelled",
        createdAt: updatedAt,
        updatedAt,
        rejectedDigests: [],
      };
    }

    test("a full store prunes its oldest settled slot and keeps every active one", async () => {
      const entries: Record<string, unknown> = {};
      const keys = Array.from({ length: WORKFLOW_RESULT_MAX_ENTRIES }, () => crypto.randomUUID());
      keys.forEach((key, index) => {
        entries[key] = settledEntry(key, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
      });
      seedStore(dataDir, STORE, { version: 1, entries });
      const added = await prepare();
      const stored = readStoredValue<StoredValue>(dataDir, STORE)!;
      expect(Object.keys(stored.entries)).toHaveLength(WORKFLOW_RESULT_MAX_ENTRIES);
      expect(stored.entries[keys[0]!]).toBeUndefined();
      expect(stored.entries[keys[1]!]).toBeDefined();
      expect(stored.entries[added]).toMatchObject({ lifecycle: "open" });
      expect(service.metrics.snapshot().gauges.active_slots).toBe(1);
    });

    test("a store of only active slots refuses another and commits nothing", async () => {
      const entries: Record<string, unknown> = {};
      for (let index = 0; index < WORKFLOW_RESULT_MAX_ENTRIES; index += 1) {
        const key = crypto.randomUUID();
        entries[key] = { ...settledEntry(key, new Date(0).toISOString()), lifecycle: "open" };
      }
      seedStore(dataDir, STORE, { version: 1, entries });
      const refused = crypto.randomUUID();
      await expect(prepare(refused)).rejects.toThrow("too many active entries");
      expect(await service.registered(refused)).toBe(false);
      expect(Object.keys(readStoredValue<StoredValue>(dataDir, STORE)!.entries)).toHaveLength(
        WORKFLOW_RESULT_MAX_ENTRIES,
      );
    });

    test("reopens its connection after closeStorage", async () => {
      const resultKey = await prepare();
      service.closeStorage();
      expect(await service.registered(resultKey)).toBe(true);
      await service.close(resultKey, "cancelled");
      expect(await open().status(scope, resultKey)).toMatchObject({ lifecycle: "cancelled" });
    });
  });
});
