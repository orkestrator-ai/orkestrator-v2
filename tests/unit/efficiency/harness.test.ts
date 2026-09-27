import { describe, expect, test } from "bun:test";
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
  percentile,
  runCase,
  summarizeReports,
  type EfficiencyReport,
} from "../../../scripts/efficiency/harness";

/**
 * The efficiency harness (scripts/efficiency) produces the committed baseline
 * in docs/improvements/efficiency/baseline. These tests keep its fixtures
 * deterministic and content-free and its accounting exact; the workloads
 * themselves import repository modules and run through `mise run
 * efficiency:baseline`, not here.
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

describe("efficiency harness", () => {
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

  test("comparison covers counters and availability, never timings", () => {
    expect(compareReports(report("a", 1), report("b", 1))).toEqual([]);
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
