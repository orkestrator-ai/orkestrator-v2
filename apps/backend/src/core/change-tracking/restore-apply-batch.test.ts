import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocationCount } from "@orkestrator/protocol/node/command-capture";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import { HostCaptureExecutor } from "./capture.js";
import { objectId } from "./object-store.js";
import {
  containerConditionalWrites,
  hostConditionalWrites,
  parseConditionalWriteResults,
  RESTORE_WRITE_BATCH_GROUPS,
  RESTORE_WRITE_BATCH_BYTES,
  type ConditionalWriteOutcome,
  type ConditionalWriteItem,
} from "./restore.js";
import { createHarness, type Harness } from "./service-test-support.js";
import type { WorktreeChangeOwner } from "./worktree-owner.js";
import type { ReadRecord } from "./capture.js";
import { turnIdFor } from "./turn-boundaries.js";

/**
 * Restore apply writes through one helper process per batch of groups
 * (todo 7555) instead of one per file. These pin that the batch keeps every
 * per-file check, that a rename's two ends stay one unit inside a batch, and
 * that a helper which dies part-way reports exactly what it wrote.
 */

const directories: string[] = [];
const harnesses: Harness[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const harness of harnesses.splice(0)) harness.cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temp(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * A PATH shim for `docker exec -i <id> node -e <helper>` that runs the helper
 * with the local node. `prelude` is JavaScript run before the helper in the
 * same process, so a test can make the helper die at an exact point.
 */
function installDockerShim(prelude = ""): void {
  const bin = temp("ork-docker-shim-");
  const shim = join(bin, "docker");
  writeFileSync(
    shim,
    `#!/bin/sh\nshift\nif [ "$1" = "-i" ]; then shift; fi\nshift\nexec "$1" "$2" '${prelude}'"$3"\n`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
}

const encode = (text: string) => new TextEncoder().encode(text);
const oid = (text: string) => objectId("blob", encode(text));

function root(files: Record<string, string>): string {
  const directory = temp("ork-restore-batch-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  return directory;
}

/** Delete `name`, which must still hold `content`. */
function deleteItem(name: string, content: string, group?: string): ConditionalWriteItem {
  return {
    action: {
      pathId: `u:${name}`,
      expectedOid: oid(content),
      expectedMode: "100644",
      targetBlob: null,
      mode: null,
    },
    bytes: null,
    ...(group !== undefined ? { group } : {}),
  };
}

for (const executor of ["host", "container"] as const) {
  const writes = (directory: string, items: ConditionalWriteItem[]) =>
    executor === "host"
      ? hostConditionalWrites(directory, items)
      : containerConditionalWrites("fake", directory, items);

  describe(`${executor} batched restore helper`, () => {
    test("checks every write on its own and answers one outcome per write, in order", async () => {
      installDockerShim();
      const directory = root({
        "keep.txt": "edited by the user\n",
        "gone.txt": "agent\n",
        "nested/back.txt": "agent wrote this\n",
      });
      const results = await writes(directory, [
        deleteItem("gone.txt", "agent\n"),
        // The user edited it since the preview: skipped, never overwritten.
        deleteItem("keep.txt", "agent\n"),
        { ...deleteItem("../escape.txt", "x"), bytes: null },
        {
          action: {
            pathId: "u:nested/back.txt",
            expectedOid: oid("agent wrote this\n"),
            expectedMode: "100644",
            targetBlob: "before",
            mode: "100755",
          },
          bytes: encode("before\n"),
        },
        {
          action: {
            pathId: "u:new/dir/created.txt",
            expectedOid: null,
            expectedMode: null,
            targetBlob: "before",
            mode: "100644",
          },
          bytes: encode("created\n"),
        },
      ]);
      expect(results).toEqual(["applied", "precondition-failed", "failed", "applied", "applied"]);
      expect(existsSync(join(directory, "gone.txt"))).toBe(false);
      expect(readFileSync(join(directory, "keep.txt"), "utf8")).toBe("edited by the user\n");
      expect(readFileSync(join(directory, "nested/back.txt"), "utf8")).toBe("before\n");
      expect(readFileSync(join(directory, "new/dir/created.txt"), "utf8")).toBe("created\n");
    });

    test("a group stops at its first write that is not applied, leaving the rest untouched", async () => {
      installDockerShim();
      const directory = root({ "renamed.txt": "moved\n", "other.txt": "agent\n" });
      // Rename back: restore old.txt, guarded by renamed.txt, then delete
      // renamed.txt. The guard no longer matches, so neither end is touched.
      const guardMoved = {
        action: {
          pathId: "u:old.txt",
          expectedOid: null,
          expectedMode: null,
          targetBlob: "before",
          mode: "100644",
          guard: {
            pathId: "u:renamed.txt",
            expectedOid: oid("not moved\n"),
            expectedMode: "100644",
          },
        },
        bytes: encode("old\n"),
        group: "0",
      };
      const results = await writes(directory, [
        guardMoved,
        deleteItem("renamed.txt", "moved\n", "0"),
        deleteItem("other.txt", "agent\n", "1"),
      ]);
      expect(results).toEqual(["precondition-failed", "failed", "applied"]);
      expect(existsSync(join(directory, "old.txt"))).toBe(false);
      expect(readFileSync(join(directory, "renamed.txt"), "utf8")).toBe("moved\n");
      expect(existsSync(join(directory, "other.txt"))).toBe(false);
    });

    test("an unusable root fails every write", async () => {
      installDockerShim();
      const missing = join(temp("ork-restore-batch-"), "missing");
      expect(await writes(missing, [deleteItem("a.txt", "a"), deleteItem("b.txt", "b")])).toEqual([
        "failed",
        "failed",
      ]);
    });
  });
}

test("a helper that dies part-way reports exactly the writes it completed", async () => {
  // The helper is killed just before its third delete, as an OOM kill or a
  // container stop would. Its first two lines are already written.
  installDockerShim(
    'const fs_=require("node:fs"),unlink_=fs_.unlinkSync;let n_=0;fs_.unlinkSync=(...a)=>{if(++n_===3)process.kill(process.pid,"SIGKILL");return unlink_.apply(fs_,a);};',
  );
  const names = ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"];
  const directory = root(Object.fromEntries(names.map((name) => [name, `${name}\n`])));
  const results = await containerConditionalWrites(
    "fake",
    directory,
    names.map((name, index) => deleteItem(name, `${name}\n`, String(index))),
  );
  expect(results).toEqual(["applied", "applied", "failed", "failed", "failed"]);
  expect(names.map((name) => existsSync(join(directory, name)))).toEqual([
    false,
    false,
    true,
    true,
    true,
  ]);
});

test("result lines that are torn, out of range or unknown answer failed", () => {
  const stdout = [
    '{"i":0,"result":"applied"}',
    '{"i":7,"result":"applied"}',
    '{"i":1,"result":"overwritten"}',
    '{"i":2,"result":"precondition-failed"}',
    '{"i":3,"res',
  ].join("\n");
  expect(parseConditionalWriteResults(stdout, 4)).toEqual([
    "applied",
    "failed",
    "precondition-failed",
    "failed",
  ]);
  expect(parseConditionalWriteResults("", 2)).toEqual(["failed", "failed"]);
});

async function addFilesInTurn(h: Harness, count: number): Promise<ChangeMeasurement> {
  const identity = { environmentId: "env-1", logicalSessionKey: "env-env-1:tab" };
  await h.service.prepareTurnStart({ ...identity, requestId: "bulk", provider: "claude" });
  h.service.markTurnDispatched("env-1", "env-env-1:tab", "bulk", "accepted");
  mkdirSync(join(h.repo, "bulk"));
  for (let index = 0; index < count; index++)
    writeFileSync(join(h.repo, "bulk", `f${index}.txt`), `${index}\n`);
  await h.service.finalizeTurn({ ...identity, requestId: "bulk" });
  const measurement = h.service.ledger.latestMeasurement(
    "turn",
    turnIdFor("env-1", "env-env-1:tab", "bulk"),
    "turn-net",
  );
  if (!measurement) throw new Error("no turn measurement");
  return measurement;
}

describe("restore apply batching", () => {
  test("writes a bulk restore through one helper and one destination check per batch", async () => {
    const files = RESTORE_WRITE_BATCH_GROUPS * 2 + 1;
    const h = createHarness();
    harnesses.push(h);
    const turn = await addFilesInTurn(h, files);
    const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    // The user edits one file after the preview: only that one is skipped.
    writeFileSync(join(h.repo, "bulk", "f7.txt"), "the user's edit\n");
    const describe = spyOn(HostCaptureExecutor.prototype, "describe");
    const helpersBefore = commandInvocationCount(process.execPath);
    try {
      const applied = await h.service.restore.apply({
        actionToken: preview.actionToken,
        idempotencyKey: "bulk",
      });
      if (applied.kind !== "applied") throw new Error(`expected applied, got ${applied.kind}`);
      expect(applied.outcome).toBe("partial");
      expect(applied.failedPathIds).toEqual(["u:bulk/f7.txt"]);
      expect(applied.completedPathIds).toHaveLength(files - 1);
      // Three batches: 500, 500 and 1 groups, each one helper process.
      expect(commandInvocationCount(process.execPath) - helpersBefore).toBe(3);
      // Host destination bodies are read one at a time; writes stay batched.
      const checks = describe.mock.calls.filter(([, limits]) => limits.readers === 1);
      expect(checks.length).toBeGreaterThanOrEqual(files);
      expect(checks.every(([paths]) => paths.length === 1)).toBe(true);
    } finally {
      describe.mockRestore();
    }
    expect(readFileSync(join(h.repo, "bulk", "f7.txt"), "utf8")).toBe("the user's edit\n");
    const left = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: h.repo,
      encoding: "utf8",
    });
    expect(left.trim()).toBe("?? bulk/f7.txt");
  }, 60_000);

  test("an owner replaced before a batch fails that batch without writing it", async () => {
    const h = createHarness();
    harnesses.push(h);
    const turn = await addFilesInTurn(h, 3);
    const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const owner = h.service.registry.ownerById(turn.worktreeId)!;
    // Replaced after the checkpoint and before the writes; the result
    // capture runs on a current owner again.
    let replaced = false;
    const capture = owner.capture.bind(owner);
    const captures = spyOn(owner, "capture").mockImplementation(async (options) => {
      if (options.purpose === "restore-result") replaced = false;
      const outcome = await capture(options);
      if (options.purpose === "restore-checkpoint") replaced = true;
      return outcome;
    });
    const assertCurrent = owner.assertCurrent.bind(owner);
    const fence = spyOn(owner, "assertCurrent").mockImplementation(() => {
      if (replaced) throw new Error("owner-replaced");
      assertCurrent();
    });
    try {
      const applied = await h.service.restore.apply({
        actionToken: preview.actionToken,
        idempotencyKey: "replaced",
      });
      expect(applied).toMatchObject({ kind: "applied", outcome: "partial", completedPathIds: [] });
      if (applied.kind === "applied") expect(applied.failedPathIds).toHaveLength(3);
    } finally {
      fence.mockRestore();
      captures.mockRestore();
    }
    for (let index = 0; index < 3; index++)
      expect(existsSync(join(h.repo, "bulk", `f${index}.txt`))).toBe(true);
  });
});

// Exercise the apply batching seam without checkpoint/result captures obscuring
// which reads and writes belong to the apply-time checks.
type ApplyBatchSeam = {
  applyBatch: (
    owner: WorktreeChangeOwner,
    groups: ConditionalWriteItem["action"][][],
  ) => Promise<Array<[ConditionalWriteItem["action"], ConditionalWriteOutcome]>>;
  writeBatch: (
    owner: WorktreeChangeOwner,
    items: readonly ConditionalWriteItem[],
  ) => Promise<ConditionalWriteOutcome[]>;
};

async function batchHarness() {
  const h = createHarness();
  harnesses.push(h);
  const turn = await addFilesInTurn(h, 1);
  return {
    h,
    owner: h.service.registry.ownerById(turn.worktreeId)!,
    restore: h.service.restore as unknown as ApplyBatchSeam,
  };
}

test("host destination bodies are released before the next describe and before writes", async () => {
  const { h, owner, restore } = await batchHarness();
  const body = new Uint8Array(8 * 1024 * 1024).fill(65);
  const actions = Array.from({ length: 5 }, (_, i) => ({
    ...deleteItem(`large${i}`, "").action,
    expectedOid: objectId("blob", body),
  }));
  for (const action of actions) writeFileSync(join(h.repo, action.pathId.slice(2)), body);
  const records: ReadRecord[] = [];
  const assertReleased = () => {
    for (const record of records) {
      if (record.kind === "file") expect(record.bytes === undefined).toBe(true);
    }
  };
  const describe = owner.executor.describe.bind(owner.executor);
  const reads = spyOn(owner.executor, "describe").mockImplementation(async (paths, ...args) => {
    assertReleased();
    expect(paths).toHaveLength(1);
    const result = await describe(paths, ...args);
    expect(result[0]?.kind).toBe("file");
    records.push(...result);
    return result;
  });
  const writes = spyOn(restore, "writeBatch").mockImplementation(async (_, items) => {
    assertReleased();
    expect(records).toHaveLength(actions.length);
    return items.map(() => "applied");
  });
  try {
    expect(
      (
        await restore.applyBatch(
          owner,
          actions.map((a) => [a]),
        )
      ).map(([, r]) => r),
    ).toEqual(actions.map(() => "applied"));
    expect(reads).toHaveBeenCalledTimes(actions.length);
    expect(writes).toHaveBeenCalledTimes(1);
  } finally {
    reads.mockRestore();
    writes.mockRestore();
  }
});

test("target byte limit flushes without splitting a rename group and preserves outcomes", async () => {
  const { h, owner, restore } = await batchHarness();
  const unit = RESTORE_WRITE_BATCH_BYTES / 4;
  const sizes = [unit * 3, unit, unit, unit * 2];
  const actions = sizes.map((_, i) => ({
    pathId: `u:target${i}`,
    expectedOid: null,
    expectedMode: null,
    targetBlob: `blob${i}`,
    mode: "100644",
  }));
  const get = spyOn(h.service.objects, "get").mockImplementation(
    async (id) => new Uint8Array(sizes[Number(id.slice(4))]!),
  );
  const batches: string[][] = [];
  const writes = spyOn(restore, "writeBatch").mockImplementation(async (_, items) => {
    expect(items.reduce((n, item) => n + (item.bytes?.byteLength ?? 0), 0)).toBeLessThanOrEqual(
      RESTORE_WRITE_BATCH_BYTES,
    );
    batches.push(items.map((item) => item.action.pathId));
    return items.map((item) => (item.action === actions[2] ? "failed" : "applied"));
  });
  try {
    const outcomes = await restore.applyBatch(owner, [
      [actions[0]!],
      actions.slice(1, 3),
      [actions[3]!],
    ]);
    expect(batches).toEqual([["u:target0"], ["u:target1", "u:target2", "u:target3"]]);
    expect(outcomes.map(([, result]) => result)).toEqual([
      "applied",
      "applied",
      "failed",
      "applied",
    ]);
  } finally {
    get.mockRestore();
    writes.mockRestore();
  }
});

for (const failure of ["missing", "reject"] as const) {
  test(`a ${failure} blob partway through a group preserves loaded writes and fails the remainder`, async () => {
    const { h, owner, restore } = await batchHarness();
    const actions = Array.from({ length: 4 }, (_, i) => ({
      pathId: `u:target${i}`,
      expectedOid: null,
      expectedMode: null,
      targetBlob: `blob${i}`,
      mode: "100644",
    }));
    const get = spyOn(h.service.objects, "get").mockImplementation(async (id) => {
      if (id === "blob1") {
        if (failure === "reject") throw new Error("unreadable blob");
        return null;
      }
      return encode(id);
    });
    const writes = spyOn(restore, "writeBatch").mockImplementation(async (_, items) => {
      expect(items.map((item) => item.action.pathId)).toEqual(["u:target0", "u:target3"]);
      return items.map(() => "applied");
    });
    try {
      const outcomes = await restore.applyBatch(owner, [actions.slice(0, 3), [actions[3]!]]);
      expect(outcomes.map(([, result]) => result)).toEqual([
        "applied",
        "failed",
        "failed",
        "applied",
      ]);
      expect(get.mock.calls.map(([id]) => id)).toEqual(["blob0", "blob1", "blob3"]);
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
      writes.mockRestore();
    }
  });
}
