import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  abortableDelay,
  downloadArchive,
  partialDownloadPath,
  prunePartialDownloads,
  type DownloadTimings,
  type FetchLike,
} from "./download.js";
import type { ToolchainArchive } from "./manifest.js";

const BODY = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

const archive: ToolchainArchive = {
  format: "raw",
  url: "https://downloads.example.test/tool",
  entryPath: "",
  size: BODY.byteLength,
  sha256: sha256(BODY),
  allowedHosts: ["downloads.example.test"],
};

const fastTimings: DownloadTimings = { idleTimeoutMs: 1_000, attempts: 5, retryDelayMs: 0 };

async function createRoot(): Promise<{ rootDir: string; archivePath: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-download-"));
  directories.push(rootDir);
  const staging = path.join(rootDir, ".staging-tool-1");
  await mkdir(staging);
  return { rootDir, archivePath: path.join(staging, "archive.bin") };
}

type Plan = {
  /** Bytes to send before failing the body; undefined sends everything. */
  cutAt?: number;
  /** Stall after `cutAt` instead of erroring. */
  stall?: boolean;
  /** Answer a range request with the whole body. */
  ignoreRange?: boolean;
  /** Answer with this Content-Range instead of the correct one. */
  contentRange?: string;
  /** Send no Content-Length, so only the streamed bytes can reveal the size. */
  omitLength?: boolean;
};

/** A server honouring `Range:` that follows one plan per request. */
function rangeServer(plans: Plan[] = [], body: Buffer = BODY) {
  const requests: Array<{ range: string | null }> = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("range");
    requests.push({ range });
    const plan = plans[requests.length - 1] ?? {};
    let start = 0;
    let status = 200;
    const responseHeaders: Record<string, string> = {};
    if (range && !plan.ignoreRange) {
      start = Number(/^bytes=(\d+)-$/.exec(range)![1]);
      status = 206;
      responseHeaders["content-range"] =
        plan.contentRange ?? `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`;
    }
    const slice = body.subarray(start);
    if (!plan.omitLength) responseHeaders["content-length"] = String(slice.byteLength);
    const sent = plan.cutAt === undefined ? slice : slice.subarray(0, plan.cutAt);
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      // The interruption comes on the pull after the bytes: erroring a stream
      // discards whatever is still queued in it.
      pull(controller) {
        if (!delivered) {
          delivered = true;
          if (sent.byteLength > 0) {
            controller.enqueue(new Uint8Array(sent));
            return;
          }
        }
        if (plan.cutAt === undefined) controller.close();
        else if (!plan.stall) controller.error(new Error("connection reset"));
        else if (init?.signal?.aborted) controller.error(new Error("aborted"));
        else {
          return new Promise<void>((resolve) =>
            init?.signal?.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
              resolve();
            }),
          );
        }
      },
    });
    return new Response(stream, { status, headers: responseHeaders });
  };
  return { fetchImpl, requests };
}

async function download(
  rootDir: string,
  archivePath: string,
  fetchImpl: FetchLike,
  timings: Partial<DownloadTimings> = {},
  target: ToolchainArchive = archive,
  signal?: AbortSignal,
) {
  const progress: number[] = [];
  await downloadArchive({
    ...(signal ? { signal } : {}),
    label: "tool",
    archive: target,
    archivePath,
    rootDir,
    fetchImpl,
    onBytes: (received) => progress.push(received),
    allowInsecureDownloadsForTests: false,
    timings: { ...fastTimings, ...timings },
  });
  return progress;
}

describe("resumable toolchain downloads", () => {
  test("resumes an interrupted transfer with a range request in the same call", async () => {
    const { rootDir, archivePath } = await createRoot();
    const server = rangeServer([{ cutAt: 1000 }]);

    await download(rootDir, archivePath, server.fetchImpl);

    expect(server.requests).toEqual([{ range: null }, { range: "bytes=1000-" }]);
    expect(await readFile(archivePath)).toEqual(BODY);
    expect(await readdir(path.dirname(partialDownloadPath(rootDir, archive)))).toEqual([]);
  });

  test("keeps the partial across calls and resumes it on the next launch", async () => {
    const { rootDir, archivePath } = await createRoot();
    const first = rangeServer([{ cutAt: 1500 }]);
    await expect(download(rootDir, archivePath, first.fetchImpl, { attempts: 1 })).rejects.toThrow(
      "connection reset",
    );
    expect((await lstat(partialDownloadPath(rootDir, archive))).size).toBe(1500);

    const second = rangeServer();
    const progress = await download(rootDir, archivePath, second.fetchImpl);

    expect(second.requests).toEqual([{ range: "bytes=1500-" }]);
    expect(progress[0]).toBe(1500);
    expect(progress.at(-1)).toBe(BODY.byteLength);
    expect(await readFile(archivePath)).toEqual(BODY);
  });

  test("restarts from zero when the server ignores the range", async () => {
    const { rootDir, archivePath } = await createRoot();
    await mkdir(path.dirname(partialDownloadPath(rootDir, archive)), { recursive: true });
    await writeFile(partialDownloadPath(rootDir, archive), BODY.subarray(0, 700));
    const server = rangeServer([{ ignoreRange: true }]);

    await download(rootDir, archivePath, server.fetchImpl);

    expect(server.requests).toEqual([{ range: "bytes=700-" }]);
    expect(await readFile(archivePath)).toEqual(BODY);
  });

  test("discards the partial when the server resumes at the wrong range", async () => {
    const { rootDir, archivePath } = await createRoot();
    await mkdir(path.dirname(partialDownloadPath(rootDir, archive)), { recursive: true });
    await writeFile(partialDownloadPath(rootDir, archive), BODY.subarray(0, 700));
    const server = rangeServer([
      { contentRange: `bytes 0-${BODY.byteLength - 1}/${BODY.byteLength}` },
    ]);

    await download(rootDir, archivePath, server.fetchImpl);

    expect(server.requests).toEqual([{ range: "bytes=700-" }, { range: null }]);
    expect(await readFile(archivePath)).toEqual(BODY);
  });

  test("discards a rejected range on HTTP 416 and retries from zero", async () => {
    const { rootDir, archivePath } = await createRoot();
    const partial = partialDownloadPath(rootDir, archive);
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(partial, BODY.subarray(0, 700));
    const ranges: Array<string | null> = [];
    const server = rangeServer();
    const fetchImpl: FetchLike = async (input, init) => {
      ranges.push(new Headers(init?.headers).get("range"));
      if (ranges.length === 1) return new Response(null, { status: 416 });
      await expect(lstat(partial)).rejects.toThrow();
      return server.fetchImpl(input, init);
    };

    await download(rootDir, archivePath, fetchImpl);

    expect(ranges).toEqual(["bytes=700-", null]);
    expect(await readFile(archivePath)).toEqual(BODY);
    await expect(lstat(partial)).rejects.toThrow();
  });

  test("re-hashes resumed bytes and starts again when they were damaged", async () => {
    const { rootDir, archivePath } = await createRoot();
    await mkdir(path.dirname(partialDownloadPath(rootDir, archive)), { recursive: true });
    const damaged = Buffer.from(BODY.subarray(0, 900));
    damaged[10] = damaged[10]! ^ 0xff;
    await writeFile(partialDownloadPath(rootDir, archive), damaged);
    const server = rangeServer();

    await download(rootDir, archivePath, server.fetchImpl);

    expect(server.requests).toEqual([{ range: "bytes=900-" }, { range: null }]);
    expect(await readFile(archivePath)).toEqual(BODY);
  });

  test("uses a complete, matching partial without downloading", async () => {
    const { rootDir, archivePath } = await createRoot();
    await mkdir(path.dirname(partialDownloadPath(rootDir, archive)), { recursive: true });
    await writeFile(partialDownloadPath(rootDir, archive), BODY);
    const server = rangeServer();

    await download(rootDir, archivePath, server.fetchImpl);

    expect(server.requests).toEqual([]);
    expect(await readFile(archivePath)).toEqual(BODY);
  });

  test("fails a stalled transfer on the idle timeout and keeps its bytes", async () => {
    const { rootDir, archivePath } = await createRoot();
    const server = rangeServer([{ cutAt: 1200, stall: true }]);

    await expect(
      download(rootDir, archivePath, server.fetchImpl, { idleTimeoutMs: 20, attempts: 1 }),
    ).rejects.toThrow("tool download stalled");
    expect((await lstat(partialDownloadPath(rootDir, archive))).size).toBe(1200);
  });

  test("a slow transfer that keeps arriving is not cut off by a total deadline", async () => {
    const { rootDir, archivePath } = await createRoot();
    const fetchImpl: FetchLike = async () => {
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent >= BODY.byteLength) {
            controller.close();
            return;
          }
          // Each chunk lands well inside the idle timeout, the whole well past it.
          await new Promise((resolve) => setTimeout(resolve, 100));
          controller.enqueue(new Uint8Array(BODY.subarray(sent, sent + 512)));
          sent += 512;
        },
      });
      return new Response(stream, { status: 200 });
    };

    await download(rootDir, archivePath, fetchImpl, { idleTimeoutMs: 500, attempts: 1 });
    expect(await readFile(archivePath)).toEqual(BODY);
  });

  test("does not retry an attempt that made no progress", async () => {
    const { rootDir, archivePath } = await createRoot();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    };
    await expect(download(rootDir, archivePath, fetchImpl)).rejects.toThrow("HTTP 503");
    expect(calls).toBe(1);
  });

  test("retries a request Chromium aborted on a network change before any bytes", async () => {
    const { rootDir, archivePath } = await createRoot();
    const server = rangeServer();
    let calls = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      calls += 1;
      if (calls <= 2) throw new TypeError("net::ERR_NETWORK_CHANGED");
      return server.fetchImpl(input, init);
    };
    await download(rootDir, archivePath, fetchImpl);
    expect(calls).toBe(3);
    expect(await readFile(archivePath)).toEqual(BODY);
  });

  test("a network change still counts against the attempt limit", async () => {
    const { rootDir, archivePath } = await createRoot();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      throw new Error("fetch failed", { cause: new Error("net::ERR_NETWORK_CHANGED") });
    };
    await expect(download(rootDir, archivePath, fetchImpl, { attempts: 3 })).rejects.toThrow(
      "fetch failed",
    );
    expect(calls).toBe(3);
  });

  test("gives up after the attempt limit even while progressing", async () => {
    const { rootDir, archivePath } = await createRoot();
    const server = rangeServer([{ cutAt: 100 }, { cutAt: 100 }, { cutAt: 100 }]);
    await expect(download(rootDir, archivePath, server.fetchImpl, { attempts: 3 })).rejects.toThrow(
      "connection reset",
    );
    expect(server.requests).toHaveLength(3);
    expect((await lstat(partialDownloadPath(rootDir, archive))).size).toBe(300);
  });

  test("deletes the partial when the bytes cannot belong to the pinned archive", async () => {
    const { rootDir, archivePath } = await createRoot();
    const oversized = Buffer.concat([BODY, Buffer.from([1])]);
    const server = rangeServer([{ omitLength: true }], oversized);
    await expect(download(rootDir, archivePath, server.fetchImpl)).rejects.toThrow(
      "exceeded its pinned size",
    );
    await expect(lstat(partialDownloadPath(rootDir, archive))).rejects.toThrow();

    const wrong = Buffer.from(BODY);
    wrong[0] = wrong[0]! ^ 0xff;
    await expect(download(rootDir, archivePath, rangeServer([], wrong).fetchImpl)).rejects.toThrow(
      "checksum did not match",
    );
    await expect(lstat(partialDownloadPath(rootDir, archive))).rejects.toThrow();
  });

  test("prunes only unreferenced partials that have gone unused for a day", async () => {
    const { rootDir } = await createRoot();
    const directory = path.dirname(partialDownloadPath(rootDir, archive));
    await mkdir(directory, { recursive: true });
    const referenced = partialDownloadPath(rootDir, archive);
    const fresh = path.join(directory, `${"a".repeat(64)}.partial`);
    const stale = path.join(directory, `${"b".repeat(64)}.partial`);
    for (const filePath of [referenced, fresh, stale]) await writeFile(filePath, "x");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await utimes(stale, old, old);
    await utimes(referenced, old, old);

    await prunePartialDownloads(rootDir, [archive]);

    expect((await readdir(directory)).sort()).toEqual(
      [path.basename(fresh), path.basename(referenced)].sort(),
    );
  });
});

/** The settled outcome of `promise`, so a test can inspect the error itself. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

describe("cancelling a toolchain download", () => {
  function cancellable(
    rootDir: string,
    archivePath: string,
    fetchImpl: FetchLike,
    timings: DownloadTimings,
    signal: AbortSignal,
    onBytes: (received: number) => void = () => undefined,
  ) {
    return downloadArchive({
      label: "tool",
      archive,
      archivePath,
      rootDir,
      fetchImpl,
      onBytes,
      allowInsecureDownloadsForTests: false,
      timings,
      signal,
    });
  }

  test("an abort mid-transfer rejects as aborted, not stalled, and is not retried", async () => {
    const { rootDir, archivePath } = await createRoot();
    const controller = new AbortController();
    const server = rangeServer([{ cutAt: 1200, stall: true }]);

    const error = await failureOf(
      cancellable(
        rootDir,
        archivePath,
        server.fetchImpl,
        // Only the abort can end this attempt: the idle timeout is far away.
        { idleTimeoutMs: 60_000, attempts: 5, retryDelayMs: 0 },
        controller.signal,
        (received) => {
          if (received === 1200) controller.abort("SIGINT");
        },
      ),
    );

    expect(error.name).toBe("AbortError");
    expect(error.message).not.toContain("stalled");
    expect(server.requests).toHaveLength(1);
    // The bytes stay for the next run to resume, as for any interruption.
    expect((await lstat(partialDownloadPath(rootDir, archive))).size).toBe(1200);
    await expect(lstat(archivePath)).rejects.toThrow();
  });

  test("an abort during the retry delay ends the delay and does not retry", async () => {
    const { rootDir, archivePath } = await createRoot();
    const controller = new AbortController();
    const server = rangeServer([{ cutAt: 1200 }]);
    const fetchImpl: FetchLike = async (input, init) => {
      // The first attempt fails with progress, so a retry is due after a
      // minute; abort while that delay runs.
      setTimeout(() => controller.abort("SIGINT"), 50);
      return server.fetchImpl(input, init);
    };

    const startedAt = Date.now();
    const error = await failureOf(
      cancellable(
        rootDir,
        archivePath,
        fetchImpl,
        { idleTimeoutMs: 60_000, attempts: 5, retryDelayMs: 60_000 },
        controller.signal,
      ),
    );

    expect(error.name).toBe("AbortError");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(server.requests).toHaveLength(1);
  });

  test("an already-aborted signal makes no request", async () => {
    const { rootDir, archivePath } = await createRoot();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by the caller"));
    const server = rangeServer();

    const error = await failureOf(
      cancellable(rootDir, archivePath, server.fetchImpl, fastTimings, controller.signal),
    );

    expect(error.message).toBe("cancelled by the caller");
    expect(server.requests).toHaveLength(0);
  });

  test("the idle timeout is still reported as a stall when a signal is passed", async () => {
    const { rootDir, archivePath } = await createRoot();
    const server = rangeServer([{ cutAt: 1200, stall: true }]);

    await expect(
      cancellable(
        rootDir,
        archivePath,
        server.fetchImpl,
        { idleTimeoutMs: 20, attempts: 1, retryDelayMs: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("tool download stalled");
  });

  test("abortableDelay resolves on time and rejects at once when aborted", async () => {
    await abortableDelay(1);
    await abortableDelay(1, new AbortController().signal);

    const controller = new AbortController();
    const pending = abortableDelay(60_000, controller.signal);
    controller.abort("SIGTERM");
    const error = await failureOf(pending);
    expect(error.name).toBe("AbortError");
    expect(error.message).toContain("SIGTERM");

    await expect(abortableDelay(60_000, controller.signal)).rejects.toThrow("SIGTERM");
  });
});
