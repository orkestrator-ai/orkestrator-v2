import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";

const timestamp = "2026-11-04T00:00:00.000Z";

/** Complete wire snapshots in the current names, and the same records in the former names. */
export function workflowVocabularyFixtures() {
  const pipeline: BuildPipeline = {
    id: "r",
    taskId: "t",
    projectId: "p",
    environmentId: "e",
    environmentType: "local",
    agentType: "codex",
    phase: "reworking",
    steps: { "address-findings": { agent: "codex", model: "default" } },
    sessions: [
      {
        phase: "rework",
        iteration: 1,
        sessionKey: "existing-fix-key",
        sdkSessionId: "existing-provider-id",
        status: "running",
        startedAt: timestamp,
        label: "Rework",
        reworkWorktreeFingerprintAtStart: "a".repeat(64),
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
    phase: "addressing-findings",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "codex",
        model: "default",
        status: "completed",
        report: TEST_STRUCTURED_REVIEW_REPORT,
      },
    ],
    addressFindingsModel: { agent: "codex", model: "default" },
    autoAddressFindings: true,
    addressFindingsSessionKey: "existing-fix-key",
    addressFindingsSession: {
      agent: "codex",
      model: "default",
      sessionKey: "existing-fix-key",
      providerSessionId: "existing-provider-id",
      openedFor: "address-findings",
      requestIds: ["existing-request"],
      status: "running",
      startedAt: timestamp,
    },
    activeRequest: {
      kind: "address-findings",
      requestId: "existing-request",
      state: "sent",
      createdAt: timestamp,
    },
    stepRuntimes: { "address-findings": { startedAt: timestamp } },
    consolidatedReport: TEST_STRUCTURED_REVIEW_REPORT,
    reviewInstruction: "Only address-findings in the report",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 7,
  };
  const { reworkWorktreeFingerprintAtStart, ...session } = pipeline.sessions[0]!;
  // The names builds before to-do 4740 stored and sent. Only the backend's
  // one-way storage migration reads them; the renderer refuses them.
  const formerPipeline = {
    ...pipeline,
    phase: "fixing",
    steps: { address: pipeline.steps!["address-findings"] },
    sessions: [
      { ...session, phase: "fix", fixWorktreeFingerprintAtStart: reworkWorktreeFingerprintAtStart },
    ],
  };
  const {
    addressFindingsModel,
    autoAddressFindings,
    addressFindingsSessionKey,
    addressFindingsSession,
    ...rest
  } = review;
  const formerReview = {
    ...rest,
    phase: "fixing",
    fixModel: addressFindingsModel,
    autoFix: autoAddressFindings,
    fixSessionKey: addressFindingsSessionKey,
    fixSession: { ...addressFindingsSession, openedFor: "fix" },
    activeRequest: { ...review.activeRequest, kind: "fix" },
    stepRuntimes: { fix: review.stepRuntimes!["address-findings"] },
  };
  return { pipeline, review, formerPipeline, formerReview };
}
