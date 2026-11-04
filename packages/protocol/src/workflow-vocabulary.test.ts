import { describe, expect, test } from "bun:test";
import { isBuildPipeline, type BuildPipeline } from "./build-pipeline.js";
import { isMultiReviewWorkflow, type MultiReviewWorkflow } from "./multi-review.js";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./testing/structured-review-fixtures.js";
import {
  BUILD_PIPELINE_RENAMES,
  MULTI_REVIEW_RENAMES,
  canonicalBuildPipeline,
  canonicalMultiReview,
} from "./workflow-vocabulary.js";

const pipeline = {
  phase: "paused",
  pausedFromPhase: "fixing",
  steps: { address: { agent: "codex", model: "gpt-6.1-sol" } },
  restartRequest: { kind: "review-package", implementationPhase: "fix" },
  skipRequest: { phase: "address" },
  taskSnapshot: { title: "rework", phase: "rework" },
  sessions: [
    { phase: "fix", label: "Fix Session", fixWorktreeFingerprintAtStart: "abc" },
    {
      phase: "address",
      addressReportKind: "fix-result",
      fixResult: { complete: true, notes: ["rework"] },
    },
  ],
};

const futurePipeline = {
  phase: "paused",
  pausedFromPhase: "reworking",
  steps: { "address-findings": { agent: "codex", model: "gpt-6.1-sol" } },
  restartRequest: { kind: "review-package", implementationPhase: "rework" },
  skipRequest: { phase: "address-findings" },
  taskSnapshot: { title: "rework", phase: "rework" },
  sessions: [
    { phase: "rework", label: "Fix Session", reworkWorktreeFingerprintAtStart: "abc" },
    {
      phase: "address-findings",
      addressFindingsReportKind: "address-findings-result",
      addressFindingsResult: { complete: true, notes: ["rework"] },
    },
  ],
};

const review = {
  phase: "paused",
  pausedFromPhase: "fixing",
  pausedStep: "fix",
  fixModel: { agent: "codex", model: "gpt-6.1-sol" },
  autoFix: true,
  fixSession: { openedFor: "fix", sessionKey: "key" },
  stepRuntimes: { fix: { completedAt: "2026-11-04T00:00:00.000Z" } },
  activeRequest: { kind: "fix", requestId: "request" },
  customFixInstruction: "address-findings",
  customFixModel: { agent: "codex" },
  addressPromptPending: true,
};

const futureReview = {
  phase: "paused",
  pausedFromPhase: "addressing-findings",
  pausedStep: "address-findings",
  addressFindingsModel: { agent: "codex", model: "gpt-6.1-sol" },
  autoAddressFindings: true,
  addressFindingsSession: { openedFor: "address-findings", sessionKey: "key" },
  stepRuntimes: { "address-findings": { completedAt: "2026-11-04T00:00:00.000Z" } },
  activeRequest: { kind: "address-findings", requestId: "request" },
  customAddressFindingsInstruction: "address-findings",
  customAddressFindingsModel: { agent: "codex" },
  addressPromptPending: true,
};

describe("workflow vocabulary", () => {
  test("reads a build pipeline written in the new names", () => {
    expect<unknown>(canonicalBuildPipeline(futurePipeline)).toEqual(pipeline);
  });

  test("reads a Multi Review written in the new names", () => {
    expect<unknown>(canonicalMultiReview(futureReview)).toEqual(review);
  });

  test("gives Fix its own meaning in each workflow", () => {
    expect(canonicalBuildPipeline({ phase: "addressing-findings" }).phase).toBe("addressing");
    expect(canonicalMultiReview({ phase: "addressing-findings" }).phase).toBe("fixing");
    expect(canonicalBuildPipeline({ phase: "address-findings" }).phase).toBe("address");
    expect(canonicalMultiReview({ pausedStep: "address-findings" }).pausedStep).toBe("fix");
  });

  test("keeps the package preparation session out of Rework's new names", () => {
    expect(canonicalBuildPipeline({ phase: "preparing-package" }).phase).toBe("fixing");
    expect(canonicalBuildPipeline({ phase: "package-preparation" }).phase).toBe("fix");
  });

  test("returns a current snapshot untouched, without copying", () => {
    expect(canonicalBuildPipeline(pipeline)).toBe(pipeline);
    expect(canonicalMultiReview(review)).toBe(review);
  });

  test("does not rewrite free text that happens to match a new name", () => {
    const value = { label: "rework", notes: ["reworking"], taskSnapshot: { phase: "rework" } };
    expect(canonicalBuildPipeline(value)).toBe(value);
  });

  test("does not treat inherited object properties as renames", () => {
    const value = { kind: "constructor", toString: "x" };
    expect(canonicalBuildPipeline(value)).toBe(value);
    expect(canonicalMultiReview(value)).toBe(value);
  });

  test("every new name differs from the name it replaces", () => {
    for (const renames of [BUILD_PIPELINE_RENAMES, MULTI_REVIEW_RENAMES]) {
      for (const [next, current] of Object.entries({ ...renames.keys, ...renames.values })) {
        expect(next).not.toBe(current);
      }
    }
  });
});

const STARTED = "2026-11-04T00:00:00.000Z";
const acceptedResult = {
  complete: true,
  summary: "Repaired the retry.",
  filesChanged: ["src/review.ts"],
  commandsRun: [
    { command: "bun test src/review.test.ts", result: "passed" as const, summary: "Passed." },
  ],
  notes: [],
  limitations: [],
};

function completePipeline(): BuildPipeline {
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
        phase: "fix",
        iteration: 1,
        sessionKey: "existing-fix-key",
        sdkSessionId: "provider-1",
        status: "running",
        startedAt: STARTED,
        label: "Rework",
        fixWorktreeFingerprintAtStart: "a".repeat(64),
      },
    ],
    currentSessionIndex: 0,
    iteration: 1,
    maxIterations: 3,
    createdAt: STARTED,
    taskTitle: "Retry safely",
    taskSnapshot: {
      title: "Retry safely",
      description: "rework",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 3,
    controller: "backend",
  };
}

function completeReview(): MultiReviewWorkflow {
  return {
    version: 1,
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
        report: TEST_STRUCTURED_REVIEW_REPORT,
      },
    ],
    fixModel: { agent: "codex", model: "gpt-6.1-sol" },
    fixSessionKey: "existing-fix-key",
    fixSession: {
      agent: "codex",
      model: "gpt-6.1-sol",
      sessionKey: "existing-fix-key",
      providerSessionId: "provider-1",
      requestIds: ["request-1"],
      openedFor: "fix",
      status: "running",
      startedAt: STARTED,
    },
    consolidatedReport: TEST_STRUCTURED_REVIEW_REPORT,
    activeRequest: { kind: "fix", requestId: "request-1", state: "sent", createdAt: STARTED },
    stepRuntimes: { fix: { startedAt: STARTED } },
    createdAt: STARTED,
    updatedAt: STARTED,
    backendRevision: 3,
  };
}

describe("complete snapshots from a newer peer", () => {
  test("validates active and paused Rework snapshots without changing restored session identities", () => {
    const current = completePipeline();
    expect(isBuildPipeline(current)).toBe(true);
    const { fixWorktreeFingerprintAtStart, ...session } = current.sessions[0]!;
    const future = {
      ...current,
      phase: "reworking",
      steps: { "address-findings": current.steps!.address },
      sessions: [
        {
          ...session,
          phase: "rework",
          reworkWorktreeFingerprintAtStart: fixWorktreeFingerprintAtStart,
        },
      ],
    };
    for (const snapshot of [future, { ...future, phase: "paused", pausedFromPhase: "reworking" }]) {
      expect(isBuildPipeline(snapshot)).toBe(false);
      const normalized = canonicalBuildPipeline(snapshot);
      expect(isBuildPipeline(normalized)).toBe(true);
      expect(normalized).toMatchObject(
        snapshot.phase === "paused"
          ? { phase: "paused", pausedFromPhase: "fixing" }
          : { phase: "fixing" },
      );
      expect(normalized.sessions[0]!.sessionKey).toBe("existing-fix-key");
      expect(normalized.sessions[0]!.sdkSessionId).toBe("provider-1");
      expect(normalized.taskSnapshot).toBe(current.taskSnapshot);
    }
  });

  test("validates a typed Address Findings result and retains accepted evidence", () => {
    const current = completePipeline();
    const future = {
      ...current,
      phase: "addressing-findings",
      sessions: [
        {
          ...current.sessions[0]!,
          phase: "address-findings",
          addressFindingsReportKind: "address-findings-result",
          addressFindingsResult: acceptedResult,
        },
      ],
    };
    const normalized = canonicalBuildPipeline(future);
    expect(isBuildPipeline(normalized)).toBe(true);
    expect(normalized.sessions[0]).toMatchObject({
      phase: "address",
      addressReportKind: "fix-result",
      fixResult: acceptedResult,
    });
    expect(
      isBuildPipeline(
        canonicalBuildPipeline({
          ...future,
          sessions: [
            {
              ...future.sessions[0]!,
              addressFindingsResult: { ...acceptedResult, complete: "yes" },
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  test("validates active and paused Address Findings requests and restores the original provider session", () => {
    const current = completeReview();
    expect(isMultiReviewWorkflow(current)).toBe(true);
    const { fixModel, fixSessionKey, fixSession, stepRuntimes, ...rest } = current;
    const future = {
      ...rest,
      phase: "addressing-findings",
      addressFindingsModel: fixModel,
      addressFindingsSessionKey: fixSessionKey,
      addressFindingsSession: { ...fixSession!, openedFor: "address-findings" },
      stepRuntimes: { "address-findings": stepRuntimes!.fix },
      activeRequest: { ...current.activeRequest!, kind: "address-findings" },
    };
    for (const snapshot of [
      future,
      {
        ...future,
        phase: "paused",
        pausedFromPhase: "addressing-findings",
        pausedStep: "address-findings",
      },
    ]) {
      expect(isMultiReviewWorkflow(snapshot)).toBe(false);
      const normalized = canonicalMultiReview(snapshot);
      expect(isMultiReviewWorkflow(normalized)).toBe(true);
      expect(normalized).toMatchObject(
        snapshot.phase === "paused"
          ? { phase: "paused", pausedFromPhase: "fixing", pausedStep: "fix" }
          : { phase: "fixing" },
      );
      expect(normalized).toMatchObject({
        fixSessionKey: "existing-fix-key",
        fixSession: {
          sessionKey: "existing-fix-key",
          providerSessionId: "provider-1",
          openedFor: "fix",
        },
        activeRequest: { kind: "fix", requestId: "request-1", state: "sent" },
      });
      expect(normalized.consolidatedReport).toBe(TEST_STRUCTURED_REVIEW_REPORT);
    }
  });

  test("validates a completed Address Findings result with its restored tab and PR identity", () => {
    const {
      fixModel,
      fixSessionKey,
      fixSession,
      activeRequest: _activeRequest,
      stepRuntimes: _stepRuntimes,
      ...rest
    } = completeReview();
    const normalized = canonicalMultiReview({
      ...rest,
      phase: "completed",
      addressFindingsModel: fixModel,
      addressFindingsSessionKey: fixSessionKey,
      addressFindingsSession: { ...fixSession!, status: "idle", openedFor: "address-findings" },
      addressFindingsResult: acceptedResult,
      addressFindingsTabId: "existing-tab",
      autoPrLaunch: {
        state: "pending",
        requestId: "pr-request",
        addressFindingsIdentity: "b".repeat(64),
      },
    });
    expect(isMultiReviewWorkflow(normalized)).toBe(true);
    expect(normalized).toMatchObject({
      fixResult: acceptedResult,
      fixTabId: "existing-tab",
      autoPrLaunch: { fixIdentity: "b".repeat(64), requestId: "pr-request" },
    });
  });
});
