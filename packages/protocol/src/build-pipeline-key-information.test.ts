import { describe, expect, test } from "bun:test";
import {
  KEY_INFORMATION_LIMITS,
  applyKeyInformationPatch,
  emptyKeyInformation,
  hasKeyInformation,
  isBuildPipelineKeyInformation,
  recordKeyInformationReviewIssues,
  recordKeyInformationVerdict,
  type BuildPipelineKeyInformation,
} from "./build-pipeline-key-information.js";
import { isBuildPipeline, type BuildPipeline } from "./build-pipeline.js";

const AT = "2026-11-01T10:00:00.000Z";
const LATER = "2026-11-01T11:00:00.000Z";

function built(): BuildPipelineKeyInformation {
  return applyKeyInformationPatch(
    undefined,
    {
      statement: "The header hides the pipeline's state.",
      context: "Build tab",
      solution: "A key information panel.",
      workDone: ["Added the panel"],
      decisions: [
        {
          decision: "Storage",
          options: [{ option: "Record", pros: ["Synced"], cons: ["Size"] }],
          chosen: "Record",
        },
      ],
      notDone: ["Rich text"],
      tests: [{ name: "bun test", result: "passed" }],
    },
    { at: AT, author: "build", round: 0 },
  );
}

describe("applyKeyInformationPatch", () => {
  test("starts from an empty brief framed as a problem", () => {
    const info = built();
    expect(info.framing).toBe("problem");
    expect(info.statement).toBe("The header hides the pipeline's state.");
    expect(info.updates).toEqual([
      {
        at: AT,
        author: "build",
        round: 0,
        sections: ["statement", "context", "solution", "workDone", "decisions", "notDone", "tests"],
      },
    ]);
    expect(isBuildPipelineKeyInformation(info)).toBe(true);
  });

  test("replaces only the sections a patch names and does not modify its input", () => {
    const before = built();
    const snapshot = structuredClone(before);
    const after = applyKeyInformationPatch(
      before,
      { framing: "objective", workDone: ["Rewrote the panel"] },
      { at: LATER, author: "fix", round: 1 },
    );
    expect(before).toEqual(snapshot);
    expect(after.framing).toBe("objective");
    expect(after.workDone).toEqual(["Rewrote the panel"]);
    expect(after.solution).toBe(before.solution);
    expect(after.updatedAt).toBe(LATER);
    expect(after.updates.at(-1)).toEqual({
      at: LATER,
      author: "fix",
      round: 1,
      sections: ["framing", "workDone"],
    });
  });

  test("an empty prose field clears its section", () => {
    const after = applyKeyInformationPatch(
      built(),
      { context: "   " },
      {
        at: LATER,
        author: "build",
        round: 0,
      },
    );
    expect(after.context).toBeUndefined();
  });

  test("issues and verification replace the current round only", () => {
    let info = applyKeyInformationPatch(
      built(),
      { issues: [{ issue: "A", resolution: "Fixed A", status: "resolved" }] },
      { at: AT, author: "address", round: 0 },
    );
    info = applyKeyInformationPatch(
      info,
      { verification: { passed: false, summary: "Round one failed", checks: [] } },
      { at: AT, author: "verify", round: 0 },
    );
    info = applyKeyInformationPatch(
      info,
      { issues: [{ issue: "B", resolution: "", status: "open" }] },
      { at: LATER, author: "address", round: 1 },
    );
    info = applyKeyInformationPatch(
      info,
      { issues: [{ issue: "B", resolution: "Fixed B", status: "resolved" }] },
      { at: LATER, author: "address", round: 1 },
    );
    expect(info.issues.map((entry) => [entry.round, entry.issue, entry.status])).toEqual([
      [0, "A", "resolved"],
      [1, "B", "resolved"],
    ]);
    info = applyKeyInformationPatch(
      info,
      { verification: { summary: "Round two", checks: [{ check: "X", passed: true }] } },
      { at: LATER, author: "verify", round: 1 },
    );
    expect(info.verifications.map((entry) => [entry.round, entry.passed])).toEqual([
      [0, false],
      [1, undefined],
    ]);
  });

  test("keeps a round's recorded verdict when Verify writes without one", () => {
    const withVerdict = recordKeyInformationVerdict(
      undefined,
      { passed: true, rationale: "All good", criteria: [] },
      { at: AT, round: 0 },
    );
    const after = applyKeyInformationPatch(
      withVerdict,
      { verification: { summary: "Detailed", checks: [{ check: "A", passed: true }] } },
      { at: LATER, author: "verify", round: 0 },
    );
    expect(after.verifications).toEqual([
      { round: 0, passed: true, summary: "Detailed", checks: [{ check: "A", passed: true }] },
    ]);
  });

  test("bounds every field so the result always passes the snapshot guard", () => {
    const long = "x".repeat(50_000);
    const info = applyKeyInformationPatch(
      undefined,
      {
        statement: long,
        workDone: Array.from({ length: 100 }, () => long),
        decisions: Array.from({ length: 40 }, () => ({
          decision: long,
          options: Array.from({ length: 20 }, () => ({
            option: long,
            pros: Array.from({ length: 20 }, () => long),
            cons: [long],
          })),
          chosen: long,
          rationale: long,
        })),
        tests: Array.from({ length: 100 }, () => ({
          name: long,
          result: "failed" as const,
          details: long,
        })),
        issues: Array.from({ length: 200 }, () => ({
          issue: long,
          severity: long,
          resolution: long,
          status: "open" as const,
        })),
        verification: {
          summary: long,
          checks: Array.from({ length: 100 }, () => ({ check: long, passed: false })),
        },
      },
      { at: AT, author: "build", round: 5_000 },
    );
    expect(info.statement!.length).toBe(KEY_INFORMATION_LIMITS.proseLength);
    expect(info.statement!.endsWith("…")).toBe(true);
    expect(info.workDone).toHaveLength(KEY_INFORMATION_LIMITS.listItems);
    expect(info.decisions).toHaveLength(KEY_INFORMATION_LIMITS.decisions);
    expect(info.tests).toHaveLength(KEY_INFORMATION_LIMITS.tests);
    expect(info.issues).toHaveLength(KEY_INFORMATION_LIMITS.issues);
    expect(info.verifications[0]!.round).toBe(KEY_INFORMATION_LIMITS.maxRound);
    expect(isBuildPipelineKeyInformation(info)).toBe(true);
  });

  test("keeps at most the newest updates", () => {
    let info: BuildPipelineKeyInformation | undefined;
    for (let index = 0; index < KEY_INFORMATION_LIMITS.updates + 5; index += 1) {
      info = applyKeyInformationPatch(
        info,
        { context: `update ${index}` },
        { at: AT, author: "build", round: 0 },
      );
    }
    expect(info!.updates).toHaveLength(KEY_INFORMATION_LIMITS.updates);
    expect(info!.context).toBe(`update ${KEY_INFORMATION_LIMITS.updates + 4}`);
  });
});

describe("recordKeyInformationReviewIssues", () => {
  test("records a round's review issues as open", () => {
    const info = recordKeyInformationReviewIssues(
      built(),
      [{ title: "Unbounded list", severity: "P1" }, { title: "Typo" }],
      { at: LATER, round: 0 },
    );
    expect(info.issues).toEqual([
      { round: 0, issue: "Unbounded list", severity: "P1", resolution: "", status: "open" },
      { round: 0, issue: "Typo", resolution: "", status: "open" },
    ]);
    expect(info.updates.at(-1)).toMatchObject({ author: "system", sections: ["issues"] });
  });

  test("a repeated review replaces untouched issues but never ones Address resolved", () => {
    const first = recordKeyInformationReviewIssues(undefined, [{ title: "Old" }], {
      at: AT,
      round: 0,
    });
    const replaced = recordKeyInformationReviewIssues(first, [{ title: "New" }], {
      at: LATER,
      round: 0,
    });
    expect(replaced.issues.map((entry) => entry.issue)).toEqual(["New"]);

    const addressed = applyKeyInformationPatch(
      replaced,
      { issues: [{ issue: "New", resolution: "Done", status: "resolved" }] },
      { at: LATER, author: "address", round: 0 },
    );
    const kept = recordKeyInformationReviewIssues(addressed, [{ title: "Newer" }], {
      at: LATER,
      round: 0,
    });
    expect(kept.issues.map((entry) => entry.issue)).toEqual(["New"]);
  });
});

describe("recordKeyInformationVerdict", () => {
  test("derives checks from the checked criteria when Verify wrote none", () => {
    const info = recordKeyInformationVerdict(
      undefined,
      {
        passed: false,
        rationale: "Criterion two failed.",
        criteria: [
          { text: "Timer in the header", status: "passed", evidence: "Seen in the diff" },
          { text: "Panel lists decisions", status: "failed", evidence: "" },
          { text: "Works on Linux", status: "not-checked", evidence: "No Linux host" },
        ],
      },
      { at: AT, round: 1 },
    );
    expect(info.verifications).toEqual([
      {
        round: 1,
        passed: false,
        summary: "Criterion two failed.",
        checks: [
          { check: "Timer in the header", passed: true, details: "Seen in the diff" },
          { check: "Panel lists decisions", passed: false },
        ],
      },
    ]);
  });

  test("the verdict decides passed, Verify's own summary and checks stay", () => {
    const written = applyKeyInformationPatch(
      undefined,
      {
        verification: {
          passed: true,
          summary: "Verify's summary",
          checks: [{ check: "Own", passed: true }],
        },
      },
      { at: AT, author: "verify", round: 0 },
    );
    const info = recordKeyInformationVerdict(
      written,
      { passed: false, rationale: "Rationale", criteria: [] },
      { at: LATER, round: 0 },
    );
    expect(info.verifications).toEqual([
      {
        round: 0,
        passed: false,
        summary: "Verify's summary",
        checks: [{ check: "Own", passed: true }],
      },
    ]);
  });
});

describe("isBuildPipelineKeyInformation", () => {
  test("rejects values outside the bounds or vocabularies", () => {
    const valid = built();
    expect(isBuildPipelineKeyInformation(valid)).toBe(true);
    expect(isBuildPipelineKeyInformation({ ...valid, framing: "goal" })).toBe(false);
    expect(
      isBuildPipelineKeyInformation({
        ...valid,
        statement: "x".repeat(KEY_INFORMATION_LIMITS.proseLength + 1),
      }),
    ).toBe(false);
    expect(
      isBuildPipelineKeyInformation({
        ...valid,
        tests: [{ name: "a", result: "flaky" }],
      }),
    ).toBe(false);
    expect(
      isBuildPipelineKeyInformation({
        ...valid,
        issues: [{ round: -1, issue: "a", resolution: "", status: "open" }],
      }),
    ).toBe(false);
    expect(isBuildPipelineKeyInformation({ ...valid, updatedAt: "yesterday" })).toBe(false);
    expect(isBuildPipelineKeyInformation({ ...valid, workDone: undefined })).toBe(false);
  });

  test("a pipeline snapshot carries it, and an invalid one fails the snapshot", () => {
    const pipeline: BuildPipeline = {
      id: "pipeline-1",
      taskId: "task-1",
      projectId: "project-1",
      environmentId: "environment-1",
      environmentType: "local",
      agentType: "codex",
      phase: "building",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: 3,
      createdAt: AT,
      taskTitle: "Task",
      taskSnapshot: {
        title: "Task",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      backendRevision: 1,
      controller: "backend",
    };
    expect(isBuildPipeline(pipeline)).toBe(true);
    expect(isBuildPipeline({ ...pipeline, keyInformation: built() })).toBe(true);
    expect(isBuildPipeline({ ...pipeline, keyInformation: { framing: "problem" } })).toBe(false);
  });
});

describe("hasKeyInformation", () => {
  test("is false until a section has content", () => {
    expect(hasKeyInformation(undefined)).toBe(false);
    expect(hasKeyInformation(emptyKeyInformation(AT))).toBe(false);
    expect(hasKeyInformation({ ...emptyKeyInformation(AT), framing: "objective" })).toBe(false);
    expect(hasKeyInformation(built())).toBe(true);
  });
});
