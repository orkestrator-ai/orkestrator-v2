import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILD_PIPELINE_VERSION, isBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  isMultiReviewWorkflow,
  MULTI_REVIEW_WORKFLOW_VERSION,
} from "@orkestrator/protocol/multi-review";
import { emptyKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@orkestrator/protocol/testing/structured-review-fixtures";
import { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase, STORAGE_MIGRATIONS, storeLayout } from "./storage-stores.js";
import { StorageService } from "./storage.js";
import {
  renameFormerBuildPipelineNames,
  renameFormerMultiReviewNames,
  upgradeBuildPipelineVocabulary,
  upgradeMultiReviewVocabulary,
  WORKFLOW_VOCABULARY_UPGRADE_VERSION,
} from "./storage-workflow-vocabulary-upgrade.js";

const directories: string[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-workflow-vocabulary-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const STARTED = "2026-11-04T00:00:00.000Z";

const report = TEST_STRUCTURED_REVIEW_REPORT;

const acceptedResult = {
  complete: true,
  summary: "Repaired the retry.",
  filesChanged: ["src/review.ts"],
  commandsRun: [{ command: "bun test src/review.test.ts", result: "passed", summary: "Passed." }],
  notes: ["rework stays free text"],
  limitations: [],
};

/** A running Rework round, in the names builds before to-do 4740 wrote. */
function formerPipeline(): Record<string, unknown> {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "codex",
    phase: "fixing",
    steps: { address: { agent: "codex", model: "gpt-6.1-sol" } },
    sessions: [
      {
        phase: "address",
        iteration: 0,
        sessionKey: "pipeline-1:address:0:existing",
        sdkSessionId: "provider-address",
        status: "idle",
        startedAt: STARTED,
        completedAt: STARTED,
        label: "Address Findings Session",
        addressReportKind: "fix-result",
        fixResult: acceptedResult,
      },
      {
        phase: "fix",
        iteration: 1,
        sessionKey: "pipeline-1:fix:1:existing",
        sdkSessionId: "provider-rework",
        status: "running",
        startedAt: STARTED,
        label: "Rework Session",
        fixWorktreeFingerprintAtStart: "a".repeat(64),
      },
    ],
    currentSessionIndex: 1,
    iteration: 1,
    maxIterations: 3,
    createdAt: STARTED,
    taskTitle: "Retry safely",
    taskSnapshot: {
      title: "Retry safely",
      description: "fix the address handling",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    keyInformation: {
      ...emptyKeyInformation(STARTED),
      updates: [
        { at: STARTED, author: "address", round: 0, sections: ["workDone"] },
        { at: STARTED, author: "fix", round: 1, sections: ["workDone"] },
      ],
      workDone: ["Addressed the findings."],
    },
    backendRevision: 3,
    controller: "backend",
  };
}

/** A running Address Findings turn, in the former names. */
function formerReview(): Record<string, unknown> {
  return {
    version: MULTI_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: "review-1",
    environmentId: "environment-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "fixing",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "codex",
        model: "gpt-6.1-sol",
        status: "completed",
        report,
      },
    ],
    fixModel: { agent: "codex", model: "gpt-6.1-sol" },
    autoFix: true,
    fixSessionKey: "multi-review:review-1:fix",
    fixSession: {
      agent: "codex",
      model: "gpt-6.1-sol",
      sessionKey: "multi-review:review-1:fix",
      providerSessionId: "provider-1",
      requestIds: ["request-1"],
      openedFor: "fix",
      status: "running",
      startedAt: STARTED,
    },
    fixTabId: "multi-review-fix:review-1",
    consolidatedReport: report,
    activeRequest: { kind: "fix", requestId: "request-1", state: "sent", createdAt: STARTED },
    stepRuntimes: { fix: { startedAt: STARTED } },
    reviewInstruction: "fix only the fixing paths",
    createdAt: STARTED,
    updatedAt: STARTED,
    backendRevision: 3,
  };
}

describe("workflow vocabulary upgrade", () => {
  test("renames a build pipeline's stored values and fields", () => {
    const renamed = renameFormerBuildPipelineNames(formerPipeline()) as Record<string, unknown>;
    expect(renamed).toMatchObject({
      phase: "reworking",
      steps: { "address-findings": { agent: "codex", model: "gpt-6.1-sol" } },
      sessions: [
        {
          phase: "address-findings",
          addressFindingsReportKind: "address-findings-result",
          addressFindingsResult: acceptedResult,
        },
        { phase: "rework", reworkWorktreeFingerprintAtStart: "a".repeat(64) },
      ],
      keyInformation: {
        updates: [{ author: "address-findings" }, { author: "rework" }],
      },
    });
    expect(isBuildPipeline(renamed)).toBe(true);
    expect(JSON.stringify(renamed)).not.toMatch(/"(fixResult|addressReportKind|address)":/);
  });

  test("keeps session keys and free text exactly as written", () => {
    const former = formerPipeline();
    const renamed = renameFormerBuildPipelineNames(former) as ReturnType<typeof formerPipeline>;
    const sessions = renamed.sessions as Array<Record<string, unknown>>;
    // Transcript paths hash the session key; rewriting one would orphan them.
    expect(sessions.map((session) => session.sessionKey)).toEqual([
      "pipeline-1:address:0:existing",
      "pipeline-1:fix:1:existing",
    ]);
    expect(renamed.taskSnapshot).toBe(former.taskSnapshot);
    expect((sessions[0]!.addressFindingsResult as { notes: string[] }).notes).toEqual([
      "rework stays free text",
    ]);
  });

  test("gives Fix its Address Findings meaning in a Multi Review", () => {
    const renamed = renameFormerMultiReviewNames(formerReview()) as Record<string, unknown>;
    expect(renamed).toMatchObject({
      phase: "addressing-findings",
      addressFindingsModel: { agent: "codex", model: "gpt-6.1-sol" },
      autoAddressFindings: true,
      addressFindingsSessionKey: "multi-review:review-1:fix",
      addressFindingsSession: {
        sessionKey: "multi-review:review-1:fix",
        providerSessionId: "provider-1",
        openedFor: "address-findings",
      },
      addressFindingsTabId: "multi-review-fix:review-1",
      activeRequest: { kind: "address-findings", requestId: "request-1" },
      stepRuntimes: { "address-findings": { startedAt: STARTED } },
      reviewInstruction: "fix only the fixing paths",
    });
    expect(isMultiReviewWorkflow(renamed)).toBe(true);
    for (const former of ["fixModel", "autoFix", "fixSession", "fixSessionKey", "fixTabId"]) {
      expect(renamed).not.toHaveProperty(former);
    }
    const paused = renameFormerMultiReviewNames({
      ...formerReview(),
      phase: "paused",
      pausedFromPhase: "fixing",
      pausedStep: "fix",
      activeRequest: undefined,
    });
    expect(paused).toMatchObject({
      phase: "paused",
      pausedFromPhase: "addressing-findings",
      pausedStep: "address-findings",
    });
  });

  test("renames a completed review's result and PR launch identity", () => {
    const { activeRequest: _request, ...rest } = formerReview();
    const renamed = renameFormerMultiReviewNames({
      ...rest,
      phase: "completed",
      fixSession: { ...(rest.fixSession as object), status: "idle" },
      fixResult: acceptedResult,
      autoPrLaunch: {
        state: "pending",
        requestId: "pr-request",
        fixIdentity: "b".repeat(64),
      },
    });
    expect(renamed).toMatchObject({
      addressFindingsResult: acceptedResult,
      autoPrLaunch: { addressFindingsIdentity: "b".repeat(64), requestId: "pr-request" },
    });
    expect(isMultiReviewWorkflow(renamed)).toBe(true);
  });

  test("leaves current records, unreadable records and unreadable stores untouched", () => {
    const current = {
      "pipeline-1": { snapshot: renameFormerBuildPipelineNames(formerPipeline()) },
    };
    expect(upgradeBuildPipelineVocabulary(current)).toBe(current);
    const review = { "review-1": { snapshot: renameFormerMultiReviewNames(formerReview()) } };
    expect(upgradeMultiReviewVocabulary(review)).toBe(review);
    const unreadable = { broken: "not a record", missing: { revision: 1 } };
    expect(upgradeBuildPipelineVocabulary(unreadable)).toBe(unreadable);
    expect(upgradeMultiReviewVocabulary("not a store")).toBe("not a store");
  });

  test("an upgraded database is rewritten once and the backend reads it afterwards", async () => {
    const directory = await dataDir();
    const before = new StorageDatabase(directory, {
      layoutFor: storeLayout,
      migrations: STORAGE_MIGRATIONS.filter(
        (migration) => migration.version < WORKFLOW_VOCABULARY_UPGRADE_VERSION,
      ),
    });
    before.writeStore("build-pipelines", {
      "pipeline-1": {
        version: BUILD_PIPELINE_VERSION,
        id: "pipeline-1",
        projectId: "project-1",
        environmentId: "environment-1",
        snapshot: formerPipeline(),
        updatedAt: STARTED,
        revision: 4,
      },
    });
    before.writeStore("multi-reviews", {
      "review-1": {
        version: 1,
        id: "review-1",
        environmentId: "environment-1",
        snapshot: formerReview(),
        updatedAt: STARTED,
        revision: 6,
      },
    });
    before.close();

    const upgraded = openBackendDatabase(directory);
    try {
      expect(upgraded.schemaVersion()).toBeGreaterThanOrEqual(WORKFLOW_VOCABULARY_UPGRADE_VERSION);
    } finally {
      upgraded.close();
    }

    const storage = new StorageService(directory);
    await storage.init();
    const pipeline = await storage.getBuildPipeline("pipeline-1");
    // The revision is kept: this is the same record, not a new write to it.
    expect(pipeline?.revision).toBe(4);
    expect(isBuildPipeline(pipeline?.snapshot)).toBe(true);
    expect(pipeline?.snapshot).toMatchObject({
      phase: "reworking",
      sessions: [{ phase: "address-findings" }, { phase: "rework" }],
    });
    const review = await storage.getMultiReviewWorkflow("review-1");
    expect(review?.revision).toBe(6);
    expect(isMultiReviewWorkflow(review?.snapshot)).toBe(true);
    expect(review?.snapshot).toMatchObject({
      phase: "addressing-findings",
      addressFindingsSession: { sessionKey: "multi-review:review-1:fix" },
    });
  });
});
