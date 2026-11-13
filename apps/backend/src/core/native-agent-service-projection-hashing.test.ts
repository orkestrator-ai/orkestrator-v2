/**
 * Serializing and hashing on the transcript projection path (efficiency batch
 * E11): the legacy commit's fingerprint, the view token, head-row recovery
 * and inline tool bodies.
 */
import { describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { applyNativeAgentProjectionDelta } from "@orkestrator/protocol/native-agent";
import type { ProviderTranscriptSnapshot } from "./native-agent-service.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;
const createdAt = "2026-11-05T00:00:00.000Z";

interface Row {
  id: string;
  role: "assistant" | "user";
  content: string;
  parts: Array<Record<string, unknown>>;
  createdAt: string;
}

function row(id: string, content = id, parts: Array<Record<string, unknown>> = []): Row {
  return { id, role: "assistant", content, parts, createdAt };
}

function toolPart(index: number, output: string): Record<string, unknown> {
  return {
    type: "tool-invocation",
    toolUseId: `call-${index}`,
    toolName: "exec_command",
    content: `Command ${index}`,
    toolOutput: output,
    toolState: "success",
  };
}

/** Characters fed to SHA-256 while `run` executes. */
async function hashedCharacters(run: () => Promise<void>): Promise<number> {
  const update = spyOn(Object.getPrototypeOf(createHash("sha256")), "update");
  try {
    await run();
    return update.mock.calls.reduce(
      (total, [data]) => total + (typeof data === "string" ? data.length : 0),
      0,
    );
  } finally {
    update.mockRestore();
  }
}

describe("legacy commit fingerprint", () => {
  test("is a digest through the row memo and still tells changed from unchanged", async () => {
    let content = "first";
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [row("m1", content, [{ type: "text", content }]), row("m2", "x".repeat(4_000))],
      }),
    });
    await withService(
      { prefix: "orkestrator-e11-legacy-commit-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:legacy-commit",
        };
        await service.ensureSession(identity);
        const first = await service.getProjection(identity);
        const key = nativeAgentSessionStorageKey("env-1", "opencode", identity.logicalSessionKey);
        const entry = projectionInternals(service).projectionCache.get(key)!;
        // The cache keeps a digest, not the whole projection's JSON.
        expect(entry.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const stringify = spyOn(JSON, "stringify");
        let unchanged: typeof first;
        try {
          unchanged = await service.getProjection(identity);
          // Nothing serialized the whole candidate projection to compare it.
          const wholeProjection = stringify.mock.calls.filter(
            ([value]) =>
              value !== null &&
              typeof value === "object" &&
              Array.isArray((value as { messages?: unknown }).messages) &&
              "sessionId" in (value as object),
          );
          expect(wholeProjection).toHaveLength(0);
        } finally {
          stringify.mockRestore();
        }
        expect(unchanged!.revision).toBe(first!.revision);
        expect(unchanged).toBe(first);

        content = "second";
        let changed: typeof first;
        const hashed = await hashedCharacters(async () => {
          changed = await service.getProjection(identity);
        });
        // The unchanged 4,000-character row enters the fingerprint by its
        // memoized fingerprint, not by its JSON.
        expect(hashed).toBeLessThan(4_000);
        expect(changed!.revision).toBeGreaterThan(first!.revision);
        expect((changed!.messages[0] as Row).content).toBe("second");
      },
    );
  });
});

describe("sync-v1 token", () => {
  test("keeps unchanged rows stable and changes the token when a row changes", async () => {
    let content = "first";
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [row("m1", content, [{ type: "text", content }]), row("m2", "x".repeat(4_000))],
      }),
    });
    await withService(
      { prefix: "orkestrator-e11-sync-token-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:sync-token",
        };
        await service.ensureSession(identity);
        const read = (knownToken?: string) =>
          service.getProjectionUpdate({ ...identity, syncVersion: 1, liveWindow, knownToken });
        const first = await read();
        if (first.status !== "snapshot") throw new Error("expected a sync snapshot");
        expect(await read(first.token)).toEqual({
          syncVersion: 1,
          status: "unchanged",
          token: first.token,
        });

        content = "second";
        const changed = await read(first.token);
        if (changed.status !== "delta") throw new Error("expected a sync delta");
        expect(changed.token).not.toBe(first.token);
        const projection = applyNativeAgentProjectionDelta(first.projection, changed.delta);
        expect((projection!.messages[0] as Row).content).toBe("second");
        expect((projection!.messages[1] as Row).content).toBe("x".repeat(4_000));
        expect(await read(changed.token)).toEqual({
          syncVersion: 1,
          status: "unchanged",
          token: changed.token,
        });
      },
    );
  });
});

describe("view token", () => {
  test("moves when only a revised row changes, and holds when nothing does", async () => {
    let state = "pending";
    const transcriptSnapshot = async (): Promise<ProviderTranscriptSnapshot> => ({
      messages: [row("m5"), row("m6")],
      historyStartIndex: 5,
      complete: false,
      historyEpoch: "g1:1",
      // A provider whose token does not move when a revised row changes.
      sourceToken: "t1",
      freshness: "current",
      revisedMessages: [
        row("m2", "m2", [
          { type: "tool-invocation", content: "Run", toolUseId: "m2-call", toolState: state },
        ]),
      ],
    });
    const stub = createProviderStub("codex", { transcriptSnapshot });
    await withService(
      { prefix: "orkestrator-e11-view-token-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:view-token",
        };
        await service.ensureSession(identity);
        const read = async () => {
          const update = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          if (update.status !== "snapshot") throw new Error("expected a snapshot");
          return update;
        };
        const first = await read();
        expect((first.value.revisedMessages as Row[] | undefined)?.map((r) => r.id)).toEqual([
          "m2",
        ]);
        const same = await read();
        expect(same.token).toBe(first.token);

        state = "success";
        const revised = await read();
        expect(revised.token).not.toBe(first.token);
        expect((revised.value.revisedMessages as Row[])[0]!.parts[0]!.toolState).toBe("success");
        expect((await read()).token).toBe(revised.token);
      },
    );
  });
});

describe("head-row recovery", () => {
  function trimmedHeadProvider() {
    let revision = 1;
    let trimmed = false;
    const full = () =>
      row("response", `Update ${revision}`, [
        toolPart(0, "done"),
        { type: "text", content: `Update ${revision}` },
      ]);
    const messages = mock(async () => [full()]);
    const stub = createProviderStub("codex", {
      messages,
      transcriptSnapshot: async () => {
        const current = full();
        return trimmed
          ? {
              messages: [{ ...current, parts: current.parts.slice(1) }],
              complete: false,
              omittedParts: 1,
              sourceToken: `source-${revision}`,
              historyEpoch: "1:1",
              freshness: "current" as const,
            }
          : {
              messages: [current],
              complete: true,
              sourceToken: `source-${revision}`,
              historyEpoch: "1:1",
              freshness: "current" as const,
            };
      },
    });
    return {
      stub,
      messages,
      stream: () => {
        trimmed = true;
        revision += 1;
        return revision;
      },
    };
  }

  test("starts at most one provider read per interval while the head streams", async () => {
    const provider = trimmedHeadProvider();
    await withService(
      {
        prefix: "orkestrator-e11-recovery-interval-",
        provider: async () => provider.stub.provider,
        progressiveHydrationSettleMs: 600,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:recovery-interval",
        };
        await service.ensureSession(identity);
        const read = () =>
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
        await read();
        // The first trimmed revision of a quiet view recovers at once.
        provider.stream();
        await read();
        await waitForCondition(() => provider.messages.mock.calls.length === 1);
        // Revisions streaming in faster than the interval start no reads...
        for (let index = 0; index < 5; index += 1) {
          provider.stream();
          await read();
        }
        expect(provider.messages).toHaveBeenCalledTimes(1);
        // ...until the interval since the last read has passed: then one, for
        // the newest revision, which the view shows once it lands.
        const latest = provider.stream();
        await read();
        await waitForCondition(() => provider.messages.mock.calls.length === 2);
        await waitForCondition(async () => {
          const recovered = await read();
          return (
            recovered.status === "snapshot" &&
            (recovered.value.messages[0] as Row).parts.length === 2 &&
            (recovered.value.messages[0] as Row).content === `Update ${latest}`
          );
        });
        expect(provider.messages).toHaveBeenCalledTimes(2);
      },
    );
  });

  /**
   * A head row whose exact read the test releases by hand, so a newer revision
   * can arrive while it is in flight: what happens once reading and parsing the
   * row outlasts the gap between two revisions (to-do 7845 (retired), task 2).
   */
  function slowRecoveryProvider() {
    let revision = 1;
    let trimmed = false;
    let complete = true;
    // One gate per exact read, in the order the reads start.
    const gates: Array<{ promise: Promise<void>; release: () => void }> = [];
    const gate = (call: number) => {
      while (gates.length <= call) {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => (release = resolve));
        gates.push({ promise, release });
      }
      return gates[call]!;
    };
    const full = (at: number) =>
      row("response", `Update ${at}`, [
        toolPart(0, "done"),
        { type: "text", content: `Update ${at}` },
      ]);
    let reads = 0;
    const messages = mock(async () => {
      const at = revision;
      await gate(reads++).promise;
      return [full(at)];
    });
    const stub = createProviderStub("codex", {
      messages,
      transcriptSnapshot: async () => {
        const current = full(revision);
        return trimmed && !complete
          ? {
              messages: [{ ...current, parts: current.parts.slice(1) }],
              complete: false,
              omittedParts: 1,
              sourceToken: `source-${revision}`,
              historyEpoch: "1:1",
              freshness: "current" as const,
            }
          : {
              messages: [current],
              complete: true,
              sourceToken: `source-${revision}`,
              historyEpoch: "1:1",
              freshness: "current" as const,
            };
      },
    });
    return {
      stub,
      messages,
      /** Lets exact read number `call` (from 0) answer. */
      release: (call = 0) => gate(call).release(),
      releaseAll: () => {
        for (const { release } of gates) release();
      },
      stream: () => {
        trimmed = true;
        complete = false;
        revision += 1;
      },
      finish: () => {
        complete = true;
        revision += 1;
      },
    };
  }

  async function withSlowRecovery(
    name: string,
    run: (context: {
      provider: ReturnType<typeof slowRecoveryProvider>;
      shown: () => Promise<{ content: string; parts: number }>;
    }) => Promise<void>,
    // By default only the first recovery starts within the test.
    settleMs = 60_000,
  ) {
    const provider = slowRecoveryProvider();
    await withService(
      {
        prefix: `orkestrator-7845-${name}-`,
        provider: async () => provider.stub.provider,
        progressiveHydrationSettleMs: settleMs,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: `env-env-1:${name}`,
        };
        await service.ensureSession(identity);
        const shown = async () => {
          const update = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          if (update.status !== "snapshot")
            throw new Error(`expected a snapshot: ${update.status}`);
          const head = update.value.messages[0] as Row;
          return { content: head.content, parts: head.parts.length };
        };
        try {
          await run({ provider, shown });
        } finally {
          provider.releaseAll();
        }
      },
    );
  }

  test("a recovery a newer revision overtook still advances the view", async () => {
    await withSlowRecovery("overtaken", async ({ provider, shown }) => {
      expect(await shown()).toEqual({ content: "Update 1", parts: 2 });
      provider.stream();
      await shown();
      await waitForCondition(() => provider.messages.mock.calls.length === 1);
      // Revision 3 lands while the read of revision 2 is still in flight.
      provider.stream();
      expect(await shown()).toEqual({ content: "Update 1", parts: 2 });
      provider.release();
      // The read is newer than the view, which has not moved since it started.
      await waitForCondition(async () => (await shown()).content === "Update 2");
      expect(await shown()).toEqual({ content: "Update 2", parts: 2 });
      expect(provider.messages).toHaveBeenCalledTimes(1);
    });
  });

  test("a recovery older than the view it would replace is not committed", async () => {
    await withSlowRecovery("older", async ({ provider, shown }) => {
      await shown();
      provider.stream();
      await shown();
      await waitForCondition(() => provider.messages.mock.calls.length === 1);
      // The turn ends while the read of revision 2 is in flight.
      provider.finish();
      expect(await shown()).toEqual({ content: "Update 3", parts: 2 });
      provider.release();
      await Bun.sleep(20);
      expect(await shown()).toEqual({ content: "Update 3", parts: 2 });
    });
  });

  test("an overtaken recovery does not replace a newer recovery that landed first", async () => {
    await withSlowRecovery(
      "out-of-order",
      async ({ provider, shown }) => {
        expect(await shown()).toEqual({ content: "Update 1", parts: 2 });
        // Read 0 recovers revision 2 and stays in flight.
        provider.stream();
        await shown();
        await waitForCondition(() => provider.messages.mock.calls.length === 1);
        // Read 1 recovers revision 3 once the interval has passed.
        provider.stream();
        await shown();
        await waitForCondition(() => provider.messages.mock.calls.length === 2);
        // The newer read answers first, and the view shows revision 3.
        provider.release(1);
        await waitForCondition(async () => (await shown()).content === "Update 3");
        // Revision 4 streams in, so a newer recovery is pending while the
        // view holds revision 3.
        provider.stream();
        expect(await shown()).toEqual({ content: "Update 3", parts: 2 });
        // The read of revision 2 now answers. The view moved since it
        // started, so committing it would take the view backwards.
        provider.release(0);
        await Bun.sleep(20);
        expect(await shown()).toEqual({ content: "Update 3", parts: 2 });
      },
      20,
    );
  });

  test("a cached summary still recovers while its token keeps moving", async () => {
    let revision = 0;
    const messages = mock(async () => [row("m0"), row("m1"), row("m2")]);
    const stub = createProviderStub("codex", {
      messages,
      transcriptSnapshot: async () => ({
        messages: [row("m2")],
        complete: false,
        freshness: "cached" as const,
        representation: "summary" as const,
        sourceToken: `cached-${revision}`,
      }),
    });
    await withService(
      {
        prefix: "orkestrator-e11-recovery-cached-",
        provider: async () => stub.provider,
        progressiveHydrationSettleMs: 300,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:recovery-cached",
        };
        await service.ensureSession(identity);
        const read = () =>
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
        // The first read of a detached thread's cached summary reads at once:
        // that read is what attaches the thread.
        await read();
        await waitForCondition(() => messages.mock.calls.length === 1);
        // A token that never settles cannot starve it: the deadline is fixed
        // by the previous read, not pushed back by each new token.
        const until = Date.now() + 1_500;
        while (messages.mock.calls.length < 2 && Date.now() < until) {
          revision += 1;
          await read();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(messages.mock.calls.length).toBeGreaterThanOrEqual(2);
        // Once it settles, the recovered rows replace the summary.
        await waitForCondition(async () => {
          const recovered = await read();
          return recovered.status === "snapshot" && recovered.value.messages.length === 3;
        });
      },
    );
  });
});

describe("inline tool bodies", () => {
  function streamingToolRow() {
    const outputs = Array.from(
      { length: 8 },
      (_, index) => `output ${index} ${"z".repeat(20_000)}`,
    );
    let tail = "streaming";
    const snapshot = (): ProviderTranscriptSnapshot => ({
      messages: [
        row("response", tail, [
          ...outputs.map((output, index) => toolPart(index, output)),
          { type: "text", content: tail },
        ]),
      ],
      complete: true,
      sourceToken: `source-${tail}`,
      historyEpoch: "1:1",
      freshness: "current",
    });
    return {
      outputs,
      transcriptSnapshot: async () => snapshot(),
      stream: (next: string) => {
        tail = next;
      },
    };
  }

  test("an unchanged body on a re-projected row is not hashed again, and stays registered", async () => {
    const source = streamingToolRow();
    const stub = createProviderStub("codex", { transcriptSnapshot: source.transcriptSnapshot });
    await withService(
      { prefix: "orkestrator-e11-tool-memo-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tool-memo",
        };
        await service.ensureSession(identity);
        const read = async () => {
          const update = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          if (update.status !== "snapshot") throw new Error("expected a snapshot");
          return (update.value.messages[0] as Row).parts.slice(0, -1).map((part) => part.detailRef);
        };
        const first = await read();
        expect(first.every((ref) => typeof ref === "string")).toBe(true);
        const internals = projectionInternals(service);
        const hitsBefore = internals.toolDetailEncodings.hits;

        // The row changes (its text streams), so the row cache misses and
        // every part is projected again; no tool body is re-hashed.
        source.stream("streaming more");
        let second: Array<unknown> = [];
        const hashed = await hashedCharacters(async () => {
          second = await read();
        });
        expect(second).toEqual(first);
        expect(internals.toolDetailEncodings.hits - hitsBefore).toBe(source.outputs.length);
        expect(hashed).toBeLessThan(source.outputs[0]!.length);

        // A hit still registers the reference: evicted bodies come back.
        internals.evictToolDetails();
        source.stream("streaming yet more");
        const third = await read();
        expect(third).toEqual(first);
        for (const [index, detailRef] of third.entries()) {
          const details = await service.getProjectionToolDetails({
            ...identity,
            detailRef: detailRef as string,
          });
          expect(details.toolOutput).toBe(source.outputs[index]);
        }
      },
    );
  });

  test("the memo keeps to its count and byte bounds", async () => {
    const source = streamingToolRow();
    const stub = createProviderStub("codex", { transcriptSnapshot: source.transcriptSnapshot });
    await withService(
      {
        prefix: "orkestrator-e11-tool-memo-bounds-",
        provider: async () => stub.provider,
        toolDetailMemoLimits: { maxEntries: 3, maxBytes: 64 * 1024 },
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tool-memo-bounds",
        };
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(update.status).toBe("snapshot");
        const memo = projectionInternals(service).toolDetailEncodings;
        expect(memo.size).toBeLessThanOrEqual(3);
        expect(memo.bytes).toBeLessThanOrEqual(64 * 1024);
        expect(memo.size).toBeGreaterThan(0);
      },
    );
  });
});
