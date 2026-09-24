import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MCP_MANAGEMENT_LIMITS,
  type McpOperationSnapshot,
} from "@orkestrator/protocol/mcp-management";

import { McpOperationStore, type StoredOperation } from "./operations-store.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const RUNNING_AS_ROOT = process.getuid?.() === 0;

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mcp-ops-"));
  mkdirSync(path.join(root, "data"));
  file = path.join(root, "data", "operations.json");
});

afterEach(() => {
  chmodSync(path.join(root, "data"), 0o700);
  rmSync(root, { recursive: true, force: true });
});

function store(now = NOW) {
  return new McpOperationStore(
    file,
    async () => Buffer.alloc(32, 1),
    () => now,
  );
}

let counter = 0;

function operation(
  overrides: Partial<McpOperationSnapshot> = {},
  apply: Partial<McpOperationSnapshot["apply"]> = {},
): StoredOperation {
  counter += 1;
  const at = new Date(NOW).toISOString();
  return {
    snapshot: {
      operationId: `mcpop-${counter}`,
      requestId: `req-${counter}`,
      targetId: "mcp1~claude~backend~x",
      provider: "claude",
      kind: "add",
      entryName: "fixture",
      sourceId: "claude:user",
      phase: "saved",
      applyIntent: "save",
      apply: { state: "not-requested", runtimes: [], omitted: 0, ...apply },
      createdAt: at,
      updatedAt: at,
      ...overrides,
    },
    recovery: { fingerprint: `fp-${counter}`, expectedRevision: null, name: "fixture" },
  };
}

function ids(target: McpOperationStore) {
  return target.list().map((entry) => entry.snapshot.operationId);
}

describe("McpOperationStore load", () => {
  test("a newer schema is moved aside, never overwritten", async () => {
    const newer = JSON.stringify({ version: 2, operations: [{ future: true }] });
    writeFileSync(file, newer);
    const target = store();
    await target.load();
    expect(target.list()).toEqual([]);
    const aside = readdirSync(path.join(root, "data")).find((name) => name.includes(".v2-"));
    expect(aside).toBeDefined();
    expect(readFileSync(path.join(root, "data", aside!), "utf8")).toBe(newer);
    await target.put(operation());
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    // The newer history is still there for the build that wrote it.
    expect(readFileSync(path.join(root, "data", aside!), "utf8")).toBe(newer);
  });

  test("a damaged file is moved aside as unreadable", async () => {
    writeFileSync(file, "{not json");
    const target = store();
    await target.load();
    expect(readdirSync(path.join(root, "data")).some((name) => name.includes(".unreadable-"))).toBe(
      true,
    );
  });

  test.skipIf(RUNNING_AS_ROOT)(
    "when the unreadable file cannot be moved aside, writes are refused",
    async () => {
      const newer = JSON.stringify({ version: 3, operations: [] });
      writeFileSync(file, newer);
      chmodSync(path.join(root, "data"), 0o500);
      const target = store();
      await target.load();
      await expect(target.put(operation())).rejects.toThrow("internal");
      chmodSync(path.join(root, "data"), 0o700);
      expect(readFileSync(file, "utf8")).toBe(newer);
    },
  );
});

describe("McpOperationStore retention", () => {
  test("keeps at most the retained count of finished records, oldest dropped first", async () => {
    const target = store();
    await target.load();
    const pending = operation({ phase: "pending" });
    await target.put(pending);
    for (let index = 0; index < MCP_MANAGEMENT_LIMITS.retainedOperations + 5; index += 1) {
      await target.put(operation());
    }
    const kept = ids(target);
    expect(kept.length).toBe(MCP_MANAGEMENT_LIMITS.retainedOperations);
    // Unfinished work is never dropped by count.
    expect(kept).toContain(pending.snapshot.operationId);
  });

  test("drops finished records older than seven days but never unfinished ones", async () => {
    const old = new Date(NOW - MCP_MANAGEMENT_LIMITS.operationRetentionMs - 60_000).toISOString();
    const target = store();
    await target.load();
    const stale = operation({ updatedAt: old });
    const staleQueued = operation(
      { updatedAt: old },
      {
        state: "queued",
        runtimes: [
          { runtimeId: "r", environmentId: "e", label: "l", state: "queued", updatedAt: old },
        ],
      },
    );
    const staleReconciling = operation({ updatedAt: old, phase: "reconciling" });
    await target.put(stale);
    await target.put(staleQueued);
    await target.put(staleReconciling);
    await target.put(operation());
    const kept = ids(target);
    expect(kept).not.toContain(stale.snapshot.operationId);
    expect(kept).toContain(staleQueued.snapshot.operationId);
    expect(kept).toContain(staleReconciling.snapshot.operationId);
  });

  test("the 4 MiB bound sheds finished history only, including a pending save", async () => {
    const target = store();
    await target.load();
    // A pending save with a terminal-looking apply state is still unfinished.
    const pending = operation({ phase: "pending", message: "p".repeat(200 * 1024) });
    await target.put(pending);
    const queued = operation(
      { message: "q".repeat(200 * 1024) },
      {
        state: "queued",
        runtimes: [
          { runtimeId: "r", environmentId: "e", label: "l", state: "queued", updatedAt: "x" },
        ],
      },
    );
    await target.put(queued);
    for (let index = 0; index < 30; index += 1) {
      await target.put(operation({ message: "m".repeat(200 * 1024) }));
    }
    const bytes = statSync(file).size;
    expect(bytes).toBeLessThanOrEqual(MCP_MANAGEMENT_LIMITS.operationStoreMaxBytes);
    const kept = ids(target);
    expect(kept).toContain(pending.snapshot.operationId);
    expect(kept).toContain(queued.snapshot.operationId);
    expect(kept.length).toBeLessThan(32);
  });
});
