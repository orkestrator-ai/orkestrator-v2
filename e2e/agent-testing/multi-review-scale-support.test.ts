import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  SCALE_FAKE_MODEL_LABEL,
  SCALE_FAKE_PI_MODEL,
  SCALE_FAKE_PI_PROVIDER,
  SCALE_FAKE_PLATFORMS,
  scaleFakePiModelsConfig,
  writeScaleFakePiModels,
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

  test("an unset list takes the caller's fallback, as the fake-model mode's Pi", () => {
    expect(parseScalePlatforms(undefined, SCALE_FAKE_PLATFORMS)).toEqual(["pi"]);
    expect(parseScalePlatforms("codex", SCALE_FAKE_PLATFORMS)).toEqual(["codex"]);
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

describe("fake-model mode", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const profileRoot = () => {
    const root = mkdtempSync(path.join(tmpdir(), "mr-scale-fake-"));
    roots.push(root);
    return root;
  };
  const modelsFile = (root: string) =>
    path.join(root, "agent-credentials", "home", ".pi", "agent", "models.json");

  test("names the loopback model with a placeholder key and a large window", () => {
    const config = scaleFakePiModelsConfig("http://127.0.0.1:1/v1");
    const provider = config.providers[SCALE_FAKE_PI_PROVIDER]!;
    expect(provider.baseUrl).toBe("http://127.0.0.1:1/v1");
    expect(provider.apiKey).toBe("scale-fake-not-a-key");
    expect(provider.models).toEqual([
      expect.objectContaining({
        id: SCALE_FAKE_PI_MODEL,
        name: SCALE_FAKE_MODEL_LABEL,
        contextWindow: 1_000_000,
      }),
    ]);
  });

  test("the model id is the one the fake model answers as", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "auto-pipeline-fake-model.ts"),
      "utf8",
    );
    expect(source).toContain(`export const FAKE_MODEL_ID = "${SCALE_FAKE_PI_MODEL}";`);
  });

  test("writes only the profile's own models.json and restores an absent file", () => {
    const root = profileRoot();
    const restore = writeScaleFakePiModels(root, "http://127.0.0.1:2/v1");
    const written = JSON.parse(readFileSync(modelsFile(root), "utf8")) as {
      providers: Record<string, { baseUrl: string }>;
    };
    expect(Object.keys(written.providers)).toEqual([SCALE_FAKE_PI_PROVIDER]);
    expect(written.providers[SCALE_FAKE_PI_PROVIDER]!.baseUrl).toBe("http://127.0.0.1:2/v1");
    restore();
    expect(existsSync(modelsFile(root))).toBe(false);
  });

  test("restores an earlier fake entry and refuses a file naming another provider", () => {
    const root = profileRoot();
    mkdirSync(path.dirname(modelsFile(root)), { recursive: true });
    const earlier = `${JSON.stringify(scaleFakePiModelsConfig("http://127.0.0.1:3/v1"))}\n`;
    writeFileSync(modelsFile(root), earlier);
    writeScaleFakePiModels(root, "http://127.0.0.1:4/v1")();
    expect(readFileSync(modelsFile(root), "utf8")).toBe(earlier);
    const foreign = JSON.stringify({ providers: { someone: {} } });
    writeFileSync(modelsFile(root), foreign);
    expect(() => writeScaleFakePiModels(root, "http://127.0.0.1:5/v1")).toThrow(/other providers/);
    expect(readFileSync(modelsFile(root), "utf8")).toBe(foreign);
  });
});
