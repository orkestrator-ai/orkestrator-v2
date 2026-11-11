import { describe, expect, test } from "bun:test";
import {
  FANOUT_STATS_FILE,
  FANOUT_STATS_FIXTURE_DIR,
  FANOUT_STATS_MARKER,
} from "../../apps/backend/src/core/agent-test-fanout-stats";
import {
  FANOUT_STATS_DIR,
  FANOUT_STATS_FILE_NAME,
  FANOUT_STATS_MARKER_NAME,
  parseScalePlatforms,
  pickScaleModel,
  processTreeRssKiB,
  profileRssMiB,
  scaleModelVariable,
  scalePanelPlatforms,
} from "./multi-review-scale-support";

describe("scale panel platforms", () => {
  test("defaults to Claude and Codex and accepts any agent platform once", () => {
    expect(parseScalePlatforms(undefined)).toEqual(["claude", "codex"]);
    expect(parseScalePlatforms("  ")).toEqual(["claude", "codex"]);
    expect(parseScalePlatforms("claude, codex,cursor,grok,opencode,pi")).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
  });

  test("refuses an unknown or repeated platform rather than shrinking the panel", () => {
    expect(() => parseScalePlatforms("claude,gemini")).toThrow(/Unknown scale platform/);
    expect(() => parseScalePlatforms("claude,claude")).toThrow(/once/);
  });

  test("spreads reviewers round-robin in the configured order", () => {
    expect(scalePanelPlatforms(["claude", "codex", "pi"], 7)).toEqual([
      "claude",
      "codex",
      "pi",
      "claude",
      "codex",
      "pi",
      "claude",
    ]);
    const panel = scalePanelPlatforms(["claude", "codex", "cursor", "grok"], 32);
    for (const platform of ["claude", "codex", "cursor", "grok"]) {
      expect(panel.filter((entry) => entry === platform)).toHaveLength(8);
    }
    expect(() => scalePanelPlatforms([], 2)).toThrow();
  });

  test("names one model variable per platform, the existing Claude and Codex ones included", () => {
    expect(scaleModelVariable("claude")).toBe("ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CLAUDE_MODEL");
    expect(scaleModelVariable("codex")).toBe("ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CODEX_MODEL");
    expect(scaleModelVariable("opencode")).toBe(
      "ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_OPENCODE_MODEL",
    );
  });

  test("picks a model by label prefix, or the platform's first model without one", () => {
    const catalog = [
      { id: "c1", platform: "claude", label: "Opus 5.5" },
      { id: "c2", platform: "claude", label: "Haiku 4.5" },
      { id: "p1", platform: "pi", label: "openai/gpt" },
    ];
    expect(pickScaleModel(catalog, "claude", "Haiku")?.id).toBe("c2");
    expect(pickScaleModel(catalog, "claude", undefined)?.id).toBe("c1");
    expect(pickScaleModel(catalog, "pi", undefined)?.id).toBe("p1");
    expect(pickScaleModel(catalog, "grok", undefined)).toBeUndefined();
    expect(pickScaleModel(catalog, "claude", "Sonnet")).toBeUndefined();
  });
});

describe("process-tree RSS", () => {
  const table = [
    "  1     0   100",
    " 10     1  2048",
    " 11    10  1024",
    " 12    11   512",
    " 13    10   256",
    " 20     1  9999",
    "garbage line",
    " 30    12    64",
  ].join("\n");

  test("sums the root and every descendant, and nothing else", () => {
    expect(processTreeRssKiB(10, table)).toBe(2048 + 1024 + 512 + 256 + 64);
    expect(processTreeRssKiB(11, table)).toBe(1024 + 512 + 64);
    expect(processTreeRssKiB(999, table)).toBe(0);
  });

  test("reads this process's own tree from the real process table", () => {
    const sample = profileRssMiB(process.pid);
    expect(sample.backend).toBeGreaterThan(0);
    expect(sample.tree).toBeGreaterThanOrEqual(sample.backend);
  });
});

test("the spec's fixture paths match the backend recorder's", () => {
  expect(FANOUT_STATS_DIR).toBe(FANOUT_STATS_FIXTURE_DIR.split("\\").join("/"));
  expect(FANOUT_STATS_MARKER_NAME).toBe(FANOUT_STATS_MARKER);
  expect(FANOUT_STATS_FILE_NAME).toBe(FANOUT_STATS_FILE);
});
