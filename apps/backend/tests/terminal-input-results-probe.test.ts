import { describe, expect, test } from "bun:test";

import { keysFor, phaseBetween } from "../scripts/terminal-input-results-probe.js";
import type { ProbePageCounts } from "../scripts/terminal-input-results-probe-page.ts";

function counts(overrides: Partial<ProbePageCounts> = {}): ProbePageCounts {
  return {
    protocol: "orkestrator-terminal.v1.input-results",
    keys: 0,
    inputFrames: 0,
    cumulativeResultFrames: 0,
    perInputResultFrames: 0,
    resultBytes: 0,
    settled: 0,
    failed: 0,
    refused: 0,
    socketCloses: 0,
    fallbackRequired: 0,
    latencies: [],
    ...overrides,
  };
}

// These figures are the evidence for to-do 5080 task 3 (retired;
// docs/architecture/remote-gateway.md), so the arithmetic that turns the
// page's running counters into one phase is pinned here.
describe("phaseBetween", () => {
  test("counts only what happened after the first snapshot", () => {
    const before = counts({
      keys: 52,
      inputFrames: 52,
      cumulativeResultFrames: 52,
      resultBytes: 3215,
      latencies: [1, 1],
    });
    const after = counts({
      keys: 368,
      inputFrames: 368,
      cumulativeResultFrames: 360,
      resultBytes: 22_572,
      failed: 1,
      refused: 2,
      latencies: [1, 1, 80, 81, 82, 135],
    });
    expect(phaseBetween(before, after)).toEqual({
      keys: 316,
      inputFrames: 316,
      resultFrames: 308,
      cumulativeResultFrames: 308,
      perInputResultFrames: 0,
      resultBytes: 19_357,
      failed: 1,
      refused: 2,
      medianMs: 82,
      p95Ms: 135,
    });
  });

  test("a v1 socket's results are per input, and both kinds add up", () => {
    const phase = phaseBetween(
      counts(),
      counts({ perInputResultFrames: 3, cumulativeResultFrames: 1 }),
    );
    expect(phase.resultFrames).toBe(4);
    expect(phase.perInputResultFrames).toBe(3);
  });

  test("a phase with no settled keys reports zero latency", () => {
    expect(phaseBetween(counts(), counts({ keys: 2, refused: 2 }))).toMatchObject({
      medianMs: 0,
      p95Ms: 0,
    });
  });
});

describe("keysFor", () => {
  test("is deterministic, of the asked length, and continues from an offset", () => {
    expect(keysFor(3)).toBe("abc");
    expect(keysFor(40)).toHaveLength(40);
    expect(keysFor(2, 36)).toBe("ab");
    expect(keysFor(52) + keysFor(316, 52)).toBe(keysFor(368));
  });
});
