import { describe, expect, test } from "bun:test";
import {
  applyNativeAgentTranscriptDelta,
  NATIVE_AGENT_REVISED_MESSAGES_MAX,
  type NativeAgentTranscriptDelta,
  type NativeAgentTranscriptUpdate,
  type NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "@orkestrator/protocol/native-agent-transcript-patch";
import { encodedBytesWithMessages } from "./native-agent-projection-encoding.js";
import type { ProviderTranscriptSnapshot } from "./agent-provider-contract.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";
import {
  chainedTranscriptDelta,
  NATIVE_TRANSCRIPT_DELTA_MAX_BASE_BYTES,
  NATIVE_TRANSCRIPT_DELTA_MAX_BASES,
  NATIVE_TRANSCRIPT_DELTA_MAX_KEY_BYTES,
  TranscriptDeltaBases,
} from "./native-agent-transcript-delta-bases.js";

type Row = {
  id: string;
  role: "assistant";
  content: string;
  parts: unknown[];
  createdAt: string;
};

const CREATED_AT = "2026-11-04T00:00:00.000Z";
const row = (id: string, content = `${id} ${"x".repeat(2_000)}`): Row => ({
  id,
  role: "assistant",
  content,
  parts: [],
  createdAt: CREATED_AT,
});
const ids = (messages: readonly unknown[]) => messages.map((m) => (m as { id: string }).id);

function view(
  messages: readonly unknown[],
  overrides: Partial<NativeAgentTranscriptView> = {},
): NativeAgentTranscriptView {
  return {
    identity: {
      backendInstanceId: "backend",
      environmentId: "env-1",
      platform: "codex",
      logicalSessionKey: "tab",
      providerSessionId: "session-1",
      sourceGeneration: "generation-1",
    },
    freshness: "current",
    messages: [...messages],
    historyEpoch: "epoch-1",
    historyComplete: false,
    ...overrides,
  } as NativeAgentTranscriptView;
}

const emptyDelta = (current: NativeAgentTranscriptView): NativeAgentTranscriptDelta =>
  ({
    messageUpserts: [],
    deletedMessageIds: [],
    freshness: current.freshness,
    historyEpoch: current.historyEpoch,
    historyComplete: current.historyComplete,
  }) as NativeAgentTranscriptDelta;

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:delta-bases",
};
const liveWindow = { messages: 40, targetBytes: 512 * 1024 };
const read = { ...identity, viewVersion: 1 as const, liveWindow };

/** A provider whose transcript the test edits, and the service reading it. */
async function withStream(
  initial: Row[],
  run: (context: {
    history: Row[];
    service: Parameters<Parameters<typeof withService>[1]>[0]["service"];
    /** Have one up-to-date reader see the current transcript; returns its token. */
    advance: () => Promise<string>;
    fullRead: () => Promise<NativeAgentTranscriptView>;
  }) => Promise<void>,
): Promise<void> {
  const history = [...initial];
  const stub = createProviderStub("codex", {
    transcriptSnapshot: async (_sessionId, options) => {
      const messages = history.slice(-options.limit);
      return {
        messages,
        historyStartIndex: history.length - messages.length,
        // Moves only with the content, as a bridge's does.
        sourceToken: `source-${Bun.hash(JSON.stringify(history))}`,
        complete: messages.length === history.length,
        historyEpoch: "epoch-1",
        historyPageable: true,
        freshness: "current",
      } satisfies ProviderTranscriptSnapshot;
    },
    messages: async () => history,
  });
  await withService(
    { prefix: "ork-delta-bases-", provider: async () => stub.provider },
    async ({ service }) => {
      await service.ensureSession(identity);
      let known: string | undefined;
      const advance = async () => {
        const update = await service.getTranscriptUpdate({
          ...read,
          ...(known ? { knownToken: known } : {}),
        });
        if (update.status !== "snapshot" && update.status !== "delta") {
          throw new Error(`expected a view, got ${update.status}`);
        }
        known = update.token;
        return update.token;
      };
      const fullRead = async () => {
        const update = await service.getTranscriptUpdate({ ...read, forceSnapshot: true });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        known = update.token;
        return update.value;
      };
      await run({ history, service, advance, fullRead });
    },
  );
}

const asDelta = (update: NativeAgentTranscriptUpdate) => {
  if (update.status !== "delta") throw new Error(`expected a delta, got ${update.status}`);
  return update;
};

describe("transcript readers behind the newest view (TX-1)", () => {
  test("a viewer one revision behind gets a delta, not a snapshot", async () => {
    await withStream([row("m1"), row("m2"), row("m3")], async ({ history, service, advance }) => {
      const behind = await advance();
      history.push(row("m4"));
      await advance();
      const update = asDelta(await service.getTranscriptUpdate({ ...read, knownToken: behind }));
      expect(update.baseToken).toBe(behind);
      expect(ids(update.delta.messageUpserts)).toEqual(["m4"]);
      expect(update.delta.freshness).toBe("cached");
    });
  });

  test("a viewer a few revisions behind gets everything it missed in one delta", async () => {
    await withStream([row("m1"), row("m2")], async ({ history, service, advance }) => {
      const behind = await advance();
      for (const id of ["m3", "m4", "m5"]) {
        history.push(row(id));
        await advance();
      }
      history[0] = row("m1", "m1 edited");
      await advance();
      const update = asDelta(await service.getTranscriptUpdate({ ...read, knownToken: behind }));
      expect(ids(update.delta.messageUpserts).sort()).toEqual(["m1", "m3", "m4", "m5"]);
    });
  });

  test("two viewers alternating reads both stay on deltas", async () => {
    await withStream([row("m1"), row("m2")], async ({ history, service }) => {
      const first = await service.getTranscriptUpdate(read);
      if (first.status !== "snapshot") throw new Error("expected a snapshot");
      const tokens = { a: first.token, b: first.token };
      for (let turn = 0; turn < 12; turn += 1) {
        history.push(row(`streamed-${turn}`));
        for (const viewer of ["a", "b"] as const) {
          const update = await service.getTranscriptUpdate({ ...read, knownToken: tokens[viewer] });
          if (update.status === "unchanged") continue;
          tokens[viewer] = asDelta(update).token;
        }
      }
    });
  });

  test("a viewer older than the ring gets a snapshot and ends with the correct transcript", async () => {
    await withStream([row("m1")], async ({ history, service, advance, fullRead }) => {
      const stale = await advance();
      for (let index = 0; index <= NATIVE_TRANSCRIPT_DELTA_MAX_BASES + 1; index += 1) {
        history.push(row(`later-${index}`));
        await advance();
      }
      const update = await service.getTranscriptUpdate({ ...read, knownToken: stale });
      if (update.status !== "snapshot") throw new Error(`expected a snapshot: ${update.status}`);
      const expected = await fullRead();
      expect(update.value.messages).toEqual(expected.messages);
      expect(ids(update.value.messages)).toEqual(history.map((entry) => entry.id));
    });
  });

  test("a viewer one view behind a head row over a million characters gets a small patch", async () => {
    // About 3 MB encoded, and a new copy on every read: no two views share it,
    // so each superseded view costs more than the 2 MiB key bound. That used
    // to empty the ring and send the viewer the whole 3 MB view (to-do 7845 (retired)).
    const streamed = "streamed ".repeat(330_000);
    await withStream([row("prompt", "prompt"), row("head", streamed)], async (context) => {
      const { history, service, advance } = context;
      const behind = await advance();
      history[1] = row("head", `${streamed} and more`);
      await advance();
      const update = asDelta(
        await service.getTranscriptUpdate({
          ...read,
          knownToken: behind,
          patchVersion: NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION,
        }),
      );
      expect(update.delta.messageUpserts).toEqual([]);
      expect(update.delta.messagePatches?.map((patch) => patch.id)).toEqual(["head"]);
      expect(JSON.stringify(update.delta).length).toBeLessThan(4_096);
    });
  });

  test("a token nothing issued gets a snapshot", async () => {
    await withStream([row("m1")], async ({ service, advance }) => {
      await advance();
      const update = await service.getTranscriptUpdate({ ...read, knownToken: "never-issued" });
      expect(update.status).toBe("snapshot");
    });
  });

  test("a forced read is never answered from the ring", async () => {
    await withStream([row("m1"), row("m2")], async ({ history, service, advance }) => {
      const behind = await advance();
      history.push(row("m3"));
      await advance();
      const update = await service.getTranscriptUpdate({
        ...read,
        knownToken: behind,
        forceSnapshot: true,
      });
      expect(update.status).toBe("snapshot");
    });
  });

  test("a delta larger than the view falls back to a snapshot", async () => {
    await withStream(
      Array.from({ length: 40 }, (_, index) => row(`m${index}`, "a")),
      async ({ history, service, advance }) => {
        const behind = await advance();
        // Every row changed and moved, so the delta repeats them and their order.
        history.reverse();
        for (const [index, entry] of history.entries()) {
          history[index] = row(entry.id, "b");
        }
        await advance();
        const update = await service.getTranscriptUpdate({ ...read, knownToken: behind });
        expect(update.status).toBe("snapshot");
      },
    );
  });

  test.each([false, true])(
    "applying a delta from any base in the ring matches a full read (patches: %s)",
    async (patches) => {
      // A small deterministic generator, so a failure replays exactly.
      let state = patches ? 0x2f6e2b1 : 0x9e3779b9;
      const random = (bound: number) => {
        state = Math.imul(state ^ (state >>> 15), state | 1);
        state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
        return ((state ^ (state >>> 14)) >>> 0) % bound;
      };
      const seed = Array.from({ length: 30 }, (_, index) => row(`seed-${index}`));
      await withStream(seed, async ({ history, service }) => {
        // A forced read can join a background read from before the edit, so a
        // view only counts as the full read once it shows the whole edit.
        const settledRead = async () => {
          const wanted = history.slice(-liveWindow.messages);
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const update = await service.getTranscriptUpdate({ ...read, forceSnapshot: true });
            if (update.status !== "snapshot") throw new Error("expected a snapshot");
            const shown = update.value.messages as Row[];
            if (
              shown.length === wanted.length &&
              shown.every((message, at) => message.content === wanted[at]!.content)
            ) {
              return update;
            }
            await Bun.sleep(1);
          }
          throw new Error("the full read never caught up with the edits");
        };
        const start = await settledRead();
        // What a reader holding each recent token has on screen.
        const held: Array<{ token: string; view: NativeAgentTranscriptView }> = [
          { token: start.token, view: start.value },
        ];
        let next = 0;
        let deltas = 0;
        for (let step = 0; step < 120; step += 1) {
          const edits = 1 + random(3);
          for (let edit = 0; edit < edits; edit += 1) {
            const kind = random(10);
            const at = random(history.length);
            if (kind < 5) {
              history.push(row(`new-${(next += 1)}`));
            } else if (kind < 8) {
              const target = history[at]!;
              history[at] = row(target.id, `${target.id} edit ${next} ${"z".repeat(2_000)}`);
              next += 1;
            } else if (history.length > 5) {
              history.splice(at, 1);
            }
          }
          const { token, value: expected } = await settledRead();

          // Every reader the ring can still serve, oldest to newest.
          for (const reader of held.slice(-NATIVE_TRANSCRIPT_DELTA_MAX_BASES)) {
            if (reader.token === token) continue;
            const update = await service.getTranscriptUpdate({
              ...read,
              knownToken: reader.token,
              ...(patches ? { patchVersion: NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } : {}),
            });
            const merged =
              update.status === "delta"
                ? applyNativeAgentTranscriptDelta(reader.view, update.delta)
                : update.status === "snapshot"
                  ? update.value
                  : null;
            if (update.status === "delta") deltas += 1;
            expect(merged).not.toBeNull();
            expect(merged!.messages).toEqual(expected.messages);
            expect(merged!.historyEpoch).toBe(expected.historyEpoch);
            expect(merged!.historyComplete).toBe(expected.historyComplete);
            expect(merged!.historyCursor).toBe(expected.historyCursor);
            expect(merged!.messageWindow).toEqual(expected.messageWindow);
          }
          held.push({ token, view: expected });
        }
        // The property would hold vacuously if everything became a snapshot.
        expect(deltas).toBeGreaterThan(300);
      });
    },
  );

  test("a long stream keeps the ring within its bounds and charges shared rows once", async () => {
    await withStream(
      Array.from({ length: 39 }, (_, index) => row(`m${index}`)),
      async ({ history, service, advance, fullRead }) => {
        const key = [...projectionInternals(service).progressiveTranscriptCache.keys()];
        expect(key).toEqual([]);
        history.push(row("streaming", "streaming"));
        await advance();
        const bases = projectionInternals(service).transcriptDeltaBases.forTesting();
        const [cacheKey] = [...projectionInternals(service).progressiveTranscriptCache.keys()];
        for (let step = 0; step < 400; step += 1) {
          history[history.length - 1] = row("streaming", `streaming ${"s".repeat(step)}`);
          await advance();
          expect(bases.baseCount(cacheKey!)).toBeLessThanOrEqual(NATIVE_TRANSCRIPT_DELTA_MAX_BASES);
          expect(bases.keyBytes(cacheKey!)).toBeLessThanOrEqual(
            NATIVE_TRANSCRIPT_DELTA_MAX_KEY_BYTES,
          );
          expect(bases.totalBytes()).toBe(bases.chargedBytes());
        }
        expect(bases.baseCount(cacheKey!)).toBe(NATIVE_TRANSCRIPT_DELTA_MAX_BASES);
        // Eight whole views would be eight times this; shared rows are not charged.
        const viewBytes = encodedBytesWithMessages(await fullRead());
        expect(bases.totalBytes()).toBeLessThan(viewBytes);
      },
    );
  });

  test("a rewound or replaced session drops its bases with its view", async () => {
    await withStream([row("m1"), row("m2")], async ({ history, service, advance }) => {
      const behind = await advance();
      history.push(row("m3"));
      await advance();
      const internals = projectionInternals(service);
      expect(internals.transcriptDeltaBases.forTesting().totalBytes()).toBeGreaterThan(0);
      internals.invalidateProjection(
        nativeAgentSessionStorageKey("env-1", "codex", identity.logicalSessionKey),
      );
      expect(internals.transcriptDeltaBases.forTesting().totalBytes()).toBe(0);
      const update = await service.getTranscriptUpdate({ ...read, knownToken: behind });
      expect(update.status).not.toBe("delta");
    });
  });
});

describe("TranscriptDeltaBases", () => {
  const superseded = (token: string, value: NativeAgentTranscriptView) => ({ token, value });

  test("holds no more than its count, oldest leaving first", () => {
    const bases = new TranscriptDeltaBases({
      maxBases: 3,
      maxKeyBytes: 1_000_000,
      maxBaseBytes: 1_000_000,
      maxTotalBytes: 1_000_000,
    });
    let current = view([row("m0")]);
    for (let index = 1; index <= 6; index += 1) {
      const next = view([row(`m${index}`)]);
      bases.record("key", superseded(`t${index - 1}`, current), next);
      current = next;
    }
    expect(bases.forTesting().baseCount("key")).toBe(3);
    expect(bases.chain("key", "t2")).toBeUndefined();
    expect(bases.chain("key", "t3")?.later).toHaveLength(2);
    expect(bases.chain("key", "t5")?.later).toEqual([]);
  });

  test("sheds oldest bases to stay within the bytes of one key", () => {
    const bases = new TranscriptDeltaBases({
      maxBases: 100,
      maxKeyBytes: 5_000,
      maxBaseBytes: 1_000_000,
      maxTotalBytes: 1_000_000,
    });
    let current = view([row("m0")]);
    for (let index = 1; index <= 10; index += 1) {
      const next = view([row(`m${index}`)]);
      bases.record("key", superseded(`t${index - 1}`, current), next);
      current = next;
      expect(bases.forTesting().keyBytes("key")).toBeLessThanOrEqual(5_000);
    }
    expect(bases.chain("key", "t0")).toBeUndefined();
    expect(bases.chain("key", "t9")).toBeDefined();
  });

  test("the total bound sheds the quietest key first", () => {
    const bases = new TranscriptDeltaBases({
      maxBases: 100,
      maxKeyBytes: 5_000,
      maxBaseBytes: 1_000_000,
      maxTotalBytes: 6_000,
    });
    bases.record("quiet", superseded("q0", view([row("a")])), view([row("b")]));
    bases.record("quiet", superseded("q1", view([row("b")])), view([row("c")]));
    bases.record("busy", superseded("b0", view([row("d")])), view([row("e")]));
    bases.record("busy", superseded("b1", view([row("e")])), view([row("f")]));
    const stats = bases.forTesting();
    expect(stats.totalBytes()).toBeLessThanOrEqual(6_000);
    expect(stats.totalBytes()).toBe(stats.chargedBytes());
    expect(bases.chain("busy", "b1")).toBeDefined();
    expect(bases.chain("quiet", "q0")).toBeUndefined();
  });

  test("a base too large to keep empties the ring rather than leaving a hole", () => {
    const bases = new TranscriptDeltaBases({
      maxBases: 8,
      maxKeyBytes: 3_000,
      maxBaseBytes: 5_000,
      maxTotalBytes: 1_000_000,
    });
    bases.record("key", superseded("t0", view([row("a")])), view([row("b")]));
    expect(bases.chain("key", "t0")).toBeDefined();
    const large = view([row("b", "b".repeat(10_000))]);
    bases.record("key", superseded("t1", large), view([row("c")]));
    expect(bases.chain("key", "t0")).toBeUndefined();
    expect(bases.chain("key", "t1")).toBeUndefined();
    expect(bases.forTesting().totalBytes()).toBe(0);
  });

  test("a base over the key bound replaces the ring rather than emptying it", () => {
    const bases = new TranscriptDeltaBases({
      maxBases: 8,
      maxKeyBytes: 3_000,
      maxBaseBytes: 50_000,
      maxTotalBytes: 1_000_000,
    });
    bases.record("key", superseded("t0", view([row("a")])), view([row("b")]));
    // A head row that grows on every read: no two views share it.
    const grown = (length: number) => view([row("head", "h".repeat(length))]);
    bases.record("key", superseded("t1", grown(10_000)), grown(11_000));
    expect(bases.chain("key", "t0")).toBeUndefined();
    expect(bases.chain("key", "t1")?.later).toEqual([]);
    bases.record("key", superseded("t2", grown(11_000)), grown(12_000));
    expect(bases.chain("key", "t1")).toBeUndefined();
    expect(bases.chain("key", "t2")?.later).toEqual([]);
    const stats = bases.forTesting();
    expect(stats.baseCount("key")).toBe(1);
    expect(stats.totalBytes()).toBe(stats.chargedBytes());
  });

  test("a recovered head row over a million characters keeps its base under the default bounds", () => {
    // About 3 MB encoded: over the 2 MiB key bound that used to empty the ring
    // on every recovery (to-do 7845 (retired), task 1).
    const bases = new TranscriptDeltaBases();
    const content = "streamed ".repeat(330_000);
    const grown = (extra: string) => view([row("head", content + extra)]);
    const first = grown("a");
    expect(encodedBytesWithMessages(first)).toBeGreaterThan(NATIVE_TRANSCRIPT_DELTA_MAX_KEY_BYTES);
    bases.record("key", superseded("t0", first), grown("ab"));
    expect(bases.chain("key", "t0")).toBeDefined();
    bases.record("key", superseded("t1", grown("ab")), grown("abc"));
    expect(bases.chain("key", "t1")).toBeDefined();
    expect(bases.forTesting().totalBytes()).toBeLessThanOrEqual(
      NATIVE_TRANSCRIPT_DELTA_MAX_BASE_BYTES,
    );
  });

  test.each([
    ["epoch", { historyEpoch: "epoch-2" }],
    [
      "generation",
      {
        identity: {
          ...view([]).identity,
          sourceGeneration: "generation-2",
        },
      },
    ],
    ["session", { identity: { ...view([]).identity, providerSessionId: "session-2" } }],
  ] as const)("a new %s starts the ring again", (_label, overrides) => {
    const bases = new TranscriptDeltaBases();
    bases.record("key", superseded("t0", view([row("a")])), view([row("b")]));
    bases.record(
      "key",
      superseded("t1", view([row("b")])),
      view([row("c")], overrides as Partial<NativeAgentTranscriptView>),
    );
    expect(bases.chain("key", "t0")).toBeUndefined();
    expect(bases.chain("key", "t1")).toBeUndefined();
    expect(bases.forTesting().totalBytes()).toBe(0);
  });

  test("a token seen twice resolves to its newest base", () => {
    const bases = new TranscriptDeltaBases();
    const [a, b] = [view([row("a")]), view([row("b")])];
    bases.record("key", superseded("repeat", a), b);
    bases.record("key", superseded("other", b), a);
    bases.record("key", superseded("repeat", a), b);
    expect(bases.chain("key", "repeat")?.later).toEqual([]);
  });
});

describe("chainedTranscriptDelta", () => {
  const delta = (current: NativeAgentTranscriptView, changes = {}) => ({
    ...emptyDelta(current),
    ...changes,
  });

  test("a direct delta passes through untouched", () => {
    const current = view([row("a")]);
    const direct = delta(current);
    expect(chainedTranscriptDelta(direct, { base: view([row("a")]), later: [] }, current)).toBe(
      direct,
    );
  });

  test("keeps a deletion that the endpoints alone would read as aging out", () => {
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((id) => row(id));
    const base = view([a, b, c, d]);
    const removedB = view([a, c, d]);
    const current = view([c, d, e]);
    const merged = chainedTranscriptDelta(delta(current), { base, later: [removedB] }, current)!;
    expect(merged.deletedMessageIds).toEqual(["b"]);
  });

  test("does not delete a row that came back", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => row(id));
    const current = view([a, b, c]);
    const merged = chainedTranscriptDelta(
      delta(current),
      { base: view([a, b]), later: [view([a])] },
      current,
    )!;
    expect(merged.deletedMessageIds).toEqual([]);
  });

  test.each([false, true])(
    "restoration cancels deletion before aging out (deleted again: %s)",
    (deletedAgain) => {
      const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((id) => row(id));
      const base = view([a, b, c, d]);
      const removed = view([a, c, d]);
      const restored = view([a, b, c, d]);
      const current = view([c, d, e]);
      const later = [removed, restored, ...(deletedAgain ? [removed] : [])];
      const merged = chainedTranscriptDelta(
        delta(current, { messageUpserts: [e] }),
        { base, later },
        current,
      )!;
      expect(merged.deletedMessageIds).toEqual(deletedAgain ? ["b"] : []);

      // A reader keeps aged-out rows outside its live window. Compare that held
      // history with a reader that consumed the deletion and restoration live.
      const applyHeld = (held: Map<string, unknown>, update: NativeAgentTranscriptDelta) => {
        for (const id of update.deletedMessageIds) held.delete(id);
        for (const message of [...update.messageUpserts, ...(update.revisedMessages ?? [])]) {
          held.set((message as Row).id, message);
        }
      };
      const sequential = new Map(base.messages.map((message) => [(message as Row).id, message]));
      applyHeld(sequential, delta(removed, { deletedMessageIds: ["b"] }));
      applyHeld(sequential, delta(restored, { messageUpserts: [b] }));
      if (deletedAgain) applyHeld(sequential, delta(removed, { deletedMessageIds: ["b"] }));
      applyHeld(sequential, delta(current, { messageUpserts: [e] }));
      const chained = new Map(base.messages.map((message) => [(message as Row).id, message]));
      applyHeld(chained, merged);
      expect([...chained.entries()].sort()).toEqual([...sequential.entries()].sort());
    },
  );

  test("carries a held row that changed before it aged out", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => row(id));
    const edited = row("a", "a edited");
    const current = view([c, d]);
    const merged = chainedTranscriptDelta(
      delta(current),
      { base: view([a, b, c]), later: [view([edited, b, c])] },
      current,
    )!;
    expect(merged.revisedMessages).toEqual([edited]);
  });

  test("carries the newest copy of a revised row no longer listed", () => {
    const [a, b] = ["a", "b"].map((id) => row(id));
    const older = row("old", "first revision");
    const newer = row("old", "second revision");
    const current = view([a, b]);
    const merged = chainedTranscriptDelta(
      delta(current),
      {
        base: view([a]),
        later: [
          view([a], { revisedMessages: [older] }),
          view([a, b], { revisedMessages: [newer] }),
        ],
      },
      current,
    )!;
    expect(merged.revisedMessages).toEqual([newer]);
  });

  test("the current view's copy of a revised row wins", () => {
    const [a] = ["a"].map((id) => row(id));
    const older = row("old", "first revision");
    const newest = row("old", "newest revision");
    const current = view([a], { revisedMessages: [newest] });
    const merged = chainedTranscriptDelta(
      delta(current, { revisedMessages: [newest] }),
      { base: view([a]), later: [view([a], { revisedMessages: [older] })] },
      current,
    )!;
    expect(merged.revisedMessages).toEqual([newest]);
  });

  test("never carries a row the reader already holds in that form", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => row(id));
    const current = view([b, c]);
    const merged = chainedTranscriptDelta(
      delta(current),
      { base: view([a, b]), later: [view([a, b, c])] },
      current,
    )!;
    expect(merged.revisedMessages).toBeUndefined();
  });

  test("never carries a part-trimmed head row over the copy the reader holds", () => {
    const [b, c] = ["b", "c"].map((id) => row(id));
    const whole = { ...row("a"), parts: [{ type: "text", text: "kept" }] };
    const trimmed = { ...row("a"), parts: [] };
    const current = view([b, c]);
    const merged = chainedTranscriptDelta(
      delta(current),
      {
        base: view([whole, b]),
        later: [
          view([trimmed, b], { messageWindow: { limit: 40, truncated: true, omittedParts: 1 } }),
        ],
      },
      current,
    )!;
    expect(merged.revisedMessages).toBeUndefined();
  });

  test("windows that share nothing need a snapshot, not a delta with a gap", () => {
    const current = view([row("c")]);
    expect(
      chainedTranscriptDelta(
        delta(current),
        { base: view([row("a")]), later: [view([row("b")])] },
        current,
      ),
    ).toBeNull();
  });

  test("more carried rows than a revised list may hold need a snapshot", () => {
    const current = view([row("a")]);
    const revisedMessages = Array.from(
      { length: NATIVE_AGENT_REVISED_MESSAGES_MAX + 1 },
      (_, index) => row(`old-${index}`, "small"),
    );
    expect(
      chainedTranscriptDelta(
        delta(current),
        { base: view([row("a")]), later: [view([row("a")], { revisedMessages })] },
        current,
      ),
    ).toBeNull();
  });

  test("more carried bytes than a revised list may hold need a snapshot", () => {
    const current = view([row("a")]);
    expect(
      chainedTranscriptDelta(
        delta(current),
        {
          base: view([row("a")]),
          later: [view([row("a")], { revisedMessages: [row("old", "o".repeat(300 * 1024))] })],
        },
        current,
      ),
    ).toBeNull();
  });
});
