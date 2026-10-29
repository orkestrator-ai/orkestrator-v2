/**
 * Transcript media pins keep the first bytes a message showed: later reads
 * never touch the file, each message keeps its own version, and the store
 * stays within its byte and pin bounds by answering live instead.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TranscriptMediaPins, type TranscriptMediaPinIdentity } from "./transcript-media-pins.js";

let root: string;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

function identity(messageId: string, reference = "host:/w/shot.png"): TranscriptMediaPinIdentity {
  return { environmentId: "env-1", logicalSessionKey: "tab-1", messageId, reference };
}

/** A file whose contents the test can change between reads. */
function file(initial: string) {
  let contents = initial;
  let reads = 0;
  return {
    write: (next: string) => {
      contents = next;
    },
    get reads() {
      return reads;
    },
    read: async () => {
      reads += 1;
      return { bytes: bytes(contents), modifiedAt: "2026-10-29T10:00:00.000Z" };
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-media-pins-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("TranscriptMediaPins", () => {
  test("keeps the first bytes after the file is overwritten", async () => {
    const pins = new TranscriptMediaPins(root, { now: () => Date.parse("2026-10-29T10:00:05Z") });
    const shot = file("round 1");
    const first = await pins.pin(identity("m1"), shot.read);
    expect(first).toMatchObject({
      status: "pinned",
      capturedAt: "2026-10-29T10:00:05.000Z",
      fileModifiedAt: "2026-10-29T10:00:00.000Z",
    });
    expect(text(first.bytes)).toBe("round 1");

    shot.write("round 2");
    const again = await pins.pin(identity("m1"), shot.read);
    expect(text(again.bytes)).toBe("round 1");
    expect(again.status).toBe("pinned");
    expect(shot.reads).toBe(1);

    // A fresh store (a backend restart) reads the same saved copy.
    const restarted = await new TranscriptMediaPins(root).pin(identity("m1"), shot.read);
    expect(text(restarted.bytes)).toBe("round 1");
    expect(shot.reads).toBe(1);
  });

  test("each message keeps its own version of the same file", async () => {
    const pins = new TranscriptMediaPins(root);
    const shot = file("round 1");
    await pins.pin(identity("m1"), shot.read);
    shot.write("round 2");
    expect(text((await pins.pin(identity("m2"), shot.read)).bytes)).toBe("round 2");
    expect(text((await pins.pin(identity("m1"), shot.read)).bytes)).toBe("round 1");
    expect(text((await pins.pin(identity("m2"), shot.read)).bytes)).toBe("round 2");
  });

  test("stores identical bytes once", async () => {
    const pins = new TranscriptMediaPins(root);
    const shot = file("same");
    await pins.pin(identity("m1"), shot.read);
    await pins.pin(identity("m2"), shot.read);
    const [environment] = await readdir(root);
    expect(await readdir(path.join(root, environment!, "blobs"))).toHaveLength(1);
    expect(await readdir(path.join(root, environment!, "pins"))).toHaveLength(2);
  });

  test("concurrent first reads of one pin share a single file read", async () => {
    const pins = new TranscriptMediaPins(root);
    const shot = file("once");
    const results = await Promise.all([
      pins.pin(identity("m1"), shot.read),
      pins.pin(identity("m1"), shot.read),
    ]);
    expect(results.map((result) => text(result.bytes))).toEqual(["once", "once"]);
    expect(shot.reads).toBe(1);
  });

  test("concurrent distinct pins cannot exceed the byte quota", async () => {
    const pins = new TranscriptMediaPins(root, { maxEnvironmentBytes: 4 });
    const results = await Promise.all([
      pins.pin(identity("m1"), file("aaaa").read),
      pins.pin(identity("m2"), file("bbbb").read),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["live", "pinned"]);
    expect(results.find(({ status }) => status === "live")?.reason).toBe("quota");
    const [environment] = await readdir(root);
    const blobs = await readdir(path.join(root, environment!, "blobs"));
    expect(blobs).toHaveLength(1);
    expect((await readFile(path.join(root, environment!, "blobs", blobs[0]!))).byteLength).toBe(4);
    expect(await readdir(path.join(root, environment!, "pins"))).toHaveLength(2);
  });

  test("concurrent distinct pins cannot exceed the pin quota", async () => {
    const pins = new TranscriptMediaPins(root, { maxEnvironmentPins: 1 });
    const results = await Promise.all([
      pins.pin(identity("m1"), file("a").read),
      pins.pin(identity("m2"), file("b").read),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["live", "pinned"]);
    const [environment] = await readdir(root);
    expect(await readdir(path.join(root, environment!, "pins"))).toHaveLength(1);
    expect(await readdir(path.join(root, environment!, "blobs"))).toHaveLength(1);
  });

  test("concurrent identical content is charged once, leaving capacity for another blob", async () => {
    const pins = new TranscriptMediaPins(root, { maxEnvironmentBytes: 8 });
    const results = await Promise.all([
      pins.pin(identity("m1"), file("same").read),
      pins.pin(identity("m2"), file("same").read),
    ]);
    expect(results.every(({ status }) => status === "pinned")).toBe(true);
    expect((await pins.pin(identity("m3"), file("next").read)).status).toBe("pinned");
    expect((await pins.pin(identity("m4"), file("overflow").read)).status).toBe("live");
    const [environment] = await readdir(root);
    expect(await readdir(path.join(root, environment!, "blobs"))).toHaveLength(2);
    expect(await readdir(path.join(root, environment!, "pins"))).toHaveLength(4);
  });

  test("over the byte bound, answers live and keeps answering live", async () => {
    const pins = new TranscriptMediaPins(root, { maxEnvironmentBytes: 10 });
    const small = file("fits");
    expect((await pins.pin(identity("m1"), small.read)).status).toBe("pinned");

    const large = file("does not fit");
    const live = await pins.pin(identity("m2"), large.read);
    expect(live).toMatchObject({ status: "live", reason: "quota" });
    expect(text(live.bytes)).toBe("does not fit");

    // Recorded without bytes: later reads show the file as it is then.
    large.write("changed");
    const later = await pins.pin(identity("m2"), large.read);
    expect(later).toMatchObject({ status: "live", reason: "quota" });
    expect(text(later.bytes)).toBe("changed");
  });

  test("over the pin bound, answers live without recording anything", async () => {
    const pins = new TranscriptMediaPins(root, { maxEnvironmentPins: 1 });
    await pins.pin(identity("m1"), file("a").read);
    expect(await pins.pin(identity("m2"), file("b").read)).toMatchObject({
      status: "live",
      reason: "quota",
    });
    const [environment] = await readdir(root);
    expect(await readdir(path.join(root, environment!, "pins"))).toHaveLength(1);
  });

  test("a missing saved copy answers live and is never re-pinned to newer bytes", async () => {
    const pins = new TranscriptMediaPins(root);
    const shot = file("original");
    await pins.pin(identity("m1"), shot.read);
    const [environment] = await readdir(root);
    await rm(path.join(root, environment!, "blobs"), { recursive: true });

    shot.write("newer");
    const read = await pins.pin(identity("m1"), shot.read);
    expect(read).toMatchObject({ status: "live", reason: "missing" });
    expect(text(read.bytes)).toBe("newer");
    expect(await readdir(path.join(root, environment!, "blobs")).catch(() => [])).toEqual([]);
  });

  test.each(["{broken", "", "null", '{"schemaVersion":2}', '{"stored":true}'])(
    "an invalid existing record stays untouched (%s)",
    async (corrupt) => {
      const pins = new TranscriptMediaPins(root);
      const shot = file("original");
      await pins.pin(identity("m1"), shot.read);
      const [environment] = await readdir(root);
      const directory = path.join(root, environment!, "pins");
      const [record] = await readdir(directory);
      const recordPath = path.join(directory, record!);
      await writeFile(recordPath, corrupt);
      shot.write("newer");
      for (const store of [pins, new TranscriptMediaPins(root)]) {
        const result = await store.pin(identity("m1"), shot.read);
        expect(result).toMatchObject({ status: "live", reason: "missing" });
        expect(text(result.bytes)).toBe("newer");
        expect(await readFile(recordPath, "utf8")).toBe(corrupt);
      }
    },
  );

  test.each([false, true])(
    "deletion drains an active write, including failure (%s)",
    async (fail) => {
      const pins = new TranscriptMediaPins(root);
      const reached = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const originalMkdir = fs.mkdir;
      let environment = "";
      const mkdirSpy = spyOn(fs, "mkdir").mockImplementation((async (
        ...args: Parameters<typeof fs.mkdir>
      ) => {
        const result = await originalMkdir(...args);
        if (String(args[0]).endsWith("/pins")) {
          environment = path.dirname(String(args[0]));
          reached.resolve();
          await resume.promise;
        }
        return result;
      }) as typeof fs.mkdir);
      const writing = pins.pin(identity("m1"), file("private image").read);
      // Attach rejection handling before releasing a failing write.
      const settled = Promise.allSettled([writing]);
      try {
        await reached.promise;
        const deleting = pins.deleteEnvironment("env-1");
        const late = pins.pin(identity("late"), file("late bytes").read);
        if (fail) {
          // Force the record write to fail after the blob has been saved.
          await rm(path.join(environment, "pins"), { recursive: true });
        }
        resume.resolve();
        await deleting;
        expect((await settled)[0]?.status).toBe(fail ? "rejected" : "fulfilled");
        expect(await late).toMatchObject({ status: "live", reason: "missing" });
        expect(await readdir(root)).toEqual([]);
        await pins.deleteEnvironment("env-1");
        expect((await pins.pin(identity("after"), file("later").read)).status).toBe("live");
        expect(await readdir(root)).toEqual([]);
      } finally {
        resume.resolve();
        await settled;
        mkdirSpy.mockRestore();
      }
    },
  );

  test("environment deletion removes its pins and nothing else", async () => {
    const pins = new TranscriptMediaPins(root);
    await pins.pin(identity("m1"), file("one").read);
    await pins.pin({ ...identity("m1"), environmentId: "env-2" }, file("two").read);
    expect(await readdir(root)).toHaveLength(2);

    await pins.deleteEnvironment("env-1");
    expect(await readdir(root)).toHaveLength(1);
    const kept = await pins.pin({ ...identity("m1"), environmentId: "env-2" }, file("x").read);
    expect(text(kept.bytes)).toBe("two");
  });

  test("read errors propagate and record nothing", async () => {
    const pins = new TranscriptMediaPins(root);
    await expect(
      pins.pin(identity("m1"), async () => {
        throw new Error("Invalid file path: file is outside Orkestrator workspace storage");
      }),
    ).rejects.toThrow("outside Orkestrator workspace storage");
    expect(text((await pins.pin(identity("m1"), file("later").read)).bytes)).toBe("later");
  });
});
