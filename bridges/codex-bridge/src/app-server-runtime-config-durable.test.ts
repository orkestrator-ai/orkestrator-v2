import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { BridgeSessionStore, hashCwd } from "./sessions/persistence.js";
import { codexHome, harness } from "./app-server-runtime-test-harness.js";

/**
 * `getConfig().durable` is answered from the session's own record (BR-2). It
 * runs on every Codex `interactiveSnapshot`, so it must not list, chmod and
 * parse every record the way `load()` does.
 */

function recordsDir(): string {
  return join(codexHome, "orkestrator-bridge", `bridge-sessions-${hashCwd("/tmp/ws")}`);
}

function recordPath(bridgeSessionId: string): string {
  return join(recordsDir(), `${createHash("sha256").update(bridgeSessionId).digest("hex")}.json`);
}

async function materializedSession() {
  const h = await harness();
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  await h.runtime.prompt(sessionId, {
    prompt: "materialize",
    requestId: "req-durable",
    attachments: [],
  });
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  await h.drain();
  // The first read may carry the activity heartbeat to disk; later reads within
  // the heartbeat interval do not write, so they observe only what is on disk.
  expect(await h.runtime.getConfig(sessionId)).toMatchObject({ durable: true });
  return { h, sessionId };
}

describe("getConfig durable flag", () => {
  test("reads exactly one record file out of fifty and never loads them all", async () => {
    const { h, sessionId } = await materializedSession();
    const others = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    for (let index = 0; index < 49; index += 1) {
      await others.upsert(
        others.toRecord({
          bridgeSessionId: `other-${index}`,
          threadId: `thread-other-${index}`,
          cwd: "/tmp/ws",
          config: { mode: "build" },
        }),
      );
    }
    expect(await others.load()).toHaveLength(50);

    const load = spyOn(BridgeSessionStore.prototype, "load");
    const readFile = spyOn(fsPromises, "readFile");
    const readdir = spyOn(fsPromises, "readdir");
    try {
      expect(await h.runtime.getConfig(sessionId)).toMatchObject({
        mode: "build",
        durable: true,
      });
      const inRecords = (path: unknown) => String(path).startsWith(recordsDir());
      expect(readFile.mock.calls.map(([path]) => path).filter(inRecords)).toEqual([
        recordPath(sessionId),
      ]);
      expect(readdir.mock.calls.filter(([path]) => inRecords(path))).toEqual([]);
      expect(load).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
      readdir.mockRestore();
      load.mockRestore();
    }
  });

  test("a config that changed after the last write is not durable", async () => {
    const { h, sessionId } = await materializedSession();
    const session = h.runtime.getRegistry().getSession(sessionId)!;
    session.config = { ...session.config, model: "model-not-yet-written" };

    expect(await h.runtime.getConfig(sessionId)).toMatchObject({
      model: "model-not-yet-written",
      durable: false,
    });
  });

  test("a tombstoned or missing record is not durable", async () => {
    const { h, sessionId } = await materializedSession();
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });

    await store.publishRemoval(sessionId);
    expect(await h.runtime.getConfig(sessionId)).toMatchObject({ durable: false });

    await fsPromises.rm(recordPath(sessionId), { force: true });
    expect(await h.runtime.getConfig(sessionId)).toMatchObject({ durable: false });
  });

  test("an expired record is not durable", async () => {
    const { h, sessionId } = await materializedSession();
    const raw = JSON.parse(await fsPromises.readFile(recordPath(sessionId), "utf8")) as Record<
      string,
      unknown
    >;
    await fsPromises.writeFile(
      recordPath(sessionId),
      JSON.stringify({ ...raw, lastAccessed: "2020-01-01T00:00:00.000Z" }),
      "utf8",
    );

    expect(await h.runtime.getConfig(sessionId)).toMatchObject({ durable: false });
  });
});
