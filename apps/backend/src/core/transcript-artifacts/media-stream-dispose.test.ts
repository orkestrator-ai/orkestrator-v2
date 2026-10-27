import { expect, spyOn, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TranscriptMediaStreams } from "./media-stream.js";

// Hold the actual initialization write, rather than relying on disk timing to
// catch dispose resolving before its constructor's rm/mkdir chain finishes.
test("dispose settles staging initialization before its owner removes the root", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "media-stream-dispose-"));
  const stagingRoot = path.join(root, "staging");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const remove = fs.rm.bind(fs);
  const rmSpy = spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === stagingRoot) {
      entered.resolve();
      await release.promise;
    }
    return remove(...args);
  });
  const streams = new TranscriptMediaStreams({
    server: () => null,
    getEnvironment: async () => null,
    stagingRoot,
    spawnContainerReader: () => {
      throw new Error("no reader should start");
    },
  });
  let disposed = false;
  const disposal = streams.dispose().then(() => {
    disposed = true;
  });
  try {
    await entered.promise;
    // Drain promise continuations while the filesystem write is held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    release.resolve();
    await disposal;
    expect(existsSync(stagingRoot)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(existsSync(root)).toBe(false);
  } finally {
    release.resolve();
    await disposal;
    rmSpy.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
