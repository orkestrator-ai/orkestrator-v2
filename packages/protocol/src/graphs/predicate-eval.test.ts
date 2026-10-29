import { describe, expect, test } from "bun:test";
import { GRAPH_TEMPLATE_BOUNDS as B } from "./grammar";
import {
  GRAPH_PREDICATE_EVAL_ERROR_CODES,
  type GraphPredicateEnvironment,
  type GraphPredicateEvalErrorCode,
  type GraphPredicateTruth,
  evaluateGraphElementPredicate,
  evaluateGraphPredicate,
  filterGraphPredicateList,
  graphNodePredicateScope,
  typeCheckGraphPredicate,
  validateGraphPredicate,
} from "./predicates";
import { GraphTypeLibrary } from "./types";

const report = {
  issues: [{ severity: "P0" }, { severity: "P2" }],
  testCoverageGaps: [],
  verdict: { ready: "with-fixes", reasoning: "One bug." },
  summaryOfChange: "Adds CSV export.",
  confidence: 80,
  score: 0.5,
  line: null,
  flag: false,
};

const environment: GraphPredicateEnvironment = {
  values: { report, "verify.verdict": { complete: true }, failures: [] },
  params: { autoFix: true, mode: "fast", threshold: 0.25 },
  run: { iteration: 2 },
};

function truthOf(predicate: unknown, env: GraphPredicateEnvironment = environment) {
  const result = evaluateGraphPredicate(predicate, env);
  expect(result.value).toBe(result.truth === "true");
  return result.truth;
}

/** A sparse array of `length` holes, built without allocating elements. */
function holes(length: number): unknown[] {
  const array: unknown[] = [];
  array.length = length;
  return array;
}

type Row = [string, unknown, GraphPredicateTruth];

const leaf = (path: string, op: string, value?: unknown) =>
  value === undefined ? { path, op } : { path, op, value };

describe("predicate evaluator: operators", () => {
  const rows: Record<string, Row[]> = {
    eq: [
      ["equal strings", leaf("report.verdict.ready", "eq", "with-fixes"), "true"],
      ["different strings", leaf("report.verdict.ready", "eq", "yes"), "false"],
      ["equal numbers", leaf("report.confidence", "eq", 80), "true"],
      ["equal booleans", leaf("report.flag", "eq", false), "true"],
      ["null equals null", leaf("report.line", "eq", null), "true"],
      ["a value is not null", leaf("report.confidence", "eq", null), "false"],
      ["null is not a value", leaf("report.line", "eq", 3), "false"],
      ["a number is not compared with a string", leaf("report.confidence", "eq", "80"), "unknown"],
      ["a list is not a scalar", leaf("report.issues", "eq", 2), "unknown"],
      ["a missing field", leaf("report.nope", "eq", 1), "unknown"],
    ],
    neq: [
      ["different strings", leaf("report.verdict.ready", "neq", "yes"), "true"],
      ["equal strings", leaf("report.verdict.ready", "neq", "with-fixes"), "false"],
      ["a value is not null", leaf("report.confidence", "neq", null), "true"],
      ["mixed primitive types", leaf("report.flag", "neq", "false"), "unknown"],
      ["a missing field", leaf("report.nope", "neq", 1), "unknown"],
    ],
    lt: [
      ["less", leaf("report.score", "lt", 1), "true"],
      ["equal", leaf("report.score", "lt", 0.5), "false"],
      ["a string", leaf("report.summaryOfChange", "lt", 1), "unknown"],
      ["null", leaf("report.line", "lt", 1), "unknown"],
    ],
    lte: [
      ["equal", leaf("report.score", "lte", 0.5), "true"],
      ["greater", leaf("report.confidence", "lte", 79), "false"],
      ["a boolean", leaf("report.flag", "lte", 1), "unknown"],
    ],
    gt: [
      ["greater", leaf("run.iteration", "gt", 1), "true"],
      ["equal", leaf("run.iteration", "gt", 2), "false"],
      ["missing", leaf("run.attempt", "gt", 1), "unknown"],
    ],
    gte: [
      ["equal", leaf("report.confidence", "gte", 80), "true"],
      ["less", leaf("params.threshold", "gte", 0.5), "false"],
      ["a list", leaf("report.issues", "gte", 0), "unknown"],
    ],
    in: [
      ["listed", leaf("report.verdict.ready", "in", ["yes", "with-fixes"]), "true"],
      ["not listed", leaf("params.mode", "in", ["thorough"]), "false"],
      ["listed among other types", leaf("report.confidence", "in", ["80", 80]), "true"],
      ["only other types listed", leaf("report.confidence", "in", ["80", true]), "unknown"],
      ["null listed", leaf("report.line", "in", [1, null]), "true"],
      ["null not listed", leaf("report.line", "in", [1, 2]), "false"],
      ["an object", leaf("report.verdict", "in", ["x"]), "unknown"],
      ["missing", leaf("report.nope", "in", ["x"]), "unknown"],
    ],
    exists: [
      ["a value", leaf("report.verdict", "exists"), "true"],
      ["an empty list", leaf("report.testCoverageGaps", "exists"), "true"],
      ["false", leaf("report.flag", "exists"), "true"],
      ["null", leaf("report.line", "exists"), "false"],
      ["missing", leaf("report.nope", "exists"), "false"],
      ["a missing root", leaf("plan.commands", "exists"), "false"],
    ],
    empty: [
      ["an empty list", leaf("report.testCoverageGaps", "empty"), "true"],
      ["a list", leaf("report.issues", "empty"), "false"],
      ["a string", leaf("report.summaryOfChange", "empty"), "false"],
      ["a list root", leaf("failures", "empty"), "true"],
      ["null", leaf("report.line", "empty"), "unknown"],
      ["a number", leaf("report.confidence", "empty"), "unknown"],
      ["an object", leaf("report.verdict", "empty"), "unknown"],
    ],
    nonEmpty: [
      ["a list", leaf("report.issues", "nonEmpty"), "true"],
      ["an empty list", leaf("report.testCoverageGaps", "nonEmpty"), "false"],
      ["a string", leaf("params.mode", "nonEmpty"), "true"],
      ["missing", leaf("report.nope", "nonEmpty"), "unknown"],
    ],
    count: [
      ["eq", { path: "report.issues", op: "count", compare: "eq", value: 2 }, "true"],
      ["neq", { path: "report.issues", op: "count", compare: "neq", value: 2 }, "false"],
      ["lt", { path: "report.issues", op: "count", compare: "lt", value: 3 }, "true"],
      ["lte", { path: "report.issues", op: "count", compare: "lte", value: 1 }, "false"],
      ["gt", { path: "report.testCoverageGaps", op: "count", compare: "gt", value: 0 }, "false"],
      ["gte", { path: "report.issues", op: "count", compare: "gte", value: 2 }, "true"],
      ["a string", { path: "params.mode", op: "count", compare: "gt", value: 0 }, "unknown"],
      ["missing", { path: "report.nope", op: "count", compare: "eq", value: 0 }, "unknown"],
    ],
    all: [
      [
        "every child true",
        { all: [leaf("report.issues", "nonEmpty"), leaf("params.autoFix", "eq", true)] },
        "true",
      ],
      [
        "one child false",
        { all: [leaf("report.issues", "nonEmpty"), leaf("params.autoFix", "eq", false)] },
        "false",
      ],
      [
        "false beats unknown",
        { all: [leaf("report.nope", "nonEmpty"), leaf("report.issues", "empty")] },
        "false",
      ],
      [
        "unknown beats true",
        { all: [leaf("report.nope", "nonEmpty"), leaf("report.issues", "nonEmpty")] },
        "unknown",
      ],
    ],
    any: [
      [
        "one child true",
        { any: [leaf("report.testCoverageGaps", "nonEmpty"), leaf("report.issues", "nonEmpty")] },
        "true",
      ],
      [
        "every child false",
        { any: [leaf("report.testCoverageGaps", "nonEmpty"), leaf("report.issues", "empty")] },
        "false",
      ],
      [
        "true beats unknown",
        { any: [leaf("report.nope", "nonEmpty"), leaf("report.issues", "nonEmpty")] },
        "true",
      ],
      [
        "unknown beats false",
        { any: [leaf("report.nope", "nonEmpty"), leaf("report.issues", "empty")] },
        "unknown",
      ],
    ],
    not: [
      ["negates true", { not: leaf("report.issues", "nonEmpty") }, "false"],
      ["negates false", { not: leaf("report.issues", "empty") }, "true"],
      ["keeps unknown", { not: leaf("report.nope", "nonEmpty") }, "unknown"],
      ["tests absence with exists", { not: leaf("report.nope", "exists") }, "true"],
      ["double negation", { not: { not: leaf("run.iteration", "eq", 2) } }, "true"],
    ],
  };

  for (const [op, table] of Object.entries(rows)) {
    test.each(table)(`${op}: %s`, (_name, predicate, truth) => {
      expect(truthOf(predicate)).toBe(truth);
    });
  }

  test("reports unknown paths, bounded", () => {
    const result = evaluateGraphPredicate(
      { any: Array.from({ length: 12 }, (_, index) => leaf(`report.missing${index}`, "nonEmpty")) },
      environment,
    );
    expect(result).toMatchObject({ value: false, truth: "unknown" });
    expect(result.unknownPaths).toHaveLength(8);
    expect(result.unknownPaths[0]).toBe("report.missing0");
  });
});

describe("predicate evaluator: roots", () => {
  test("reads loop roots as <nodeId>.<port>", () => {
    expect(truthOf(leaf("verify.verdict.complete", "eq", true))).toBe("true");
  });

  test("reads an inlined node's loop root by its plan id (items 401, 402)", () => {
    const env = { values: { "repair/validate.results": { failures: [] } } };
    expect(truthOf(leaf("repair/validate.results.failures", "empty"), env)).toBe("true");
    expect(truthOf(leaf("outer/inner/node.port", "exists"), env)).toBe("false");
    // Only the root may be a plan id; fields stay plain names.
    expect(evaluateGraphPredicate(leaf("a.b/c", "exists"), env).error?.code).toBe("malformed");
  });

  test("reads roots from a Map", () => {
    const env = { values: new Map<string, unknown>([["report", report]]) };
    expect(truthOf(leaf("report.issues", "nonEmpty"), env)).toBe("true");
    expect(truthOf(leaf("params.autoFix", "exists"), env)).toBe("false");
  });

  test("reserved roots win over values of the same name", () => {
    const env = { values: { params: { autoFix: false } }, params: { autoFix: true } };
    expect(truthOf(leaf("params.autoFix", "eq", true), env)).toBe("true");
  });

  test("a path naming a root alone reads the root", () => {
    expect(truthOf(leaf("report", "exists"))).toBe("true");
    expect(truthOf(leaf("run", "exists"))).toBe("true");
    expect(truthOf(leaf("run", "exists"), {})).toBe("false");
  });

  test("paths never enter lists", () => {
    expect(truthOf(leaf("report.issues.severity", "exists"))).toBe("false");
    expect(truthOf(leaf("report.issues.length", "gt", 0))).toBe("unknown");
    expect(truthOf(leaf("report.summaryOfChange.length", "gt", 0))).toBe("unknown");
  });

  test("element predicates read fields of one element", () => {
    expect(
      evaluateGraphElementPredicate(leaf("severity", "in", ["P0", "P1"]), { severity: "P0" }).value,
    ).toBe(true);
    expect(
      evaluateGraphElementPredicate(leaf("severity", "in", ["P0", "P1"]), { severity: "P2" }).truth,
    ).toBe("false");
    expect(evaluateGraphElementPredicate(leaf("severity", "exists"), "P0").truth).toBe("false");
    expect(
      evaluateGraphElementPredicate(leaf("params.x", "exists"), { params: { x: 1 } }).value,
    ).toBe(true);
  });
});

describe("predicate evaluator: hostile input", () => {
  test("reads own data properties only", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "plain": 1}') as unknown;
    const env = { values: { doc: parsed, literal: { plain: 1 } } };
    expect(truthOf(leaf("doc.__proto__.polluted", "eq", true), env)).toBe("true");
    expect(truthOf(leaf("literal.__proto__", "exists"), env)).toBe("false");
    expect(truthOf(leaf("literal.constructor", "exists"), env)).toBe("false");
    expect(truthOf(leaf("literal.constructor.name", "eq", "Object"), env)).toBe("unknown");
    expect(truthOf(leaf("literal.toString", "exists"), env)).toBe("false");
    expect(truthOf(leaf("literal.hasOwnProperty", "exists"), env)).toBe("false");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("never runs getters", () => {
    let reads = 0;
    const value = {
      get secret() {
        reads++;
        return true;
      },
    };
    expect(truthOf(leaf("doc.secret", "eq", true), { values: { doc: value } })).toBe("unknown");
    const predicate = { path: "a", op: "exists" } as Record<string, unknown>;
    Object.defineProperty(predicate, "path", {
      enumerable: true,
      get() {
        reads++;
        return "a";
      },
    });
    expect(evaluateGraphPredicate(predicate, environment).error?.code).toBe("malformed");
    expect(reads).toBe(0);
  });

  test("does not walk class instances, functions, symbols or bigints", () => {
    class Box {
      inner = { flag: true };
    }
    const env = {
      values: {
        box: new Box(),
        date: new Date(0),
        fn: Object.assign(() => 1, { flag: true }),
        big: { n: BigInt(1), s: Symbol("s") },
      },
    };
    expect(truthOf(leaf("box.inner.flag", "eq", true), env)).toBe("unknown");
    expect(truthOf(leaf("date", "exists"), env)).toBe("false");
    expect(truthOf(leaf("fn.flag", "eq", true), env)).toBe("unknown");
    expect(truthOf(leaf("big.n", "eq", 1), env)).toBe("unknown");
    expect(truthOf(leaf("big.s", "exists"), env)).toBe("false");
  });

  test("treats NaN and infinities as unknown", () => {
    const env = { values: { doc: { nan: Number.NaN, inf: Number.POSITIVE_INFINITY } } };
    expect(truthOf(leaf("doc.nan", "eq", 0), env)).toBe("unknown");
    expect(truthOf(leaf("doc.nan", "neq", 0), env)).toBe("unknown");
    expect(truthOf(leaf("doc.nan", "lt", 0), env)).toBe("unknown");
    expect(truthOf(leaf("doc.inf", "gt", 0), env)).toBe("unknown");
    expect(truthOf(leaf("doc.nan", "exists"), env)).toBe("false");
    expect(evaluateGraphPredicate(leaf("doc.nan", "eq", Number.NaN), env).error?.code).toBe(
      "malformed",
    );
    expect(
      evaluateGraphPredicate(leaf("doc.nan", "gt", Number.NEGATIVE_INFINITY), env).error?.code,
    ).toBe("malformed");
  });

  test("survives cyclic values and huge arrays", () => {
    const cyclic: Record<string, unknown> = { flag: true };
    cyclic.self = cyclic;
    const huge = holes(10_000_000);
    const env = { values: { doc: { cyclic, huge } } };
    expect(truthOf(leaf("doc.cyclic.self.self.self.self.self.flag", "eq", true), env)).toBe("true");
    expect(truthOf({ path: "doc.huge", op: "count", compare: "gt", value: 10_000 }, env)).toBe(
      "true",
    );
    expect(truthOf(leaf("doc.huge", "nonEmpty"), env)).toBe("true");
  });

  test("contains throwing proxies", () => {
    const trap = () => {
      throw new Error("boom");
    };
    const hostile = new Proxy(
      {},
      { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap },
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const value of [hostile, revocable.proxy]) {
      const env = { values: { doc: value } };
      expect(() => evaluateGraphPredicate(leaf("doc.x", "exists"), env)).not.toThrow();
      expect(evaluateGraphPredicate(leaf("doc.x", "exists"), env)).toMatchObject({
        value: false,
        error: { code: "internal" },
      });
      expect(evaluateGraphPredicate(value, environment)).toMatchObject({ value: false });
      expect(
        evaluateGraphPredicate(leaf("x", "exists"), value as GraphPredicateEnvironment).value,
      ).toBe(false);
      expect(filterGraphPredicateList([value], leaf("x", "exists"))).toMatchObject({
        ok: false,
        code: "internal",
      });
    }
  });

  test("bounds depth and node count, including cyclic predicates", () => {
    let deep: unknown = leaf("report.issues", "nonEmpty");
    for (let index = 0; index < B.maxPredicateDepth - 1; index++) deep = { not: deep };
    expect(evaluateGraphPredicate(deep, environment).error).toBeUndefined();
    expect(evaluateGraphPredicate({ not: deep }, environment)).toMatchObject({
      value: false,
      error: { code: "too_deep" },
    });
    const leaves = Array.from({ length: B.maxPredicateNodes }, () =>
      leaf("report.issues", "nonEmpty"),
    );
    expect(evaluateGraphPredicate({ any: leaves.slice(1) }, environment).value).toBe(true);
    expect(evaluateGraphPredicate({ any: leaves }, environment)).toMatchObject({
      value: false,
      error: { code: "too_many_nodes" },
    });
    const cycle: Record<string, unknown> = {};
    cycle.not = cycle;
    expect(evaluateGraphPredicate(cycle, environment).error?.code).toBe("too_deep");
    const wide: Record<string, unknown[]> = { all: [] };
    wide.all!.push(wide, wide);
    expect(evaluateGraphPredicate(wide, environment).error?.code).toMatch(
      /too_deep|too_many_nodes/,
    );
    const hugeList = { any: Array.from({ length: 1_000_000 }, () => leaf("a", "exists")) };
    expect(evaluateGraphPredicate(hugeList, environment).error?.code).toBe("malformed");
  });

  test.each([
    ["not an object", "report.issues"],
    ["an array", [leaf("a", "exists")]],
    ["an unknown operator", leaf("a", "matches", ".*")],
    ["a bad path", leaf("a b", "exists")],
    [
      "a path over the segment bound",
      leaf(Array.from({ length: 17 }, () => "a").join("."), "exists"),
    ],
    ["an extra field", { path: "a", op: "exists", value: 1 }],
    ["a mixed combinator", { all: [leaf("a", "exists")], op: "exists" }],
    ["an empty any", { any: [] }],
    ["an ordering against a string", leaf("a", "lt", "b")],
    ["an object literal", leaf("a", "eq", { b: 1 })],
    ["a long string", leaf("a", "eq", "x".repeat(B.maxPredicateStringBytes + 1))],
    ["a sparse in-list", { path: "a", op: "in", value: holes(3) }],
    [
      "an in-list over the bound",
      leaf(
        "a",
        "in",
        Array.from({ length: B.maxPredicateListValues + 1 }, (_, i) => i),
      ),
    ],
    ["a fractional count", { path: "a", op: "count", compare: "gt", value: 1.5 }],
    ["an unknown comparison", { path: "a", op: "count", compare: "between", value: 1 }],
  ])("refuses %s as malformed", (_name, predicate) => {
    expect(evaluateGraphPredicate(predicate, environment)).toMatchObject({
      value: false,
      truth: "unknown",
      error: { code: "malformed" },
    });
  });
});

/**
 * One minimal input per evaluation error code. `CODE_CASES` is typed by the
 * code union, so a new code without a case fails the typecheck; the last test
 * fails at run time when a case stops producing its code.
 */
describe("predicate evaluator: one case per error code", () => {
  const CODE_CASES: Record<GraphPredicateEvalErrorCode, () => string | undefined> = {
    malformed: () => evaluateGraphPredicate({ path: "a", op: "near" }, environment).error?.code,
    too_deep: () => {
      let deep: unknown = leaf("report.issues", "nonEmpty");
      for (let index = 0; index < B.maxPredicateDepth; index++) deep = { not: deep };
      return evaluateGraphPredicate(deep, environment).error?.code;
    },
    too_many_nodes: () => {
      const leaves = Array.from({ length: B.maxPredicateNodes }, () => leaf("a", "exists"));
      return evaluateGraphPredicate({ any: leaves }, environment).error?.code;
    },
    // A value that throws when read: the evaluator contains it.
    internal: () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return evaluateGraphPredicate(leaf("doc.x", "exists"), { values: { doc: revocable.proxy } })
        .error?.code;
    },
  };

  for (const [code, run] of Object.entries(CODE_CASES)) {
    test(code, () => {
      expect(run()).toBe(code);
    });
  }

  test("every code in the list has a case, and every case produces its code", () => {
    expect(Object.keys(CODE_CASES).sort()).toEqual([...GRAPH_PREDICATE_EVAL_ERROR_CODES].sort());
    const missing = GRAPH_PREDICATE_EVAL_ERROR_CODES.filter((code) => CODE_CASES[code]() !== code);
    expect(missing).toEqual([]);
  });
});

describe("filter over a list", () => {
  const findings = [
    { severity: "P0", title: "a" },
    { severity: "P2", title: "b" },
    { title: "no severity" },
    "not an object",
    { severity: "P1", title: "c" },
  ];

  test("keeps the elements the predicate holds for, by reference", () => {
    const result = filterGraphPredicateList(findings, leaf("severity", "in", ["P0", "P1"]));
    expect(result).toEqual({ ok: true, items: [findings[0], findings[4]], dropped: 1, unknown: 2 });
    if (result.ok) expect(result.items[0]).toBe(findings[0]);
  });

  test("treats holes as unknown", () => {
    const sparse: unknown[] = [{ severity: "P0" }];
    sparse[2] = { severity: "P0" };
    expect(filterGraphPredicateList(sparse, leaf("severity", "eq", "P0"))).toMatchObject({
      ok: true,
      dropped: 0,
      unknown: 1,
    });
  });

  test("refuses non-lists, oversized lists and malformed predicates", () => {
    expect(filterGraphPredicateList({ a: 1 }, leaf("a", "exists"))).toMatchObject({
      ok: false,
      code: "not_a_list",
    });
    expect(
      filterGraphPredicateList(holes(B.maxArtifactItems + 1), leaf("a", "exists")),
    ).toMatchObject({
      ok: false,
      code: "too_many_items",
    });
    expect(filterGraphPredicateList([1, 2, 3], leaf("a", "exists"), { maxItems: 2 })).toMatchObject(
      {
        ok: false,
        code: "too_many_items",
      },
    );
    expect(filterGraphPredicateList([], leaf("a", "nope"))).toMatchObject({
      ok: false,
      code: "malformed",
      at: "op",
    });
  });
});

// ------------------------------------------------------------- totality

/** mulberry32: a small seeded generator, so failures reproduce. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  return { next, int, pick };
}

type Random = ReturnType<typeof generator>;

const SEGMENTS = [
  "report",
  "issues",
  "verdict",
  "ready",
  "a",
  "b",
  "params",
  "run",
  "iteration",
  "__proto__",
  "constructor",
  "prototype",
  "length",
  "0",
  "toString",
];
const OPS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "exists",
  "empty",
  "nonEmpty",
  "count",
  "matches",
  "",
  "__proto__",
];

function randomScalar(random: Random): unknown {
  return random.pick<() => unknown>([
    () => null,
    () => random.next() < 0.5,
    () => random.int(20) - 5,
    () => random.next() * 10,
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => -0,
    () => random.pick(["", "P0", "yes", "with-fixes", "__proto__", "x".repeat(random.int(2000))]),
    () => undefined,
    () => BigInt(random.int(5)),
    () => Symbol("s"),
    () => () => 1,
  ])();
}

function randomPath(random: Random): unknown {
  if (random.next() < 0.05) return randomScalar(random);
  const length = 1 + random.int(random.next() < 0.05 ? 20 : 4);
  return Array.from({ length }, () => random.pick(SEGMENTS)).join(random.next() < 0.02 ? " " : ".");
}

const VALID_SEGMENTS = SEGMENTS.filter((segment) => segment !== "0");
const VALID_SCALARS = [
  null,
  true,
  false,
  0,
  1,
  2,
  -3,
  0.5,
  "",
  "P0",
  "yes",
  "with-fixes",
  "__proto__",
];

/** A predicate the guard accepts: valid ops with operands of the right shape. */
function wellFormedLeaf(random: Random): Record<string, unknown> {
  const path = Array.from({ length: 1 + random.int(4) }, () => random.pick(VALID_SEGMENTS)).join(
    ".",
  );
  const op = random.pick(OPS.slice(0, 11));
  switch (op) {
    case "exists":
    case "empty":
    case "nonEmpty":
      return { path, op };
    case "count":
      return {
        path,
        op,
        compare: random.pick(["eq", "neq", "lt", "lte", "gt", "gte"]),
        value: random.int(4),
      };
    case "in":
      return {
        path,
        op,
        value: Array.from({ length: 1 + random.int(4) }, () => random.pick(VALID_SCALARS)),
      };
    case "eq":
    case "neq":
      return { path, op, value: random.pick(VALID_SCALARS) };
    default:
      return { path, op, value: random.int(6) - 2 };
  }
}

function randomPredicate(random: Random, depth: number, wellFormed = false): unknown {
  const roll = random.next();
  if (depth > (wellFormed ? 4 : 12) || roll < 0.55) {
    if (wellFormed) return wellFormedLeaf(random);
    const predicate: Record<string, unknown> = { path: randomPath(random), op: random.pick(OPS) };
    const valueRoll = random.next();
    if (valueRoll < 0.6) predicate.value = randomScalar(random);
    else if (valueRoll < 0.85)
      predicate.value = Array.from({ length: random.int(70) }, () => randomScalar(random));
    if (predicate.op === "count" || random.next() < 0.05) {
      predicate.compare = random.pick(["eq", "neq", "lt", "lte", "gt", "gte", "between"]);
    }
    if (random.next() < 0.03) predicate.extra = 1;
    return predicate;
  }
  if (roll < 0.7) return { not: randomPredicate(random, depth + 1, wellFormed) };
  if (roll < 0.95 || wellFormed) {
    const kind = random.next() < 0.5 ? "all" : "any";
    const count = (wellFormed ? 1 : 0) + random.int(wellFormed ? 3 : 6);
    return {
      [kind]: Array.from({ length: count }, () => randomPredicate(random, depth + 1, wellFormed)),
    };
  }
  return randomValue(random, 2);
}

function randomValue(random: Random, depth: number): unknown {
  const roll = random.next();
  if (depth <= 0 || roll < 0.4) return randomScalar(random);
  if (roll < 0.6)
    return Array.from({ length: random.int(5) }, () => randomValue(random, depth - 1));
  if (roll < 0.65) return holes(random.int(5_000_000));
  if (roll < 0.7) {
    const cyclic: Record<string, unknown> = {};
    Object.defineProperty(cyclic, random.pick(SEGMENTS), { value: cyclic, enumerable: true });
    return cyclic;
  }
  if (roll < 0.72) {
    return new Proxy(
      {},
      {
        get: () => {
          throw new Error("trap");
        },
        getOwnPropertyDescriptor: () => {
          throw new Error("trap");
        },
      },
    );
  }
  if (roll < 0.74) {
    return Object.defineProperty({}, random.pick(SEGMENTS), {
      enumerable: true,
      get: () => {
        throw new Error("getter");
      },
    });
  }
  const object: Record<string, unknown> = random.next() < 0.1 ? Object.create(null) : {};
  for (let index = random.int(5); index > 0; index--) {
    const key = random.pick(SEGMENTS);
    Object.defineProperty(object, key, {
      value: randomValue(random, depth - 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return object;
}

describe("evaluator totality over generated inputs", () => {
  const TRUTHS = new Set(["true", "false", "unknown"]);

  test("never throws and always decides, for thousands of cases", () => {
    const random = generator(0x104);
    let decided = 0;
    for (let index = 0; index < 6_000; index++) {
      const predicate = randomPredicate(random, 0, index % 2 === 0);
      const env = {
        values: randomValue(random, 4) as Record<string, unknown>,
        params: randomValue(random, 2) as Record<string, unknown>,
        run: randomValue(random, 1) as { iteration: number },
      };
      let result: ReturnType<typeof evaluateGraphPredicate> | undefined;
      expect(() => {
        result = evaluateGraphPredicate(predicate, env);
      }).not.toThrow();
      expect(typeof result!.value).toBe("boolean");
      expect(TRUTHS.has(result!.truth)).toBe(true);
      expect(result!.value).toBe(result!.truth === "true");
      if (result!.error) expect(result!.value).toBe(false);
      else decided++;

      const element = evaluateGraphElementPredicate(predicate, randomValue(random, 3));
      expect(typeof element.value).toBe("boolean");

      const list = randomValue(random, 3);
      let filtered: ReturnType<typeof filterGraphPredicateList> | undefined;
      expect(() => {
        filtered = filterGraphPredicateList(list, predicate);
      }).not.toThrow();
      expect(typeof filtered!.ok).toBe("boolean");
    }
    // The generator reaches real evaluations, not only refusals.
    expect(decided).toBeGreaterThan(2_500);
  });

  test("whatever the guard accepts evaluates without a structural error", () => {
    const random = generator(0x1040);
    let accepted = 0;
    for (let index = 0; index < 6_000; index++) {
      const predicate = randomPredicate(random, 0, index % 2 === 0);
      let guardOk = false;
      try {
        guardOk = validateGraphPredicate(predicate).ok;
      } catch {
        // The guard is not total over hostile objects; the evaluator is.
        continue;
      }
      if (!guardOk) continue;
      accepted++;
      const result = evaluateGraphPredicate(predicate, environment);
      expect(result.error).toBeUndefined();
    }
    expect(accepted).toBeGreaterThan(2_500);
  });

  test("the type checker never throws on guarded predicates", () => {
    const random = generator(0x10400);
    const scope = graphNodePredicateScope(
      [
        { name: "report", type: "review-report@1" },
        { name: "a", type: "list<finding@1>" },
      ],
      [{ key: "b", type: "boolean" }],
      new GraphTypeLibrary(),
    );
    for (let index = 0; index < 3_000; index++) {
      const predicate = randomPredicate(random, 0, true);
      let guardOk = false;
      try {
        guardOk = validateGraphPredicate(predicate).ok;
      } catch {
        continue;
      }
      if (!guardOk) continue;
      expect(() => typeCheckGraphPredicate(predicate, scope)).not.toThrow();
    }
  });
});
