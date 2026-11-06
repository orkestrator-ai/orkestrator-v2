import { describe, expect, test } from "bun:test";
import {
  combineNativeAgentCostSources,
  isNativeAgentCostSource,
  NATIVE_AGENT_COST_SOURCES,
} from "./native-agent.js";

describe("isNativeAgentCostSource", () => {
  test("accepts exactly the two sources", () => {
    for (const source of NATIVE_AGENT_COST_SOURCES)
      expect(isNativeAgentCostSource(source)).toBe(true);
    for (const value of ["Provider", "billed", "", null, undefined, 1, {}]) {
      expect(isNativeAgentCostSource(value)).toBe(false);
    }
  });
});

describe("combineNativeAgentCostSources", () => {
  test("a total containing any estimate is an estimate", () => {
    expect(
      combineNativeAgentCostSources([
        { costUsd: 0.1, costSource: "provider" },
        { costUsd: 0.02, costSource: "estimate" },
        { costUsd: 0.3 },
      ]),
    ).toBe("estimate");
  });

  test("a total is provider-billed only when every priced part is", () => {
    expect(
      combineNativeAgentCostSources([
        { costUsd: 0.1, costSource: "provider" },
        { costUsd: 0, costSource: "provider" },
      ]),
    ).toBe("provider");
    expect(
      combineNativeAgentCostSources([{ costUsd: 0.1, costSource: "provider" }, { costUsd: 0.2 }]),
    ).toBeUndefined();
  });

  test("parts without an amount do not count", () => {
    expect(
      combineNativeAgentCostSources([
        { costUsd: 0.1, costSource: "provider" },
        { costSource: "estimate" },
        {},
      ]),
    ).toBe("provider");
    expect(combineNativeAgentCostSources([{ costSource: "estimate" }, {}])).toBeUndefined();
    expect(combineNativeAgentCostSources([])).toBeUndefined();
  });

  test("a non-finite amount is not a priced part", () => {
    expect(
      combineNativeAgentCostSources([
        { costUsd: Number.NaN, costSource: "estimate" },
        { costUsd: 1, costSource: "provider" },
      ]),
    ).toBe("provider");
  });
});
