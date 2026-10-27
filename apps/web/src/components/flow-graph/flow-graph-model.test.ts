import { describe, expect, test } from "bun:test";
import {
  FLOW_NODE_CHIPS_ROW_HEIGHT,
  FLOW_NODE_EXTRA_ROW_HEIGHT,
  FLOW_NODE_HEIGHT,
  FLOW_NODE_RUNTIME_ROW_HEIGHT,
  flowNodeHasRuntimeRow,
  flowNodeHeight,
} from "./flow-graph-model";

const runtime = { elapsed: "1m 0s", tokens: "12k", tokensPending: false, live: false };

describe("node face rows", () => {
  test("a running node always has the runtime row, even before its clock starts", () => {
    expect(flowNodeHasRuntimeRow({ state: "running", runtime: null })).toBe(true);
    expect(flowNodeHasRuntimeRow({ state: "running", runtime })).toBe(true);
  });

  test("a node that ran keeps the row; one that has not run has two rows", () => {
    expect(flowNodeHasRuntimeRow({ state: "complete", runtime })).toBe(true);
    expect(flowNodeHasRuntimeRow({ state: "failed", runtime })).toBe(true);
    expect(flowNodeHasRuntimeRow({ state: "complete", runtime: null })).toBe(false);
    expect(flowNodeHasRuntimeRow({ state: "not-started", runtime: null })).toBe(false);
  });

  test("a node's height adds each row it shows to the two-row face", () => {
    expect(flowNodeHeight({ state: "not-started", runtime: null })).toBe(FLOW_NODE_HEIGHT);
    expect(flowNodeHeight({ state: "running", runtime })).toBe(
      FLOW_NODE_HEIGHT + FLOW_NODE_RUNTIME_ROW_HEIGHT,
    );
    expect(flowNodeHeight({ state: "running", runtime, validation: [{}] })).toBe(
      FLOW_NODE_HEIGHT + FLOW_NODE_RUNTIME_ROW_HEIGHT + FLOW_NODE_CHIPS_ROW_HEIGHT,
    );
    expect(flowNodeHeight({ state: "complete", runtime: null, extra: "checks" })).toBe(
      FLOW_NODE_HEIGHT + FLOW_NODE_EXTRA_ROW_HEIGHT,
    );
    // The heights the graph has always used for its chips and checks rows.
    expect(flowNodeHeight({ state: "complete", runtime: null, validation: [{}] })).toBe(92);
    expect(flowNodeHeight({ state: "complete", runtime: null, extra: "checks" })).toBe(84);
  });
});
