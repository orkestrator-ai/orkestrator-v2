import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";

const timestamp = "2026-11-04T00:00:00.000Z";

/** Complete wire snapshots, deliberately independent of the translation maps. */
export function workflowVocabularyFixtures() {
  const pipeline: BuildPipeline = {
    id: "r",
    taskId: "t",
    projectId: "p",
    environmentId: "e",
    environmentType: "local",
    agentType: "codex",
    phase: "fixing",
    steps: { address: { agent: "codex", model: "default" } },
    sessions: [
      {
        phase: "fix",
        iteration: 1,
        sessionKey: "existing-fix-key",
        sdkSessionId: "existing-provider-id",
        status: "running",
        startedAt: timestamp,
        label: "Rework",
        fixWorktreeFingerprintAtStart: "a".repeat(64),
      },
    ],
    currentSessionIndex: 0,
    iteration: 1,
    maxIterations: 3,
    createdAt: timestamp,
    taskTitle: "Vocabulary compatibility",
    taskSnapshot: {
      title: "Vocabulary compatibility",
      description: "address-findings and rework are user text",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 7,
    controller: "backend",
  };
  const review: MultiReviewWorkflow = {
    version: 1,
    controller: "backend",
    id: "r",
    projectId: "p",
    environmentId: "e",
    targetBranch: "main",
    phase: "fixing",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "codex",
        model: "default",
        status: "completed",
        report: TEST_STRUCTURED_REVIEW_REPORT,
      },
    ],
    fixModel: { agent: "codex", model: "default" },
    autoFix: true,
    fixSessionKey: "existing-fix-key",
    fixSession: {
      agent: "codex",
      model: "default",
      sessionKey: "existing-fix-key",
      providerSessionId: "existing-provider-id",
      openedFor: "fix",
      requestIds: ["existing-request"],
      status: "running",
      startedAt: timestamp,
    },
    activeRequest: {
      kind: "fix",
      requestId: "existing-request",
      state: "sent",
      createdAt: timestamp,
    },
    stepRuntimes: { fix: { startedAt: timestamp } },
    consolidatedReport: TEST_STRUCTURED_REVIEW_REPORT,
    reviewInstruction: "Only address-findings in the report",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 7,
  };
  const { fixWorktreeFingerprintAtStart, ...session } = pipeline.sessions[0]!;
  const futurePipeline = {
    ...pipeline,
    phase: "reworking",
    steps: { "address-findings": pipeline.steps!.address },
    sessions: [
      {
        ...session,
        phase: "rework",
        reworkWorktreeFingerprintAtStart: fixWorktreeFingerprintAtStart,
      },
    ],
  };
  const { fixModel, autoFix, fixSessionKey, fixSession, ...rest } = review;
  const futureReview = {
    ...rest,
    phase: "addressing-findings",
    addressFindingsModel: fixModel,
    autoAddressFindings: autoFix,
    addressFindingsSessionKey: fixSessionKey,
    addressFindingsSession: { ...fixSession, openedFor: "address-findings" },
    activeRequest: { ...review.activeRequest, kind: "address-findings" },
    stepRuntimes: { "address-findings": review.stepRuntimes!.fix },
  };
  return { pipeline, review, futurePipeline, futureReview };
}
