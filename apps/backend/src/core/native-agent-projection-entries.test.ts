/**
 * Projected-row reuse (efficiency step 12): a changed read re-normalizes only
 * the rows that changed, and every reuse is indistinguishable from the
 * uncached projection — across contexts, rewinds, in-place mutation, detail
 * eviction and concurrent reads.
 */
import { describe, expect, test } from "bun:test";
import type { NativeAgentService } from "./native-agent-service.js";
import {
  ProjectedMessageCache,
  copyProjectionSource,
  sameProjectionSource,
  type ProjectionEntryContext,
} from "./native-agent-projection-entries.js";
import type { ProviderTranscriptSnapshot } from "./agent-provider-contract.js";
import {
  COORDINATOR_DELEGATION_FRAME_CLOSE,
  COORDINATOR_DELEGATION_FRAME_OPEN,
  COORDINATOR_DELEGATION_FRAME_SEPARATOR,
} from "@orkestrator/protocol/review-evidence-frames";
import {
  NATIVE_PROJECTION_MAX_BYTES,
  nativeAgentSessionStorageKey,
} from "./native-agent-service-shared.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

type PromptPresentation = { kind: "coordinator-delegation"; frame: string } | undefined;

interface ProjectionInternals {
  projectionMessages(
    sessionKey: string,
    messages: unknown[],
    limit: number,
    maximumBytes?: number,
    initialPromptPresentation?: PromptPresentation,
    coordinatorTranscript?: boolean,
    remote?: { providerSessionId: string },
  ): { messages: unknown[]; window: unknown };
  projectionPart(...args: unknown[]): unknown;
  toolDetailCache: Map<string, { sessionKey: string }>;
  projectedMessages: ProjectedMessageCache;
  invalidateProjection(key: string): void;
  getProjectionToolDetails(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const createdAt = "2026-09-27T00:00:00.000Z";

function row(index: number, extra = "") {
  return {
    id: `m${index}`,
    role: index === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${index}${extra}`,
    parts: [
      { type: "text", content: `text ${index}${extra}` },
      {
        type: "tool-invocation",
        toolName: "bash",
        toolState: "success",
        toolArgs: { command: `echo ${index}` },
        toolOutput: `output ${index} ${"x".repeat(300)}`,
      },
    ],
    createdAt,
  };
}

/** A fresh parse per read, as every HTTP bridge delivers. */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Count top-level part normalizations (nested children are part of one visit). */
function countVisits(view: ProjectionInternals): { readonly count: number; reset(): void } {
  const original = view.projectionPart.bind(view);
  let count = 0;
  view.projectionPart = (...args: unknown[]) => {
    if (typeof args[3] === "string" && !args[3].includes("/")) count += 1;
    return original(...args);
  };
  return {
    get count() {
      return count;
    },
    reset() {
      count = 0;
    },
  };
}

const view = (service: NativeAgentService) => service as unknown as ProjectionInternals;

/** Run `body` against a cached service and an uncached twin. */
async function withTwins(
  body: (cached: ProjectionInternals, uncached: ProjectionInternals) => Promise<void>,
): Promise<void> {
  await withService({ prefix: "orkestrator-projection-reuse-" }, async ({ service }) => {
    await withService(
      {
        prefix: "orkestrator-projection-uncached-",
        projectedMessageCacheLimits: { maxEntries: 0 },
      },
      async ({ service: baseline }) => {
        await body(view(service), view(baseline));
      },
    );
  });
}

const project = (
  target: ProjectionInternals,
  sessionKey: string,
  rows: unknown[],
  options: {
    presentation?: PromptPresentation;
    coordinator?: boolean;
    remote?: { providerSessionId: string };
  } = {},
) =>
  target.projectionMessages(
    sessionKey,
    rows,
    rows.length,
    NATIVE_PROJECTION_MAX_BYTES,
    options.presentation,
    options.coordinator ?? false,
    options.remote,
  );

const json = (value: unknown) => JSON.stringify(value);

describe("projection source comparison", () => {
  test("equal rows match; any value, key order or shape change does not", () => {
    const source = { id: "a", parts: [{ type: "text", content: "x", meta: { n: 1 } }] };
    const copied = copyProjectionSource(source)!;
    expect(copied.copy).not.toBe(source);
    expect(sameProjectionSource(fresh(source), copied.copy)).toBe(true);
    expect(
      sameProjectionSource(
        { id: "a", parts: [{ type: "text", content: "x", meta: { n: 2 } }] },
        copied.copy,
      ),
    ).toBe(false);
    // Key order reaches the encoded projection, so it must match too.
    expect(sameProjectionSource({ parts: fresh(source.parts), id: "a" }, copied.copy)).toBe(false);
    expect(sameProjectionSource({ ...fresh(source), extra: undefined }, copied.copy)).toBe(false);
    expect(sameProjectionSource({ id: "a", parts: [] }, copied.copy)).toBe(false);
  });

  test("a copy is private: mutating the provider row afterwards is detected", () => {
    const source = { id: "a", parts: [{ type: "text", content: "x" }] };
    const copied = copyProjectionSource(source)!;
    source.parts[0]!.content = "y";
    expect(sameProjectionSource(source, copied.copy)).toBe(false);
  });

  test("an own __proto__ key is copied as data, and non-JSON rows are not cached", () => {
    const parsed = JSON.parse('{"id":"a","__proto__":{"polluted":true}}') as object;
    const copied = copyProjectionSource(parsed)!;
    expect(Object.getPrototypeOf(copied.copy)).toBe(Object.prototype);
    expect(
      sameProjectionSource(JSON.parse('{"id":"a","__proto__":{"polluted":true}}'), copied.copy),
    ).toBe(true);
    expect(copyProjectionSource({ id: "a", at: new Date(0) })).toBeUndefined();
    // eslint-disable-next-line no-sparse-arrays
    expect(copyProjectionSource({ id: "a", parts: [1, , 3] })).toBeUndefined();
  });
});

describe("projected message cache bounds", () => {
  const context = (sessionKey: string): ProjectionEntryContext => ({
    sessionKey,
    coordinator: false,
  });
  const entry = (content: string) => ({ projected: { content }, details: [], encodedBytes: 100 });

  test("count, byte and per-session ceilings evict least recently used rows", () => {
    const cache = new ProjectedMessageCache({
      maxEntries: 4,
      maxBytes: 1_000_000,
      maxSessionEntries: 3,
      maxSessionBytes: 1_000_000,
      maxEntryBytes: 1_000_000,
    });
    for (const id of ["a", "b", "c", "d"]) {
      cache.store(context("s1"), id, copyProjectionSource({ id })!, undefined, entry(id));
    }
    // The session ceiling (3) evicted "a".
    expect(cache.size).toBe(3);
    expect(cache.lookup(context("s1"), "a", { id: "a" }, undefined)).toBeUndefined();
    expect(cache.lookup(context("s1"), "b", { id: "b" }, undefined)).toBeDefined();
    cache.store(context("s2"), "x", copyProjectionSource({ id: "x" })!, undefined, entry("x"));
    cache.store(context("s2"), "y", copyProjectionSource({ id: "y" })!, undefined, entry("y"));
    // The global ceiling (4) evicted the least recently used row, "c".
    expect(cache.size).toBe(4);
    expect(cache.lookup(context("s1"), "c", { id: "c" }, undefined)).toBeUndefined();
    expect(cache.lookup(context("s1"), "b", { id: "b" }, undefined)).toBeDefined();

    const bytes = new ProjectedMessageCache({
      maxEntries: 100,
      maxBytes: 600,
      maxSessionEntries: 100,
      maxSessionBytes: 100_000,
      maxEntryBytes: 400,
    });
    for (const id of ["a", "b", "c", "d"]) {
      bytes.store(context("s1"), id, copyProjectionSource({ id })!, undefined, entry(id));
    }
    expect(bytes.bytes).toBeLessThanOrEqual(600);
    expect(bytes.size).toBeLessThan(4);
    // A row over the per-entry ceiling is never admitted.
    bytes.store(context("s1"), "big", copyProjectionSource({ id: "big" })!, undefined, {
      ...entry("big"),
      encodedBytes: 500,
    });
    expect(bytes.lookup(context("s1"), "big", { id: "big" }, undefined)).toBeUndefined();
    bytes.forgetSession("s1");
    expect(bytes.size).toBe(0);
    expect(bytes.bytes).toBe(0);
  });

  test("contexts never share an entry", () => {
    const cache = new ProjectedMessageCache({
      maxEntries: 10,
      maxBytes: 1_000_000,
      maxSessionEntries: 10,
      maxSessionBytes: 1_000_000,
      maxEntryBytes: 1_000_000,
    });
    const base = context("s1");
    cache.store(base, "a", copyProjectionSource({ id: "a" })!, undefined, entry("a"));
    expect(cache.lookup(base, "a", { id: "a" }, undefined)).toBeDefined();
    expect(cache.lookup(context("s2"), "a", { id: "a" }, undefined)).toBeUndefined();
    expect(
      cache.lookup({ ...base, coordinator: true }, "a", { id: "a" }, undefined),
    ).toBeUndefined();
    expect(
      cache.lookup({ ...base, remoteSessionId: "p" }, "a", { id: "a" }, undefined),
    ).toBeUndefined();
    expect(cache.lookup(base, "a", { id: "a" }, "coordinator-delegation")).toBeUndefined();
  });
});

describe("projected row reuse", () => {
  test("a tail-only change over 1,000 immutable rows re-normalizes one row, with exact parity", async () => {
    await withTwins(async (cached, uncached) => {
      const history = Array.from({ length: 1_000 }, (_, index) => row(index));
      const visits = countVisits(cached);
      const first = project(cached, "session-a", fresh(history));
      expect(visits.count).toBe(2_000);
      expect(json(first)).toBe(json(project(uncached, "session-a", fresh(history))));

      history[999] = row(999, " streaming");
      visits.reset();
      const second = project(cached, "session-a", fresh(history));
      // Only the changed tail row's two parts were normalized again.
      expect(visits.count).toBe(2);
      expect(json(second)).toBe(json(project(uncached, "session-a", fresh(history))));
      // The immutable prefix keeps its projected objects.
      expect(second.messages[0]).toBe(first.messages[0]);
      expect(second.messages[998]).toBe(first.messages[998]);
      expect(second.messages[999]).not.toBe(first.messages[999]);

      // Unchanged content, fresh objects: nothing is normalized at all.
      visits.reset();
      const third = project(cached, "session-a", fresh(history));
      expect(visits.count).toBe(0);
      expect(third.messages[999]).toBe(second.messages[999]);
    });
  });

  test("a reused row keeps its detail references resolvable after detail eviction", async () => {
    await withTwins(async (cached) => {
      const sessionKey = "session-details";
      const history = Array.from({ length: 5 }, (_, index) => row(index));
      const first = project(cached, sessionKey, fresh(history));
      const detailRef = (first.messages[3] as { parts: Array<{ detailRef?: string }> }).parts[1]!
        .detailRef!;
      expect(cached.toolDetailCache.has(detailRef)).toBe(true);

      // Evict the inline body: only a fresh normalization of that row can
      // register it again, so the row is projected rather than reused.
      cached.toolDetailCache.delete(detailRef);
      const visits = countVisits(cached);
      const second = project(cached, sessionKey, fresh(history));
      expect(visits.count).toBe(2);
      expect(cached.toolDetailCache.has(detailRef)).toBe(true);
      expect(json(second)).toBe(json(first));

      // A provider-held (summary) detail needs no body: it is re-registered
      // from its locator without projecting the row again.
      const locator = `bd1.${Buffer.from(
        JSON.stringify({ m: "r1", p: ["0"], d: "digest" }),
      ).toString("base64url")}`;
      const summary = [
        {
          id: "r1",
          role: "assistant",
          content: "summary",
          parts: [
            {
              type: "tool-invocation",
              toolName: "bash",
              toolState: "success",
              detail: { locator, bytes: 10_000, fields: ["toolOutput"] },
            },
          ],
          createdAt,
        },
      ];
      const remote = { providerSessionId: "provider-1" };
      const withRemote = project(cached, sessionKey, fresh(summary), { remote });
      const remoteRef = (withRemote.messages[0] as { parts: Array<{ detailRef: string }> })
        .parts[0]!.detailRef;
      cached.toolDetailCache.delete(remoteRef);
      visits.reset();
      const again = project(cached, sessionKey, fresh(summary), { remote });
      expect(visits.count).toBe(0);
      expect(again.messages[0]).toBe(withRemote.messages[0]);
      expect(cached.toolDetailCache.get(remoteRef)?.sessionKey).toBe(sessionKey);
    });
  });

  test("rewind and replacement cannot reuse rows of the old history", async () => {
    await withTwins(async (cached, uncached) => {
      const sessionKey = "session-rewind";
      const history = Array.from({ length: 20 }, (_, index) => row(index));
      project(cached, sessionKey, fresh(history));
      expect(cached.projectedMessages.size).toBe(20);

      // A rewind (a session action) invalidates the session: every row is
      // normalized again even though its content is unchanged.
      cached.invalidateProjection(sessionKey);
      expect(cached.projectedMessages.size).toBe(0);
      const visits = countVisits(cached);
      project(cached, sessionKey, fresh(history));
      expect(visits.count).toBe(40);

      // A replaced history reusing the same ids with different content misses
      // on every replaced row, whatever the cache still holds.
      const replaced = history.map((_, index) => row(index, index % 2 ? " replaced" : ""));
      visits.reset();
      const projected = project(cached, sessionKey, fresh(replaced));
      expect(visits.count).toBe(20);
      expect(json(projected)).toBe(json(project(uncached, sessionKey, fresh(replaced))));
    });
  });

  test("a provider that mutates and re-serves its own row objects never hits a stale entry", async () => {
    await withTwins(async (cached, uncached) => {
      const history = Array.from({ length: 3 }, (_, index) => row(index));
      project(cached, "session-mutable", history);
      history[1]!.parts[0]!.content = "edited in place";
      const second = project(cached, "session-mutable", history);
      expect(json(second)).toBe(json(project(uncached, "session-mutable", fresh(history))));
      expect(json(second)).toContain("edited in place");
    });
  });

  test("identical rows projected for different logical contexts stay distinct", async () => {
    await withTwins(async (cached, uncached) => {
      const frame = `${COORDINATOR_DELEGATION_FRAME_OPEN}\nmetadata\n${COORDINATOR_DELEGATION_FRAME_CLOSE}`;
      const history = [
        { ...row(0), content: `${frame}${COORDINATOR_DELEGATION_FRAME_SEPARATOR}Task` },
        row(1),
      ];
      const variants = [
        { sessionKey: "ctx-a", options: {} },
        { sessionKey: "ctx-b", options: {} },
        { sessionKey: "ctx-a", options: { coordinator: true } },
        {
          sessionKey: "ctx-a",
          options: { presentation: { kind: "coordinator-delegation" as const, frame } },
        },
      ];
      // Twice, so the second pass exercises reuse in every context.
      for (let pass = 0; pass < 2; pass += 1) {
        for (const variant of variants) {
          expect(json(project(cached, variant.sessionKey, fresh(history), variant.options))).toBe(
            json(project(uncached, variant.sessionKey, fresh(history), variant.options)),
          );
        }
      }
      const refOf = (sessionKey: string) =>
        (
          project(cached, sessionKey, fresh(history)).messages[1] as {
            parts: Array<{ detailRef: string }>;
          }
        ).parts[1]!.detailRef;
      expect(refOf("ctx-a")).not.toBe(refOf("ctx-b"));
    });
  });
});

describe("projected row reuse through transcript reads", () => {
  test("concurrent reads, invalidation and a tiny cache keep uncached output", async () => {
    const identity = {
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "env-env-1:reuse",
    };
    const liveWindow = { messages: 60, targetBytes: 512 * 1024 };
    const history = Array.from({ length: 60 }, (_, index) => row(index));
    let revision = 1;
    const gates: Array<() => void> = [];
    const snapshot = async (): Promise<ProviderTranscriptSnapshot> => {
      // Capture before waiting, so each read serves the history it started on.
      const messages = fresh(history);
      const at = revision;
      await new Promise<void>((resolve) => gates.push(resolve));
      return {
        messages,
        complete: true,
        revision: at,
        historyEpoch: "g:1",
        sourceToken: `t${at}`,
        freshness: "current",
      };
    };
    const run = async (limits: { maxEntries: number; maxBytes?: number }) => {
      const outputs: string[] = [];
      const stub = createProviderStub("codex", { transcriptSnapshot: snapshot });
      await withService(
        {
          prefix: "orkestrator-projection-concurrent-",
          provider: async () => stub.provider,
          projectedMessageCacheLimits: limits,
        },
        async ({ service }) => {
          await service.ensureSession(identity);
          const read = () =>
            service.getTranscriptUpdate({
              ...identity,
              viewVersion: 1,
              liveWindow,
              forceSnapshot: true,
            });
          /** Release provider reads as they arrive until `pending` settles. */
          const drain = async <T>(pending: Promise<T>): Promise<T> => {
            let settled = false;
            const done = pending.finally(() => {
              settled = true;
            });
            while (!settled) {
              gates.splice(0).forEach((open) => open());
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
            return done;
          };
          for (let round = 0; round < 4; round += 1) {
            history[59] = row(59, ` round ${round}`);
            history[round] = row(round, ` edited ${round}`);
            revision += 1;
            const first = read();
            while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
            // A second read and an invalidation (a rewind or steer) land while
            // the first provider read is still outstanding.
            const second = read();
            view(service).invalidateProjection(
              nativeAgentSessionStorageKey(
                identity.environmentId,
                identity.agent,
                identity.logicalSessionKey,
              ),
            );
            for (const update of await drain(Promise.all([first, second]))) {
              if (update.status !== "snapshot") throw new Error("expected a snapshot");
              outputs.push(json(update.value.messages));
            }
            const cache = view(service).projectedMessages;
            expect(cache.size).toBeLessThanOrEqual(limits.maxEntries);
            if (limits.maxBytes !== undefined) {
              expect(cache.bytes).toBeLessThanOrEqual(limits.maxBytes);
            }
          }
        },
      );
      return outputs;
    };
    const cachedOutputs = await run({ maxEntries: 25, maxBytes: 40_000 });
    revision = 1;
    history.splice(0, history.length, ...Array.from({ length: 60 }, (_, index) => row(index)));
    const uncachedOutputs = await run({ maxEntries: 0 });
    expect(cachedOutputs).toEqual(uncachedOutputs);
  });
});
