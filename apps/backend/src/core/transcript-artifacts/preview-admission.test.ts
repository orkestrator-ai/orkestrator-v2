import { describe, expect, test } from "bun:test";
import path from "node:path";

import { PREVIEW_ADMISSION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { ArtifactFailure } from "@orkestrator/protocol/transcript-artifacts";

import type { PreviewJob, PreviewJobResult } from "./contracts.js";
import { isAlive, listProcesses } from "./preview-process-tree.js";
import { TranscriptPreviewRunner, type PreviewRunnerOptions } from "./preview-runner.js";

const FAKE_WORKER = path.join(import.meta.dir, "fixtures", "fake-preview-worker.ts");

function createRunner(options: Partial<PreviewRunnerOptions> = {}) {
  return new TranscriptPreviewRunner({
    isolation: "process",
    executablePath: () => "/bin/sh",
    workerCommand: () => ({
      command: process.execPath,
      args: [FAKE_WORKER, `--fake-launcher-pid=${process.pid}`],
    }),
    ...options,
  });
}

type CreateRunner = typeof createRunner;

/**
 * Each test owns its runner (queues, admission counters and worker processes)
 * and closes exactly that runner, so the tests run concurrently.
 */
function admissionTest(
  name: string,
  run: (create: CreateRunner) => Promise<void>,
  timeoutMs?: number,
): void {
  test.concurrent(
    name,
    async () => {
      const runners: TranscriptPreviewRunner[] = [];
      const create: CreateRunner = (options) => {
        const made = createRunner(options);
        runners.push(made);
        return made;
      };
      try {
        await run(create);
      } finally {
        await Promise.all(runners.map((made) => made.close()));
      }
    },
    timeoutMs,
  );
}

const job = (source: string): PreviewJob => ({ kind: "mermaid", source, theme: "light" });
let operation = 0;
const scope = (environmentId: string, conversationKey = `c${++operation}`) => ({
  environmentId,
  conversationKey,
  operationId: `op_test${String(++operation).padStart(8, "0")}`,
});

async function capacityError(promise: Promise<PreviewJobResult>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactFailure);
    return (error as ArtifactFailure).error;
  }
  throw new Error("expected a capacity rejection");
}

describe("preview admission", () => {
  admissionTest(
    "rejects over-capacity work with a typed error naming the exhausted resource",
    async (create) => {
      const target = create({ admission: { runningGlobal: 1, runningPerEnvironment: 1 } });
      const signal = new AbortController().signal;
      const pending: Promise<PreviewJobResult>[] = [];
      // One running plus eight queued for env-a fills its queue.
      for (let index = 0; index < 1 + PREVIEW_ADMISSION_POLICY.queuedPerEnvironment; index++) {
        pending.push(target.run(job("sleep:50"), scope("env-a"), signal));
      }
      const envFull = await capacityError(target.run(job("sleep:1"), scope("env-a"), signal));
      expect(envFull).toMatchObject({
        code: "capacity_exceeded",
        resource: "environment-queue",
        retryClass: "transient",
      });
      for (
        let index = 0;
        index <
        PREVIEW_ADMISSION_POLICY.queuedGlobal - PREVIEW_ADMISSION_POLICY.queuedPerEnvironment;
        index++
      ) {
        pending.push(target.run(job("sleep:1"), scope(`env-${index}`), signal));
      }
      const globalFull = await capacityError(target.run(job("sleep:1"), scope("env-new"), signal));
      expect(globalFull.resource).toBe("global-queue");
      expect(target.stats().queued).toBe(PREVIEW_ADMISSION_POLICY.queuedGlobal);
      const results = await Promise.all(pending);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(target.stats()).toMatchObject({ queued: 0, queuedBytes: 0 });
    },
    60_000,
  );

  admissionTest(
    "limits nonterminal operations per conversation and queued metadata bytes",
    async (create) => {
      const target = create({ admission: { queuedMetadataBytesGlobal: 1_000 } });
      const signal = new AbortController().signal;
      // Two nonterminal operations (one running, one queued) in one conversation.
      const first = target.run(job("sleep:200"), scope("env-a", "conv"), signal);
      const second = target.run(job("sleep:200"), scope("env-a", "conv"), signal);
      expect(
        (await capacityError(target.run(job("sleep:1"), scope("env-a", "conv"), signal))).resource,
      ).toBe("conversation-operations");
      // The same conversation key in another environment is a different conversation.
      const other = target.run(job("sleep:1"), scope("env-b", "conv"), signal);
      // Queued bytes count only unstarted work: env-a's second job (9 bytes) is queued.
      const big = "x".repeat(1_000);
      const bytes = await capacityError(target.run(job(big), scope("env-a", "conv2"), signal));
      expect(bytes.resource).toBe("queued-metadata-bytes");
      expect(target.stats().queuedBytes).toBe("sleep:200".length);
      const results = await Promise.all([first, second, other]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(target.stats().queuedBytes).toBe(0);
    },
    30_000,
  );

  admissionTest(
    "dequeues fairly across environments",
    async (create) => {
      const target = create({ admission: { runningGlobal: 1, nonterminalPerConversation: 8 } });
      const signal = new AbortController().signal;
      const order: string[] = [];
      const track = (label: string, environmentId: string) =>
        target.run(job("sleep:20"), scope(environmentId, "same"), signal).then((result) => {
          order.push(label);
          return result;
        });
      const all = [
        track("a1", "env-a"),
        track("a2", "env-a"),
        track("a3", "env-a"),
        track("b1", "env-b"),
        track("c1", "env-c"),
        track("b2", "env-b"),
      ];
      await Promise.all(all);
      // a1 was already running; then the least recently served environment wins each slot.
      expect(order).toEqual(["a1", "b1", "c1", "a2", "b2", "a3"]);
    },
    30_000,
  );

  admissionTest(
    "queue wait expiry resolves once with a retryable capacity error",
    async (create) => {
      const target = create({ admission: { runningGlobal: 1 }, budgets: { queueWaitMs: 150 } });
      const signal = new AbortController().signal;
      const running = target.run(job("sleep:600"), scope("env-a"), signal);
      const waiting = await target.run(job("sleep:1"), scope("env-b"), signal);
      expect(waiting.ok).toBe(false);
      if (!waiting.ok)
        expect(waiting.error).toMatchObject({ code: "capacity_exceeded", resource: "queue-wait" });
      expect((await running).ok).toBe(true);
    },
    30_000,
  );

  admissionTest(
    "cancels queued and running work exactly once and kills the running tree",
    async (create) => {
      const target = create({ admission: { runningGlobal: 1 } });
      const runningController = new AbortController();
      const queuedController = new AbortController();
      const running = target.run(job("spawn-child"), scope("env-a"), runningController.signal);
      const queued = target.run(job("sleep:1"), scope("env-b"), queuedController.signal);
      await new Promise((resolve) => setTimeout(resolve, 500));
      queuedController.abort();
      const queuedResult = await queued;
      expect(queuedResult.ok).toBe(false);
      if (!queuedResult.ok) expect(queuedResult.error.code).toBe("cancelled");
      runningController.abort();
      const runningResult = await running;
      expect(runningResult.ok).toBe(false);
      if (!runningResult.ok) expect(runningResult.error.code).toBe("cancelled");
      // Capacity is released only after the tree (including the TERM-ignoring grandchild) is gone.
      const deadline = Date.now() + 8_000;
      while (target.stats().running > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(target.stats().running).toBe(0);
      expect(target.stats().unverifiedExits).toBe(0);
      const next = await target.run(job("sleep:1"), scope("env-c"), new AbortController().signal);
      expect(next.ok).toBe(true);
    },
    30_000,
  );

  admissionTest(
    "a hung worker is killed at the wall deadline with its whole tree",
    async (create) => {
      const exits: Array<{
        verified: boolean;
        browserPid: number | null;
        workerPid: number | null;
      }> = [];
      const target = create({
        budgets: { workerWallMs: 700, cleanupGraceMs: 200 },
        onWorkerExit: (report) => exits.push(report),
      });
      const started = Date.now();
      const result = await target.run(
        job("spawn-child"),
        scope("env-a"),
        new AbortController().signal,
      );
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({ code: "render_timeout", resource: "wall" });
      expect(elapsed).toBeLessThan(700 + 1_500);
      const deadline = Date.now() + 8_000;
      while (target.stats().running > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(target.stats().running).toBe(0);
      expect(exits).toHaveLength(1);
      expect(exits[0]!.verified).toBe(true);
      const processes = await listProcesses();
      // The TERM-ignoring grandchild (reported as the "browser") and the worker are both gone.
      expect(exits[0]!.browserPid).toBeGreaterThan(0);
      expect(isAlive(exits[0]!.browserPid!, processes)).toBe(false);
      expect(isAlive(exits[0]!.workerPid!, processes)).toBe(false);
    },
    30_000,
  );

  admissionTest("reports unavailable isolation before admitting work", async (create) => {
    const target = create({ executablePath: () => undefined });
    expect(target.status()).toMatchObject({ available: false, isolation: "unavailable" });
    const error = await capacityError(
      target.run(job("sleep:1"), scope("env-a"), new AbortController().signal),
    );
    expect(error.code).toBe("renderer_unavailable");
  });
});
