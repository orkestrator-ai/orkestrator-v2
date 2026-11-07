import { describe, expect, test } from "bun:test";
import {
  checkNodeSnapshot,
  createNodeSnapshotStore,
  indexedDbSnapshotBackend,
  memorySnapshotBackend,
  NODE_SNAPSHOT_VERSION,
  SnapshotContentError,
  SnapshotTooLargeError,
  type NodeSnapshot,
  type SnapshotEnvironment,
} from "./snapshot-store";

const environment = (id: string, extra: Record<string, unknown> = {}): SnapshotEnvironment =>
  ({
    id,
    projectId: "project-1",
    name: `env ${id}`,
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-11-07T10:00:00.000Z",
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    ...extra,
  }) as SnapshotEnvironment;

function snapshot(nodeId: string, overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    version: NODE_SNAPSHOT_VERSION,
    nodeId,
    savedAt: 1_000,
    projects: [
      {
        id: "project-1",
        name: "Checkout",
        gitUrl: "git@github.com:acme/checkout.git",
        localPath: null,
        addedAt: "2026-11-01T10:00:00.000Z",
        order: 0,
      },
    ],
    environments: [environment("env-1")],
    config: null,
    paneLayouts: [],
    selection: { projectId: "project-1", environmentId: "env-1" },
    ...overrides,
  };
}

/** A snapshot whose body is about `bytes` long (padding in environment names). */
function sized(nodeId: string, bytes: number): NodeSnapshot {
  const count = Math.max(1, Math.floor(bytes / 900));
  return snapshot(nodeId, {
    environments: Array.from({ length: count }, (_, index) =>
      environment(`e${index}`, { name: "x".repeat(600) }),
    ),
  });
}

describe("content rules", () => {
  test("an allowed record passes and round-trips unchanged", () => {
    const record = snapshot("bk_a");
    expect(checkNodeSnapshot(record)).toEqual(record);
  });

  const forbidden: Array<[string, unknown]> = [
    [
      "an environment's prompt",
      snapshot("bk_a", { environments: [environment("e", { initialPrompt: "SECRET-PROMPT" })] }),
    ],
    [
      "prompt attachments",
      snapshot("bk_a", {
        environments: [environment("e", { initialPromptAttachments: [{ base64Data: "AAAA" }] })],
      }),
    ],
    ["terminal contents", { ...snapshot("bk_a"), terminalOutput: "SECRET-TERMINAL $ ls" }],
    ["a transcript", { ...snapshot("bk_a"), transcripts: [{ text: "SECRET-TRANSCRIPT" }] }],
    [
      "file contents in a pane layout",
      snapshot("bk_a", {
        paneLayouts: [
          {
            environmentId: "e",
            activePaneId: "p",
            activeTabId: null,
            tabIds: [],
            fileData: { content: "SECRET-FILE" },
          } as never,
        ],
      }),
    ],
    [
      "a credential in the config",
      snapshot("bk_a", {
        config: { repositories: [], githubToken: "SECRET-TOKEN" } as never,
      }),
    ],
    [
      "a token in a clone URL",
      snapshot("bk_a", {
        projects: [
          {
            id: "p",
            name: "n",
            gitUrl: "https://SECRET-TOKEN@github.com/acme/x.git",
            localPath: null,
            addedAt: "a",
            order: 0,
          },
        ],
      }),
    ],
    [
      "an unbounded name",
      snapshot("bk_a", { environments: [environment("e", { name: "n".repeat(5_000) })] }),
    ],
  ];

  for (const [what, record] of forbidden) {
    test(`a record with ${what} is refused, naming the field but not the value`, async () => {
      expect(() => checkNodeSnapshot(record)).toThrow(SnapshotContentError);
      try {
        checkNodeSnapshot(record);
      } catch (error) {
        expect(String((error as Error).message)).not.toContain("SECRET");
      }
      // And the store writes nothing.
      const backend = memorySnapshotBackend();
      const store = createNodeSnapshotStore(backend);
      await expect(store.write(record as NodeSnapshot)).rejects.toBeInstanceOf(
        SnapshotContentError,
      );
      expect(backend.bodies.size).toBe(0);
    });
  }

  test("a stored record that breaks today's rules is dropped on read, not shown", async () => {
    const backend = memorySnapshotBackend();
    const store = createNodeSnapshotStore(backend);
    await store.write(snapshot("bk_a"));
    const body = JSON.parse(backend.bodies.get("bk_a")!) as NodeSnapshot;
    const tampered = {
      ...body,
      environments: [{ ...body.environments[0], initialPrompt: "SECRET-PROMPT" }],
    };
    await backend.write((await backend.listMeta())[0]!, JSON.stringify(tampered));
    expect(await store.read("bk_a")).toBeNull();
    expect(backend.bodies.has("bk_a")).toBe(false);
  });

  test("another version or another node's record is dropped on read", async () => {
    const backend = memorySnapshotBackend();
    const store = createNodeSnapshotStore(backend);
    const meta = { nodeId: "bk_a", bytes: 10, savedAt: 1, usedAt: 1 };
    await backend.write(meta, JSON.stringify({ ...snapshot("bk_a"), version: 99 }));
    expect(await store.read("bk_a")).toBeNull();
    await backend.write(meta, JSON.stringify(snapshot("bk_other")));
    expect(await store.read("bk_a")).toBeNull();
    await backend.write(meta, "{not json");
    expect(await store.read("bk_a")).toBeNull();
    expect(backend.bodies.size).toBe(0);
  });
});

describe("bounds and eviction", () => {
  test("a record over the per-node bound is refused and nothing is written", async () => {
    const backend = memorySnapshotBackend();
    const store = createNodeSnapshotStore(backend, { bounds: { perNodeBytes: 4_000 } });
    await expect(store.write(sized("bk_a", 10_000))).rejects.toBeInstanceOf(SnapshotTooLargeError);
    expect(backend.bodies.size).toBe(0);
  });

  test("past the total bound the least recently used other nodes are evicted", async () => {
    let clock = 0;
    const backend = memorySnapshotBackend();
    const store = createNodeSnapshotStore(backend, {
      bounds: { perNodeBytes: 8_000, totalBytes: 12_000, maxNodes: 10 },
      now: () => ++clock,
    });
    await store.write(sized("bk_a", 5_000));
    await store.write(sized("bk_b", 5_000));
    // Reading a makes b the least recently used.
    expect(await store.read("bk_a")).not.toBeNull();
    const result = await store.write(sized("bk_c", 5_000));
    expect(result.evicted).toEqual(["bk_b"]);
    const left = (await store.entries()).map((entry) => entry.nodeId).sort();
    expect(left).toEqual(["bk_a", "bk_c"]);
    const total = (await store.entries()).reduce((sum, entry) => sum + entry.bytes, 0);
    expect(total).toBeLessThanOrEqual(12_000);
  });

  test("the count bound evicts the oldest too, and the written node is never evicted", async () => {
    let clock = 0;
    const store = createNodeSnapshotStore(memorySnapshotBackend(), {
      bounds: { maxNodes: 2 },
      now: () => ++clock,
    });
    await store.write(snapshot("bk_a"));
    await store.write(snapshot("bk_b"));
    await store.write(snapshot("bk_c"));
    // Rewriting c (the newest) keeps it and evicts nothing more.
    const again = await store.write(snapshot("bk_c", { savedAt: 2_000 }));
    expect(again.evicted).toEqual([]);
    expect((await store.entries()).map((entry) => entry.nodeId).sort()).toEqual(["bk_b", "bk_c"]);
    expect((await store.read("bk_c"))?.savedAt).toBe(2_000);
  });

  test("clear drops one node, clearAll every node", async () => {
    const store = createNodeSnapshotStore(memorySnapshotBackend());
    await store.write(snapshot("bk_a"));
    await store.write(snapshot("bk_b"));
    await store.clear("bk_a");
    expect(await store.read("bk_a")).toBeNull();
    expect(await store.read("bk_b")).not.toBeNull();
    await store.clearAll();
    expect(await store.entries()).toEqual([]);
  });

  test("operations are serialized: a clear issued after a write sees the write", async () => {
    const store = createNodeSnapshotStore(memorySnapshotBackend());
    const write = store.write(snapshot("bk_a"));
    const clear = store.clear("bk_a");
    await Promise.all([write, clear]);
    expect(await store.read("bk_a")).toBeNull();
  });

  test("a failing backend operation rejects that call only", async () => {
    const backend = memorySnapshotBackend();
    const store = createNodeSnapshotStore(backend);
    backend.failNext("write");
    await expect(store.write(snapshot("bk_a"))).rejects.toThrow("write failed");
    await store.write(snapshot("bk_a"));
    expect(await store.read("bk_a")).not.toBeNull();
  });
});

test("without IndexedDB there is no backend", () => {
  expect(indexedDbSnapshotBackend(undefined)).toBeNull();
});
