/**
 * 4761: the evidence body store syncs a body before its rename and the
 * directory entry before `put` resolves, both awaited off the event loop, and
 * ingestion commits and acknowledges only after that.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { SyncPath } from "./durable-sync.js";
import { bodyIdFor, EvidenceBodyStore } from "./evidence-body-store.js";
import { createHarness, spoolSource, type Harness } from "./service-test-support.js";

const directories: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "ork-evidence-bodies-"));
  directories.push(directory);
  return join(directory, "bodies");
}

const encode = (text: string) => new TextEncoder().encode(text);

function bodyPath(store: string, id: string): string {
  const hex = id.slice("sha256:".length);
  return join(store, hex.slice(0, 2), hex.slice(2));
}

interface SyncEvent {
  path: string;
  kind: "file" | "directory";
  /** For a file: whether its final name already existed when it was synced. */
  namedAlready: boolean;
}

function deferred() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

/** A sync that records each call and, for directories, waits on a gate. */
function recordingSync(directoryGate?: () => Promise<void>) {
  const events: SyncEvent[] = [];
  const sync: SyncPath = async (path, kind) => {
    events.push({
      path,
      kind,
      namedAlready: kind === "file" && existsSync(path.replace(/\.[^.]+\.tmp$/, "")),
    });
    if (kind === "directory" && directoryGate) await directoryGate();
  };
  return { events, sync };
}

const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  // Let the store's own awaits and a timer run.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return done;
};

describe("EvidenceBodyStore.put", () => {
  test("never calls fsyncSync, and the default sync still stores the body", async () => {
    const store = root();
    const bodies = new EvidenceBodyStore(store);
    const fsyncSync = spyOn(fs, "fsyncSync");
    try {
      const bytes = encode("durable body");
      expect(await bodies.put(bodyIdFor(bytes), bytes)).toBe(true);
      expect(fsyncSync).not.toHaveBeenCalled();
      expect(await bodies.get(bodyIdFor(bytes))).toEqual(bytes);
    } finally {
      fsyncSync.mockRestore();
    }
  });

  test("syncs the file before the rename, then the directories, before resolving", async () => {
    const store = root();
    const gate = deferred();
    const { events, sync } = recordingSync(() => gate.promise);
    const bodies = new EvidenceBodyStore(store, true, sync);
    const bytes = encode("first body");
    const id = bodyIdFor(bytes);
    const target = bodyPath(store, id);

    let timerRan = false;
    setTimeout(() => (timerRan = true), 0);
    const put = bodies.put(id, bytes);
    expect(await settled(put)).toBe(false);
    // The loop kept running while the store waited on the directory sync.
    expect(timerRan).toBe(true);
    // The body is named, but `put` waits for its directory entry.
    expect(existsSync(target)).toBe(true);
    expect(events[0]).toMatchObject({ kind: "file", namedAlready: false });
    expect(dirname(events[0]!.path)).toBe(dirname(target));
    expect(basename(events[0]!.path)).toMatch(/\.tmp$/);
    // `mkdir` made the fan-out and the root, so their parents gained entries too.
    expect(
      events
        .filter((event) => event.kind === "directory")
        .map((event) => event.path)
        .sort(),
    ).toEqual([dirname(store), store, dirname(target)].sort());

    gate.release();
    expect(await put).toBe(true);
    expect(readdirSync(dirname(target))).toEqual([basename(target)]);
  });

  test("a body in an existing fan-out syncs only that directory", async () => {
    const store = root();
    const { events, sync } = recordingSync();
    const bodies = new EvidenceBodyStore(store, true, sync);
    const first = encode("one");
    await bodies.put(bodyIdFor(first), first);
    // A second body with the same two-character fan-out.
    let second = encode("two");
    for (let index = 0; bodyIdFor(second).slice(7, 9) !== bodyIdFor(first).slice(7, 9); index++)
      second = encode(`two ${index}`);
    events.length = 0;
    await bodies.put(bodyIdFor(second), second);
    expect(events.map((event) => event.kind)).toEqual(["file", "directory"]);
    expect(events[1]!.path).toBe(dirname(bodyPath(store, bodyIdFor(second))));
  });

  test("a failed file sync rejects and leaves neither the temporary nor a name", async () => {
    const store = root();
    const bodies = new EvidenceBodyStore(store, true, async (_path, kind) => {
      if (kind === "file") throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    const bytes = encode("lost");
    const id = bodyIdFor(bytes);
    await expect(bodies.put(id, bytes)).rejects.toThrow("EIO");
    expect(readdirSync(dirname(bodyPath(store, id)))).toEqual([]);
  });

  test("a failed directory sync rejects, and the next adoption retries it", async () => {
    const store = root();
    let failDirectories = true;
    const synced: string[] = [];
    const bodies = new EvidenceBodyStore(store, true, async (path, kind) => {
      if (kind !== "directory") return;
      if (failDirectories) throw Object.assign(new Error("EIO"), { code: "EIO" });
      synced.push(path);
    });
    const bytes = encode("named, not yet durable");
    const id = bodyIdFor(bytes);
    await expect(bodies.put(id, bytes)).rejects.toThrow("EIO");
    // Still unsynced: adopting it must not report it durable.
    expect(await bodies.reuse(id)).toBe(false);
    failDirectories = false;
    expect(await bodies.put(id, bytes)).toBe(true);
    expect(synced).toContain(dirname(bodyPath(store, id)));
    synced.length = 0;
    // Once synced, adopting it costs no further sync.
    expect(await bodies.reuse(id)).toBe(true);
    expect(synced).toEqual([]);
  });

  test("adopting a body whose directory sync is under way waits for it", async () => {
    const store = root();
    const gate = deferred();
    const { sync } = recordingSync(() => gate.promise);
    const bodies = new EvidenceBodyStore(store, true, sync);
    const bytes = encode("shared");
    const id = bodyIdFor(bytes);
    const first = bodies.put(id, bytes);
    expect(await settled(first)).toBe(false);
    const second = bodies.put(id, bytes);
    const adopted = bodies.reuse(id);
    expect(await settled(second)).toBe(false);
    expect(await settled(adopted)).toBe(false);
    gate.release();
    expect(await Promise.all([first, second, adopted])).toEqual([true, true, true]);
  });

  test("a store that is not durable syncs nothing", async () => {
    const { events, sync } = recordingSync();
    const bodies = new EvidenceBodyStore(root(), false, sync);
    const bytes = encode("test only");
    expect(await bodies.put(bodyIdFor(bytes), bytes)).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("evidence ingestion", () => {
  test("commits a body's row and acknowledges only after put resolves", async () => {
    const h = createHarness({ repo: false });
    harnesses.push(h);
    const spool = new ChangeEvidenceSpool();
    const recorder = new ChangeEvidenceRecorder({
      spool,
      provider: "claude",
      capabilities: {
        resolution: "resolved",
        beforeTurn: "controlled-dispatch",
        afterTurn: "terminal-observed",
        beforeTool: "awaited",
        afterTool: "awaited",
        historicalCallIdentity: "stable",
        fileEvidence: { resolution: "confirmed", kinds: ["replacement"] },
        turnDiff: "absent",
        captureExecutor: "host-worker",
        captureAvailability: "ready",
        backgroundCompletion: "launch-only",
      },
    });
    recorder.tool(
      { conversationId: "s1", callId: "c1" },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "replacement",
            path: "a.ts",
            before: "one\ntwo\n",
            after: "one\nthree\n",
            extent: "fragment",
            origin: "input",
            claim: "proposal",
          },
        ],
      },
    );
    const source = spoolSource(spool);
    const acks: unknown[] = [];
    const ack = source.ack;
    source.ack = async (request) => {
      acks.push(request);
      await ack(request);
    };

    const gate = deferred();
    const put = h.service.bodies.put.bind(h.service.bodies);
    const putIds: string[] = [];
    const puts = spyOn(h.service.bodies, "put").mockImplementation(async (id, bytes) => {
      putIds.push(id);
      await gate.promise;
      return put(id, bytes);
    });
    try {
      const pull = h.service.pullEvidence(source);
      expect(await settled(pull)).toBe(false);
      expect(putIds.length).toBeGreaterThan(0);
      // Nothing names the body and nothing is acknowledged while put is pending.
      expect(h.service.ledger.body(putIds[0]!)).toBeFalsy();
      expect(acks).toEqual([]);
      gate.release();
      await pull;
    } finally {
      puts.mockRestore();
    }
    for (const id of putIds) expect(h.service.ledger.body(id)?.state).toBe("available");
    expect(acks.length).toBeGreaterThan(0);
    expect(acks[0]).toMatchObject({ retainedBodyIds: expect.arrayContaining(putIds) });
  });
});
