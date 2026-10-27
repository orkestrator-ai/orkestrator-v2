import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  schedulePersist,
  setPersistWriteGateForTests,
  settlePersistenceForTests,
} from "./persistence.js";

test("settlement waits for a write queued while the first generation is held", async () => {
  const originalStateDir = process.env.PI_BRIDGE_STATE_DIR;
  const root = await mkdtemp(path.join(tmpdir(), "pi-persistence-settled-"));
  const firstEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const firstRelease = Promise.withResolvers<void>();
  const secondRelease = Promise.withResolvers<void>();
  let writes = 0;
  let settled = false;
  try {
    process.env.PI_BRIDGE_STATE_DIR = root;
    setPersistWriteGateForTests(async () => {
      writes += 1;
      if (writes === 1) {
        firstEntered.resolve();
        await firstRelease.promise;
      } else {
        secondEntered.resolve();
        await secondRelease.promise;
      }
    });
    schedulePersist();
    await firstEntered.promise;
    const settlement = settlePersistenceForTests().then(() => {
      settled = true;
    });
    schedulePersist();
    firstRelease.resolve();
    await secondEntered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    secondRelease.resolve();
    await settlement;
    expect(writes).toBe(2);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")).provider).toBe("pi");
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    // Stop new writes while waiting for every generation that captured root.
    delete process.env.PI_BRIDGE_STATE_DIR;
    await settlePersistenceForTests();
    setPersistWriteGateForTests();
    if (originalStateDir === undefined) delete process.env.PI_BRIDGE_STATE_DIR;
    else process.env.PI_BRIDGE_STATE_DIR = originalStateDir;
    await rm(root, { recursive: true, force: true });
  }
});
