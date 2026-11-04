import { installFatalRejectionGuard } from "../fatal-rejections.js";
import { Worker } from "node:worker_threads";
import { essentialLogLockFactory } from "./essential-log-lock.js";
import { essentialLogTransactionFactory } from "./essential-log-transaction.js";
import type { EssentialLogBounds } from "./essential-log.js";

/** One transaction in flight; the owner's bounded queue holds all remaining bytes. */
export function createEssentialLogWorker(directory: string, bounds: EssentialLogBounds) {
  // Inline the two self-contained factories: no runtime .ts path or separately
  // packaged worker asset is needed by the bundled Electron and CLI entrypoints.
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    (${installFatalRejectionGuard.toString()})({ label: "[essential-log-worker]" });
    const fs = require("node:fs");
    const path = require("node:path");
    const tryLock = (${essentialLogLockFactory.toString()})(fs, path,
      require("node:crypto").randomUUID, workerData.directory);
    const write = (${essentialLogTransactionFactory.toString()})(fs, path,
      workerData.directory, workerData.bounds);
    parentPort.on("message", ({ payload, state }) => {
      const word = new Int32Array(state);
      if (Atomics.compareExchange(word, 0, 0, 1) !== 0) {
        parentPort.postMessage(null);
        return;
      }
      try {
        const deadline = Date.now() + 2000;
        for (;;) {
          const release = tryLock();
          if (release) {
            try { write(payload); } finally { release(); }
            break;
          }
          if (Date.now() >= deadline) throw new Error("lock busy");
          Atomics.wait(word, 0, 1, 5);
        }
        Atomics.store(word, 0, 2);
      } catch {
        Atomics.store(word, 0, 3);
      }
      Atomics.notify(word, 0);
      parentPort.postMessage(null);
    });
  `;
  let worker: Worker | null = null;
  let dead = false;
  let job: {
    payload: Buffer;
    word: Int32Array;
    committed: () => void;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  const complete = () => {
    if (!job) return;
    const current = job;
    job = null;
    worker?.unref();
    const status = Atomics.load(current.word, 0);
    if (status === 2) current.committed();
    if (status === 3) current.reject(new Error("Essential log worker write failed"));
    else current.resolve();
  };
  const fail = () => {
    dead = true;
    if (job) {
      Atomics.store(job.word, 0, 3);
      complete();
    }
  };

  return {
    write(payload: Buffer, committed: () => void): Promise<void> {
      if (dead) return Promise.reject(new Error("Essential log worker unavailable"));
      if (!worker) {
        worker = new Worker(source, { eval: true, workerData: { directory, bounds } });
        worker.on("message", complete);
        worker.on("error", fail);
        worker.on("exit", fail);
      }
      return new Promise((resolve, reject) => {
        const word = new Int32Array(new SharedArrayBuffer(4));
        job = { payload, word, committed, resolve, reject };
        worker!.ref();
        worker!.postMessage({ payload, state: word.buffer });
      });
    },
    /** Returns only an ambiguous in-flight append, which must never be replayed. */
    settleSync(fallback: (payload: Buffer) => void): Buffer | undefined {
      if (!job) return;
      const current = job;
      Atomics.compareExchange(current.word, 0, 0, 4);
      const deadline = Date.now() + 100;
      while (Atomics.load(current.word, 0) === 1 && Date.now() < deadline) {
        Atomics.wait(current.word, 0, 1, Math.max(1, deadline - Date.now()));
      }
      if (Atomics.load(current.word, 0) === 1) return current.payload;
      if (Atomics.load(current.word, 0) === 4) {
        try {
          fallback(current.payload);
          Atomics.store(current.word, 0, 2);
        } catch {
          Atomics.store(current.word, 0, 3);
        }
      }
      // The normal message callback still settles the promise. Commit now, once,
      // so flushSync excludes a completed write even before that callback runs.
      if (Atomics.load(current.word, 0) === 2) {
        current.committed();
        current.committed = () => {};
      }
      return;
    },
    close() {
      dead = true;
      void worker?.terminate().catch(() => undefined);
    },
  };
}
