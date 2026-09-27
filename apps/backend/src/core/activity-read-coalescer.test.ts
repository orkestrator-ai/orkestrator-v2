import { describe, expect, test } from "bun:test";
import { SESSION_ACTIVITY_BATCH_LIMITS } from "@orkestrator/protocol/session-activity-batch";
import type {
  ProviderActivityBatchEntry,
  ProviderActivityObservation,
  ProviderActivityState,
} from "./agent-provider-contract.js";
import { ActivityReadCoalescer } from "./activity-read-coalescer.js";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import type { ActivityGroupProvider, ActivityGroupRead } from "./native-agent-activity-reads.js";

/** A bridge-backed provider surface that records every activity read. */
class BatchProvider {
  batchCalls: string[][] = [];
  singleCalls: string[] = [];
  entries = new Map<string, ProviderActivityBatchEntry>();
  singles = new Map<string, ProviderActivityObservation | Error>();
  batchAnswer: "entries" | "unsupported" | "reject" = "entries";

  async status(): Promise<"idle"> {
    throw new Error("status must not be read");
  }

  async observeActivity(sessionId: string): Promise<ProviderActivityObservation> {
    this.singleCalls.push(sessionId);
    const single = this.singles.get(sessionId) ?? { state: "idle" };
    if (single instanceof Error) throw single;
    return single;
  }

  async observeActivityBatch(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderActivityBatchEntry> | "unsupported"> {
    this.batchCalls.push([...sessionIds]);
    if (this.batchAnswer === "unsupported") return "unsupported";
    if (this.batchAnswer === "reject") throw new Error("bridge returned 503");
    return new Map(
      sessionIds.map((id) => [id, this.entries.get(id) ?? { state: "idle" as const }]),
    );
  }
}

type Settled = { value?: ActivityGroupRead; error?: unknown };

/** Read every id concurrently through one coalescer, keeping each outcome. */
async function readEach(
  coalescer: ActivityReadCoalescer,
  provider: ActivityGroupProvider,
  ids: string[],
): Promise<Map<string, Settled>> {
  const settled = await Promise.all(
    ids.map((id) =>
      coalescer.read(provider, id).then(
        (value): Settled => ({ value }),
        (error: unknown): Settled => ({ error }),
      ),
    ),
  );
  return new Map(ids.map((id, index) => [id, settled[index]!]));
}

describe("ActivityReadCoalescer", () => {
  test("concurrent reads of one provider become one batched request", async () => {
    const provider = new BatchProvider();
    provider.entries.set("a", { state: "working", readyForInput: true });
    provider.entries.set("b", { state: "waiting", asyncQuestionItemIds: ["q-1"] });
    const coalescer = new ActivityReadCoalescer(5);

    const reads = await Promise.all(["a", "b", "c"].map((id) => coalescer.read(provider, id)));

    expect(provider.batchCalls).toEqual([["a", "b", "c"]]);
    expect(provider.singleCalls).toEqual([]);
    expect(reads).toEqual([
      { state: "working", observation: { state: "working", readyForInput: true } },
      { state: "waiting", observation: { state: "waiting", asyncQuestionItemIds: ["q-1"] } },
      { state: "idle", observation: { state: "idle" } },
    ]);
  });

  test("reads are grouped per provider connection", async () => {
    const first = new BatchProvider();
    const second = new BatchProvider();
    const coalescer = new ActivityReadCoalescer(5);

    await Promise.all([
      coalescer.read(first, "a"),
      coalescer.read(second, "b"),
      coalescer.read(first, "c"),
    ]);

    expect(first.batchCalls).toEqual([["a", "c"]]);
    expect(second.batchCalls).toEqual([["b"]]);
  });

  test("a read arriving after the window opens a new batch", async () => {
    const provider = new BatchProvider();
    const coalescer = new ActivityReadCoalescer(1);
    await coalescer.read(provider, "a");
    await coalescer.read(provider, "b");
    expect(provider.batchCalls).toEqual([["a"], ["b"]]);
  });

  test("a full chunk is sent at once and later reads start the next one", async () => {
    const provider = new BatchProvider();
    // A window no test waits for: only the chunk bound can send the first batch.
    const coalescer = new ActivityReadCoalescer(60_000);
    const ids = Array.from(
      { length: SESSION_ACTIVITY_BATCH_LIMITS.maxSessions },
      (_, index) => `s-${index}`,
    );
    const full = Promise.all(ids.map((id) => coalescer.read(provider, id)));
    await full;
    expect(provider.batchCalls).toHaveLength(1);
    expect(provider.batchCalls[0]).toHaveLength(SESSION_ACTIVITY_BATCH_LIMITS.maxSessions);

    const late = new ActivityReadCoalescer(1);
    await Promise.all([...ids, "extra"].map((id) => late.read(provider, id)));
    expect(provider.batchCalls.slice(1).map((call) => call.length)).toEqual([
      SESSION_ACTIVITY_BATCH_LIMITS.maxSessions,
      1,
    ]);
  });

  test("missing, unavailable and deferred answers keep their exact meaning per caller", async () => {
    const provider = new BatchProvider();
    provider.entries.set("working", { state: "working" });
    provider.entries.set("gone", { state: "missing" });
    provider.entries.set("unknown", "unavailable");
    provider.entries.set("large", "deferred");
    provider.singles.set("large", { state: "waiting", asyncQuestionItemIds: ["q"] });
    const coalescer = new ActivityReadCoalescer(5);

    const reads = await readEach(coalescer, provider, ["working", "gone", "unknown", "large"]);

    expect(reads.get("working")?.value?.state).toBe("working");
    // `missing` is the bridge's proof of nonexistence, passed through as such.
    expect(reads.get("gone")?.value?.state).toBe("missing");
    // Uncertainty rejects that caller alone; it is never idle or missing.
    expect(reads.get("unknown")?.error).toBeInstanceOf(Error);
    expect(reads.get("unknown")?.value).toBeUndefined();
    // A deferred id is answered through the single no-touch route.
    expect(reads.get("large")?.value).toEqual({
      state: "waiting",
      observation: { state: "waiting", asyncQuestionItemIds: ["q"] },
    });
    expect(provider.singleCalls).toEqual(["large"]);
  });

  test("an older bridge falls back to independent single reads", async () => {
    const provider = new BatchProvider();
    provider.batchAnswer = "unsupported";
    provider.singles.set("a", { state: "working" });
    provider.singles.set("b", new Error("bridge timed out"));
    provider.singles.set("c", { state: "missing" });
    const coalescer = new ActivityReadCoalescer(5);

    const reads = await readEach(coalescer, provider, ["a", "b", "c"]);

    expect(provider.batchCalls).toEqual([["a", "b", "c"]]);
    expect(provider.singleCalls.sort()).toEqual(["a", "b", "c"]);
    expect(reads.get("a")?.value?.state).toBe("working");
    // One failed session does not stop or fail the others.
    expect((reads.get("b")!.error as Error).message).toBe("bridge timed out");
    expect(reads.get("c")?.value?.state).toBe("missing");
  });

  test("a rejected batch is not evidence about any session", async () => {
    const provider = new BatchProvider();
    provider.batchAnswer = "reject";
    provider.singles.set("a", { state: "working" });
    const coalescer = new ActivityReadCoalescer(5);

    const reads = await Promise.all(["a", "b"].map((id) => coalescer.read(provider, id)));

    expect(reads.map((read) => read.state)).toEqual(["working", "idle"]);
    expect(provider.singleCalls.sort()).toEqual(["a", "b"]);
  });

  test("a group-wide provider snapshot is read once and a gap fails only its caller", async () => {
    const calls: string[][] = [];
    const provider = {
      async status(): Promise<"idle"> {
        throw new Error("status must not be read");
      },
      async activity(): Promise<ProviderActivityState> {
        throw new Error("single reads must not run");
      },
      async activityBatch(sessionIds: readonly string[]) {
        calls.push([...sessionIds]);
        return new Map<string, ProviderActivityState>([["a", "working"]]);
      },
    };
    const coalescer = new ActivityReadCoalescer(5);

    const reads = await readEach(coalescer, provider, ["a", "b"]);

    expect(calls).toEqual([["a", "b"]]);
    expect(reads.get("a")?.value).toEqual({ state: "working" });
    expect(reads.get("b")?.error).toBeInstanceOf(Error);
  });

  test("only providers with a batch and a single activity read are coalesced", () => {
    const single = { observeActivity: async () => ({ state: "idle" as const }) };
    const batch = { observeActivityBatch: async () => "unsupported" as const };
    const status = { status: async () => "idle" as const };
    expect(ActivityReadCoalescer.batches({ ...single, ...batch, ...status })).toBe(true);
    expect(ActivityReadCoalescer.batches({ ...single, ...status })).toBe(false);
    // Without a single activity read the caller keeps its status observation.
    expect(ActivityReadCoalescer.batches({ ...batch, ...status })).toBe(false);
  });

  describe("against the HTTP bridge provider", () => {
    function bridge(batchRoute: "served" | "absent") {
      const activity: Record<string, string> = { "fix-1": "working", "fix-2": "idle" };
      return httpProvider(async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/sessions/activity") {
          if (batchRoute === "absent") return new Response("", { status: 404 });
          const { sessionIds } = JSON.parse(String(init.body)) as { sessionIds: string[] };
          return Response.json({
            version: 1,
            observations: Object.fromEntries(
              sessionIds.map((id) => [id, { activity: activity[id] ?? "missing" }]),
            ),
          });
        }
        const single = /^\/session\/([^/]+)\/activity$/.exec(path);
        if (single) {
          const id = decodeURIComponent(single[1]!);
          return activity[id]
            ? Response.json({ activity: activity[id] })
            : new Response("", { status: 404 });
        }
        return new Response("unexpected route", { status: 500 });
      }, codexConnection);
    }

    test("N fix sessions cost one no-touch batch request", async () => {
      const { provider, requests } = bridge("served");
      const coalescer = new ActivityReadCoalescer(5);

      const reads = await Promise.all(
        ["fix-1", "fix-2", "fix-3"].map((id) => coalescer.read(provider, id)),
      );

      expect(reads.map((read) => read.state)).toEqual(["working", "idle", "missing"]);
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/sessions/activity",
      ]);
    });

    test("an older bridge is read per session and not re-probed on the next round", async () => {
      const { provider, requests } = bridge("absent");
      const coalescer = new ActivityReadCoalescer(5);

      const first = await Promise.all(["fix-1", "fix-2"].map((id) => coalescer.read(provider, id)));
      const second = await Promise.all(
        ["fix-1", "fix-2"].map((id) => coalescer.read(provider, id)),
      );

      expect(first.map((read) => read.state)).toEqual(["working", "idle"]);
      expect(second.map((read) => read.state)).toEqual(["working", "idle"]);
      const paths = requests.map((request) => new URL(request.url).pathname);
      expect(paths.filter((path) => path === "/sessions/activity")).toHaveLength(1);
      expect(paths.filter((path) => path !== "/sessions/activity").sort()).toEqual([
        "/session/fix-1/activity",
        "/session/fix-1/activity",
        "/session/fix-2/activity",
        "/session/fix-2/activity",
      ]);
    });
  });
});
