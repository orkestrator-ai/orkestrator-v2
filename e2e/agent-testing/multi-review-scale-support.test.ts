import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { workflowResultToolName } from "@orkestrator/protocol/workflow-results";
import { MULTI_REVIEW_STEP_TURNS } from "../../apps/backend/src/core/multi-review-steps";
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
  runTeardown,
  SCALE_FAKE_SUBMISSION_TOOLS,
  scaleFakeOutcomeProblems,
  type ScaleFakeOutcome,
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

describe("fake-model outcome", () => {
  const qualified: ScaleFakeOutcome = {
    reviewers: 3,
    phase: "ready",
    consolidated: true,
    statuses: ["completed", "completed", "completed"],
    submissions: {
      submit_validation_plan: 1,
      submit_review_report: 3,
      submit_consolidated_review: 1,
    },
  };

  test("names the tools the Multi Review steps submit with", () => {
    const tools: Record<string, string> = { ...SCALE_FAKE_SUBMISSION_TOOLS };
    expect(tools).toEqual({
      preparation: workflowResultToolName(MULTI_REVIEW_STEP_TURNS.prepare.result),
      reviewer: workflowResultToolName("review-report"),
      consolidation: workflowResultToolName(MULTI_REVIEW_STEP_TURNS.consolidate.result),
    });
  });

  test("a ready, consolidated panel where every reviewer submitted qualifies", () => {
    expect(scaleFakeOutcomeProblems(qualified)).toEqual([]);
  });

  test("a panel whose every reviewer failed after admission does not", () => {
    const problems = scaleFakeOutcomeProblems({
      ...qualified,
      phase: "failed",
      consolidated: false,
      statuses: ["failed", "failed", "failed"],
      submissions: { submit_validation_plan: 1 },
    });
    expect(problems).toEqual([
      "phase is failed, not ready",
      "no consolidated report",
      "0 of 3 reviewers completed",
      "submit_review_report submitted 0 times, expected 3",
      "submit_consolidated_review submitted 0 times, expected 1",
    ]);
  });

  test("one failed reviewer, a short panel or missing counts also fail", () => {
    expect(
      scaleFakeOutcomeProblems({
        ...qualified,
        statuses: ["completed", "failed", "completed"],
        submissions: { ...qualified.submissions, submit_review_report: 2 },
      }),
    ).toEqual(["2 of 3 reviewers completed", "submit_review_report submitted 2 times, expected 3"]);
    expect(scaleFakeOutcomeProblems({ ...qualified, statuses: ["completed"] })).toEqual([
      "1 reviewers, expected 3",
      "1 of 3 reviewers completed",
    ]);
    expect(scaleFakeOutcomeProblems({ ...qualified, submissions: undefined })).toEqual([
      "the fake model reported no submission counts",
    ]);
  });
});

describe("scale teardown", () => {
  test("runs every step after one throws, then rethrows that failure", async () => {
    const ran: string[] = [];
    const failure = new Error("cleanup failed");
    await expect(
      runTeardown([
        () => ran.push("marker"),
        () => {
          ran.push("cleanup");
          throw failure;
        },
        () => ran.push("restore models.json"),
        async () => {
          await Promise.resolve();
          ran.push("stop fake model");
        },
      ]),
    ).rejects.toBe(failure);
    expect(ran).toEqual(["marker", "cleanup", "restore models.json", "stop fake model"]);
  });

  test("reports several failures together and resolves when none fail", async () => {
    const error = await runTeardown([
      () => Promise.reject(new Error("a")),
      () => {
        throw new Error("b");
      },
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item: Error) => item.message)).toEqual(["a", "b"]);
    await expect(runTeardown([() => undefined])).resolves.toBeUndefined();
  });
});
