import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  countSerializations,
  countStringifyCalls,
  countingMessages,
  measureIo,
  newTally,
} from "../../../scripts/efficiency/counters";
import {
  accountUpserts,
  emptyAccounting,
  holdSnapshot,
  ratio,
} from "../../../scripts/efficiency/delta-analysis";
import {
  dataUrlImagePart,
  idsDigest,
  immutablePrefixWithTail,
  interruptedJsonl,
  nestedAgentPart,
  prose,
  rewrittenHistory,
  rolloutJsonl,
  textMessages,
  toolResultPart,
} from "../../../scripts/efficiency/fixtures";
import {
  compareReports,
  createContext,
  percentile,
  runCase,
  summarizeReports,
  type EfficiencyReport,
} from "../../../scripts/efficiency/harness";
import {
  startResourceSampler,
  summarizeResources,
  type MemorySample,
} from "../../../scripts/efficiency/resources";
import { displayTailWorkload } from "../../../scripts/efficiency/workloads-storage";
import {
  activitySweepWorkload,
  fileTreeCacheWorkload,
  pipelineCheckpointWorkload,
  probeWorkload,
} from "../../../scripts/efficiency/workloads-supervision";

/**
 * The efficiency harness (scripts/efficiency), documented in
 * docs/development/efficiency-harness.md. These tests keep its fixtures
 * deterministic and content-free and its accounting exact. Most workloads
 * import repository modules and run through `mise run efficiency:baseline`,
 * not here; the supervision workloads (k to n) are cheap, so their counters
 * are pinned below.
 */

describe("efficiency fixtures", () => {
  test("prose has the exact requested UTF-8 size and is deterministic", () => {
    for (const kind of ["ascii", "multibyte"] as const) {
      for (const bytes of [0, 1, 7, 1024, 8 * 1024]) {
        const text = prose(bytes, kind, 3);
        expect(Buffer.byteLength(text)).toBe(bytes);
        expect(prose(bytes, kind, 3)).toBe(text);
      }
    }
    expect(prose(4096, "multibyte", 1)).toMatch(/[^\x00-\x7f]/);
  });

  test("generators are parameterized by size and stable across calls", () => {
    expect(JSON.stringify(textMessages(5, 100))).toBe(JSON.stringify(textMessages(5, 100)));
    expect(Buffer.byteLength(String(toolResultPart("t", 2048).toolOutput))).toBe(2048);
    const image = String(dataUrlImagePart("i", 3 * 1024).fileUrl);
    expect(image.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(image.split(",")[1]!, "base64").length).toBe(3 * 1024);
    const agent = nestedAgentPart("a", 3, 64);
    expect((agent.subagentActions as unknown[]).length).toBe(4);
  });

  test("a rewritten history replaces the tail with new ids", () => {
    const history = textMessages(10, 32);
    const rewritten = rewrittenHistory(history, 6, 3, 32);
    expect(rewritten.map((message) => message.id)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "r6",
      "r7",
      "r8",
    ]);
  });

  test("a changing tail extends its previous text; the prefix is shared", () => {
    const fixture = immutablePrefixWithTail(3, 64, 16);
    const early = fixture.tail(1).content;
    const later = fixture.tail(4).content;
    expect(later.startsWith(early)).toBe(true);
    expect(Buffer.byteLength(later)).toBe(16 * 5);
    expect(fixture.prefix).toHaveLength(3);
  });

  test("interrupted rollouts have one corrupt record and an unterminated tail", () => {
    const complete = rolloutJsonl(8, 32).split("\n");
    expect(complete.at(-1)).toBe("");
    const interrupted = interruptedJsonl(8, 32);
    expect(interrupted.endsWith("\n")).toBe(false);
    const lines = interrupted.split("\n");
    const unparseable = lines.filter((line) => {
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    });
    expect(unparseable).toHaveLength(2);
  });

  test("id digests carry a count and a hash, never the ids", () => {
    const digest = idsDigest(["private-a", "private-b"]);
    expect(digest).toMatch(/^2:[0-9a-z]+$/);
    expect(idsDigest(["private-a", "private-b"])).toBe(digest);
    expect(idsDigest(["private-b", "private-a"])).not.toBe(digest);
  });
});

describe("efficiency counters", () => {
  test("serialization counting keeps the encoding byte-identical", () => {
    const tally = newTally();
    const plain = textMessages(3, 40);
    const counted = countingMessages(textMessages(3, 40), tally);
    expect(JSON.stringify(counted)).toBe(JSON.stringify(plain));
    expect(tally.messages).toBe(3);
    expect(Object.keys(counted[0]!)).not.toContain("toJSON");
    expect({ ...counted[0]! }).toEqual(plain[0]!);
  });

  test("part counting is independent of message counting", () => {
    const tally = newTally();
    const message = countSerializations({ id: "m", parts: [{ id: "p" }] }, tally, "messages");
    countSerializations(message.parts[0]!, tally, "parts");
    JSON.stringify(message);
    expect(tally).toEqual({ messages: 1, parts: 1 });
  });

  test("stringify interception is always restored", async () => {
    const original = JSON.stringify;
    const counted = await countStringifyCalls(
      (value) => typeof value === "object",
      async () => {
        JSON.stringify({ a: 1 });
        JSON.stringify("text");
        return "done";
      },
    );
    expect(counted).toEqual({ result: "done", calls: 1 });
    await expect(
      countStringifyCalls(
        () => true,
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(JSON.stringify).toBe(original);
  });

  test("I/O measurement reports non-negative byte counts or nothing", async () => {
    const { result, io } = await measureIo(async () => 42);
    expect(result).toBe(42);
    if (io) {
      expect(io.readBytes).toBeGreaterThanOrEqual(0);
      expect(io.writeBytes).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("step-14 delta accounting", () => {
  const tool = (id: string, output: string) => ({
    type: "tool-invocation",
    content: "",
    toolUseId: id,
    toolOutput: output,
  });

  test("identical parts, grown text and the content mirror are counted separately", () => {
    const held = new Map<string, Record<string, unknown>>();
    const first = {
      id: "live",
      content: "hello",
      parts: [tool("t1", "one"), { type: "text", content: "hello", sourcePartId: "text" }],
    };
    holdSnapshot(held, [first]);
    const next = {
      id: "live",
      content: "hello world",
      parts: [tool("t1", "one"), { type: "text", content: "hello world", sourcePartId: "text" }],
    };
    const accounting = emptyAccounting();
    accountUpserts(accounting, held, [next]);
    expect(accounting).toEqual({
      upserts: 1,
      decodedUpsertBytes: Buffer.byteLength(JSON.stringify(next)),
      identicalPartBytes: Buffer.byteLength(JSON.stringify(tool("t1", "one"))),
      grownPartPrefixBytes: 5,
      contentPrefixBytes: 5,
      nestedIdenticalChildBytes: 0,
    });
    expect(held.get("live")).toBe(next);
  });

  test("identity, not position, matches parts; new parts repeat nothing", () => {
    const held = new Map<string, Record<string, unknown>>();
    holdSnapshot(held, [{ id: "m", content: "", parts: [tool("a", "x")] }]);
    const accounting = emptyAccounting();
    accountUpserts(accounting, held, [
      { id: "m", content: "", parts: [tool("b", "y"), tool("a", "x")] },
    ]);
    expect(accounting.identicalPartBytes).toBe(Buffer.byteLength(JSON.stringify(tool("a", "x"))));
  });

  test("identical children of a changed sub-agent part count as nested repeats", () => {
    const held = new Map<string, Record<string, unknown>>();
    const before = nestedAgentPart("agent", 2, 16);
    const after = nestedAgentPart("agent", 3, 16);
    holdSnapshot(held, [{ id: "m", content: "", parts: [before] }]);
    const accounting = emptyAccounting();
    accountUpserts(accounting, held, [{ id: "m", content: "", parts: [after] }]);
    const children = after.subagentActions as unknown[];
    expect(accounting.identicalPartBytes).toBe(0);
    expect(accounting.nestedIdenticalChildBytes).toBe(
      Buffer.byteLength(JSON.stringify(children[0])) +
        Buffer.byteLength(JSON.stringify(children[1])),
    );
  });

  test("a message the client never held repeats nothing", () => {
    const accounting = emptyAccounting();
    accountUpserts(accounting, new Map(), [{ id: "new", content: "x", parts: [tool("a", "x")] }]);
    expect(accounting.identicalPartBytes).toBe(0);
    expect(ratio(accounting.identicalPartBytes, accounting.decodedUpsertBytes)).toBe(0);
    expect(ratio(1, 3)).toBe(0.3333);
  });
});

describe("efficiency resources", () => {
  test("the sampler records late ticks, peaks and what a collection left", async () => {
    let clock = 0;
    let heap = 100;
    let collected = 0;
    const memory = (): MemorySample => ({ heapUsedBytes: heap, rssBytes: heap * 10 });
    const sampler = startResourceSampler(1, {
      now: () => clock,
      memory,
      collect: () => {
        collected += 1;
        heap = 150;
      },
    });
    heap = 400;
    // A case that never yields: the loop is held for 20 ms.
    clock = 21;
    const window = sampler.stop();
    expect(collected).toBe(1);
    expect(window.start).toEqual({ heapUsedBytes: 100, rssBytes: 1000 });
    expect(window.end).toEqual({ heapUsedBytes: 400, rssBytes: 4000 });
    expect(window.retained).toEqual({ heapUsedBytes: 150, rssBytes: 1500 });
    expect(window.peak).toEqual({ heapUsedBytes: 400, rssBytes: 4000 });
    expect(window.lagMs).toEqual([20]);
    const summary = summarizeResources([window, { ...window, lagMs: [1, 2] }]);
    expect(summary).toEqual({
      repetitions: 2,
      coldRetainedHeapDeltaBytes: 50,
      coldRssDeltaBytes: 3000,
      heapUsedPeakBytes: 400,
      rssPeakBytes: 4000,
      eventLoopLag: { samples: 3, p50Ms: 2, p99Ms: 20, maxMs: 20 },
    });
  });

  test("peak includes memory first reported by the final collection", () => {
    let heap = 100;
    const sampler = startResourceSampler(1, {
      now: () => 0,
      memory: () => ({ heapUsedBytes: heap, rssBytes: heap * 10 }),
      collect: () => {
        heap = 500;
      },
    });
    const window = sampler.stop();
    expect(window.end.heapUsedBytes).toBe(100);
    expect(window.peak).toEqual(window.retained);
    expect(summarizeResources([window])).toMatchObject({
      coldRetainedHeapDeltaBytes: 400,
      heapUsedPeakBytes: 500,
      rssPeakBytes: 5000,
    });
  });

  test("a sampler that yields records non-negative lag", async () => {
    const sampler = startResourceSampler(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const window = sampler.stop();
    expect(window.lagMs.length).toBeGreaterThan(0);
    expect(window.lagMs.every((lag) => lag >= 0)).toBe(true);
    expect(summarizeResources([]).eventLoopLag).toEqual({
      samples: 0,
      p50Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
  });

  test("cases carry resources unless sampling is off", async () => {
    const run = async () => ({ counters: { visits: 1 } });
    const sampled = await runCase({ id: "r", description: "", run }, 2);
    expect(sampled.resources?.repetitions).toBe(2);
    expect(sampled.resources?.eventLoopLag.samples).toBeGreaterThanOrEqual(0);
    expect(sampled.countersStable).toBe(true);
    const plain = await runCase({ id: "r", description: "", run }, 2, { sampleResources: false });
    expect(plain.resources).toBeUndefined();
  });
});

describe("supervision workloads", () => {
  const context = createContext(path.resolve(import.meta.dir, "../../.."));
  const counters = async (
    factory: typeof activitySweepWorkload,
    caseId: string,
  ): Promise<Record<string, unknown>> => {
    const workload = await factory(context);
    const definition = workload.cases.find((entry) => entry.id === caseId)!;
    const report = await runCase(definition, 2, { sampleResources: false });
    expect(report).toMatchObject({ supported: true, countersStable: true });
    return report.counters!;
  };

  test("the batch route answers 100 sessions in two requests; an older bridge in one each", async () => {
    expect(await counters(activitySweepWorkload, "batch-100")).toMatchObject({
      requests: 2,
      batchRequests: 2,
      singleRequests: 0,
      applied: 100,
    });
    expect(await counters(activitySweepWorkload, "older-bridge-100-x3")).toMatchObject({
      batchRequests: 2,
      batchRejected: 2,
      singleRequests: 300,
      applied: 300,
    });
  });

  test("a watched tree is walked once; an unwatched one per age bound", async () => {
    expect(await counters(fileTreeCacheWorkload, "watched-unchanged")).toMatchObject({
      reads: 20,
      walks: 1,
      cacheHits: 19,
    });
    expect(await counters(fileTreeCacheWorkload, "watched-mutation")).toMatchObject({
      walks: 2,
      distinctDigests: 2,
      finalRevision: 2,
    });
    const unwatched = await counters(fileTreeCacheWorkload, "unwatched-age-bound");
    expect(unwatched.walks as number).toBeGreaterThan(1);
  });

  test("unchanged probes are answered from the token", async () => {
    expect(await counters(probeWorkload, "progress-unchanged")).toMatchObject({
      "reads.unchanged": 10,
      "reads.snapshot": 1,
      "calls.messages": 0,
    });
    expect(await counters(probeWorkload, "reviewer-unchanged")).toMatchObject({
      "reads.unchanged": 10,
      "reads.snapshot": 1,
    });
  });

  test("an unchanged pipeline session is read whole and saved once", async () => {
    expect(await counters(pipelineCheckpointWorkload, "unchanged-session")).toMatchObject({
      wholeReads: 1,
      saves: 1,
      "store.commits": 1,
      "probes.unchanged": 19,
    });
    expect(await counters(pipelineCheckpointWorkload, "moving-session")).toMatchObject({
      wholeReads: 20,
      saves: 20,
    });
  });
});

describe("display-tail checkpoint age", () => {
  const context = createContext(path.resolve(import.meta.dir, "../../.."));
  const counters = async (caseId: string): Promise<Record<string, unknown>> => {
    const workload = await displayTailWorkload(context);
    const definition = workload.cases.find((entry) => entry.id === caseId)!;
    const report = await runCase(definition, 2, { sampleResources: false });
    expect(report).toMatchObject({ supported: true, countersStable: true });
    return report.counters!;
  };

  test("a streaming tail is checkpointed at the maximum age, and a quiet one after the quiet period", async () => {
    expect(await counters("age-stream-1")).toMatchObject({
      checkpointAgeMaxMs: 10_000,
      keysStaleAfterDrain: 0,
      maxConcurrentWrites: 1,
    });
    expect(await counters("age-burst-then-quiet")).toMatchObject({
      writes: 1,
      // The burst lasts 900 ms, then the 2 s quiet period.
      checkpointAgeMaxMs: 2_900,
    });
  });

  test("many streaming tails share the write pool, so slow writes push age past the bound", async () => {
    const slow = await counters("age-stream-128-slow-writes");
    expect(slow).toMatchObject({ maxConcurrentWrites: 2, keysStaleAfterDrain: 0 });
    expect(slow.checkpointAgeMaxMs as number).toBeGreaterThan(10_000);
  });
});

describe("efficiency harness", () => {
  const relocatedModules = [
    "progressive-transcript.ts",
    "transcript-window.ts",
    "bridge-transcript-routes.ts",
    "bridge-transcript-summary.ts",
  ];

  for (const layout of ["legacy", "current", "both"] as const) {
    test(`required and optional modules use the selected root's ${layout} layout`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "efficiency-loader-"));
      try {
        for (const directory of ["packages/protocol/src", "packages/protocol/src/node"]) {
          await mkdir(path.join(root, directory), { recursive: true });
          const source = directory.endsWith("/node") ? "current" : "legacy";
          if (layout !== "both" && source !== layout) continue;
          // A dependency beside the module must also come from this root.
          await writeFile(
            path.join(root, directory, "identity.ts"),
            `export const root = ${JSON.stringify(root)};`,
          );
          for (const name of relocatedModules) {
            await writeFile(
              path.join(root, directory, name),
              `export { root } from "./identity.ts"; export const layout = ${JSON.stringify(source)};`,
            );
          }
        }
        const context = createContext(root);
        for (const name of relocatedModules) {
          const relative = `packages/protocol/src/node/${name}`;
          const expected = { root, layout: layout === "legacy" ? "legacy" : "current" };
          expect(await context.load(relative)).toMatchObject(expected);
          expect(await context.loadOptional(relative)).toMatchObject(expected);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("missing modules never load from the harness checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "efficiency-loader-"));
    try {
      const context = createContext(root);
      for (const name of relocatedModules) {
        const relative = `packages/protocol/src/node/${name}`;
        expect(await context.loadOptional(relative)).toBeUndefined();
        await expect(context.load(relative)).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a current module's import failure is not hidden by the legacy fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "efficiency-loader-"));
    try {
      const directory = path.join(root, "packages/protocol/src");
      await mkdir(path.join(directory, "node"), { recursive: true });
      await writeFile(
        path.join(directory, "progressive-transcript.ts"),
        "export const legacy = true;",
      );
      await writeFile(
        path.join(directory, "node/progressive-transcript.ts"),
        'throw new Error("broken current module");',
      );
      const context = createContext(root);
      const relative = "packages/protocol/src/node/progressive-transcript.ts";
      await expect(context.load(relative)).rejects.toThrow("broken current module");
      await expect(context.loadOptional(relative)).rejects.toThrow("broken current module");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("percentiles use nearest rank", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });

  test("cases report counters from the cold run and flag unstable counters", async () => {
    let calls = 0;
    const stable = await runCase(
      { id: "s", description: "", run: async () => ({ counters: { visits: 3 }, measuredMs: 1 }) },
      4,
    );
    expect(stable).toMatchObject({
      supported: true,
      counters: { visits: 3 },
      countersStable: true,
    });
    expect(stable.timing).toMatchObject({ repetitions: 4, coldMs: 1, warmP50Ms: 1 });
    const unstable = await runCase(
      { id: "u", description: "", run: async () => ({ counters: { visits: (calls += 1) } }) },
      2,
    );
    expect(unstable).toMatchObject({ counters: { visits: 1 }, countersStable: false });
    expect(await runCase({ id: "x", description: "", unsupportedReason: "absent" }, 3)).toEqual({
      id: "x",
      description: "",
      supported: false,
      unsupportedReason: "absent",
    });
  });

  function report(label: string, visits: number, supported = true): EfficiencyReport {
    return {
      schemaVersion: 1,
      generatedBy: "scripts/efficiency/run.ts",
      runId: "r",
      label,
      source: { commit: label, appVersion: "0" },
      runtime: { bun: "0", platform: "test", arch: "test" },
      machine: { cpuModel: "test", cpuCount: 1, totalMemoryBytes: 1 },
      method: {},
      startedAt: "",
      finishedAt: "",
      workloads: [
        {
          id: "w",
          title: "",
          findings: ["E00"],
          fixture: {},
          method: "",
          cases: [
            supported
              ? {
                  id: "c",
                  description: "",
                  supported: true,
                  counters: { visits, status: "ok" },
                  countersStable: true,
                  timing: { repetitions: 1, coldMs: 9, warmP50Ms: 9, warmP95Ms: 9 },
                }
              : { id: "c", description: "", supported: false, unsupportedReason: "absent" },
          ],
        },
      ],
    };
  }

  test("comparison covers counters and availability, never timings or resources", () => {
    expect(compareReports(report("a", 1), report("b", 1))).toEqual([]);
    const withResources = (label: string, peak: number): EfficiencyReport => {
      const value = report(label, 1);
      value.workloads[0]!.cases[0]!.resources = {
        repetitions: 1,
        coldRetainedHeapDeltaBytes: peak,
        coldRssDeltaBytes: peak,
        heapUsedPeakBytes: peak,
        rssPeakBytes: peak,
        eventLoopLag: { samples: 1, p50Ms: peak, p99Ms: peak, maxMs: peak },
      };
      return value;
    };
    expect(compareReports(withResources("a", 1), withResources("b", 9))).toEqual([]);
    expect(
      JSON.stringify(summarizeReports(withResources("a", 1), withResources("b", 9))),
    ).not.toContain("heapUsedPeakBytes");
    expect(compareReports(report("a", 1), report("b", 2))).toEqual([
      { workload: "w", caseId: "c", counter: "visits", baseline: 1, candidate: 2 },
    ]);
    expect(compareReports(report("a", 1, false), report("b", 2))).toEqual([
      { workload: "w", caseId: "c", counter: "*", baseline: "unsupported", candidate: "supported" },
    ]);
  });

  test("the committed summary holds both runs' counters and no per-run detail", () => {
    const summary = summarizeReports(report("baseline", 10, false), report("head", 1));
    const serialized = JSON.stringify(summary);
    expect(serialized).toContain('"unsupported":"absent"');
    expect(serialized).toContain('"visits":1');
    expect(serialized).not.toContain("coldMs");
  });
});
