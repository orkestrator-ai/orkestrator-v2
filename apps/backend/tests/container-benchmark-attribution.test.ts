import { describe, expect, test } from "bun:test";
import {
  attributeCalls,
  collectBreakdowns,
  createdName,
  dockerVerb,
  freshIdentities,
  totalsBy,
} from "./container-benchmark-attribution";

describe("benchmark Docker call attribution", () => {
  test("parses simple and compound verbs and only names container creates", () => {
    for (const [args, verb, name] of [
      [[], "none", null],
      [["--debug"], "none", null],
      [["--debug", "create", "--name", "runtime"], "create", "runtime"],
      [["container", "create", "--name", "runtime"], "container create", "runtime"],
      [["run", "--rm", "--name", "helper"], "run", "helper"],
      [["create", "--name"], "create", null],
      [["inspect", "--name", "not-a-create"], "inspect", null],
      [["volume", "create", "--name", "workspace"], "volume create", null],
      [["network", "inspect", "network"], "network inspect", null],
      [["image", "inspect", "image"], "image inspect", null],
      [["system", "info"], "system info", null],
    ] as const) {
      expect(dockerVerb(args)).toBe(verb);
      expect(createdName(args)).toBe(name);
    }
  });

  test("derives gateway and runtime identities without mistaking a helper for the runtime", () => {
    expect(
      freshIdentities(
        [
          { args: ["create", "--name", "runtime-egress", "image"] },
          { args: ["create", "--name", "runtime", "--network", "container:gateway-id", "image"] },
          { args: ["run", "--name", "storage-helper", "image"] },
        ],
        "runtime-id",
      ),
    ).toEqual({ runtime: ["runtime-id", "runtime"], gateway: ["gateway-id", "runtime-egress"] });
    expect(freshIdentities([{ args: ["create", "--name", "runtime", "image"] }], "id")).toEqual({
      runtime: ["id", "runtime"],
      gateway: [],
    });
    expect(freshIdentities([], "id")).toEqual({ runtime: ["id"], gateway: [] });
  });

  test("classifies creates, namespace joins, copies and helpers and reconciles every call", () => {
    const calls = [
      { step: "storage", args: ["volume", "create", "workspace"] },
      { step: "storage", args: ["run", "--name", "helper", "image"] },
      { step: "create", args: ["network", "inspect", "network"] },
      { step: "create", args: ["create", "--name", "runtime-egress", "image"] },
      { step: "create", args: ["cp", "/seed", "gateway-id:/seed"] },
      {
        step: "create",
        args: [
          "container",
          "create",
          "--name",
          "runtime",
          "--network",
          "container:gateway-id",
          "image",
        ],
      },
      { step: "boot.gateway", args: ["inspect", "container:gateway-id"] },
      { step: "boot.gateway", args: ["exec", "runtime-egress", "sh"] },
      { step: "boot.runtimeStart", args: ["start", "runtime-id"] },
      { step: "boot.ready", args: ["exec", "runtime-id", "sh"] },
      { step: "boot.ready", args: ["exec", "runtime-id", "sh"] },
      { step: "copy", args: ["cp", "runtime:/workspace", "/out"] },
      { step: "other", args: ["inspect", "runtime-id-unrelated"] },
    ];
    const breakdown = attributeCalls(calls, freshIdentities(calls, "runtime-id"));
    expect(breakdown).toEqual({
      "storage other volume create": 1,
      "storage other run": 1,
      "create other network inspect": 1,
      "create gateway create": 1,
      "create gateway cp": 1,
      "create runtime container create": 1,
      "boot.gateway gateway inspect": 1,
      "boot.gateway gateway exec": 1,
      "boot.runtimeStart runtime start": 1,
      "boot.ready runtime exec": 2,
      "copy runtime cp": 1,
      "other other inspect": 1,
    });
    expect(totalsBy(breakdown, 0)).toEqual({
      storage: 2,
      create: 4,
      "boot.gateway": 2,
      "boot.runtimeStart": 1,
      "boot.ready": 2,
      copy: 1,
      other: 1,
    });
    expect(totalsBy(breakdown, 1)).toEqual({ runtime: 5, gateway: 4, other: 4 });
    for (const counts of [breakdown, totalsBy(breakdown, 0), totalsBy(breakdown, 1)]) {
      expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(calls.length);
    }
  });

  test("zero-fills missing sample buckets while preserving sample totals and order", () => {
    const samples: Array<Record<string, number>> = [
      { "boot.ready runtime exec": 2 },
      {},
      { "create gateway create": 1 },
    ];
    const collected = collectBreakdowns(samples);
    expect(collected).toEqual({
      "boot.ready runtime exec": [2, 0, 0],
      "create gateway create": [0, 0, 1],
    });
    expect(Object.keys(collected)).toEqual(["boot.ready runtime exec", "create gateway create"]);
    for (let index = 0; index < samples.length; index += 1) {
      expect(Object.values(collected).reduce((sum, counts) => sum + counts[index]!, 0)).toBe(
        Object.values(samples[index]!).reduce((sum, count) => sum + count, 0),
      );
    }
    expect(collectBreakdowns([])).toEqual({});
    expect(attributeCalls([], { runtime: [], gateway: [] })).toEqual({});
  });
});
