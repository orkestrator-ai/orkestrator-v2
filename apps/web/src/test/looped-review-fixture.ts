import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { LOOPED_REVIEW_WORKFLOW_VERSION } from "@orkestrator/protocol/review-workflow";
import type { LoopedReviewWorkflow } from "@/stores/loopedReviewStore";

let sequence = 0;

export function loopedReviewFixture(
  overrides: Partial<LoopedReviewWorkflow> = {},
): LoopedReviewWorkflow {
  sequence += 1;
  const timestamp = new Date(1_700_000_000_000 + sequence).toISOString();
  const allowance = overrides.startingAllowance ?? overrides.currentAllowance ?? 6;
  return {
    version: LOOPED_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: `workflow-${sequence}`,
    environmentId: "env-1",
    projectId: "project-1",
    agent: "codex",
    model: "gpt-5.4",
    targetBranch: "main",
    startingAllowance: allowance,
    currentAllowance: allowance,
    currentRound: 1,
    currentPass: 0,
    phase: "preparing",
    rounds: [
      {
        round: 1,
        allowance,
        status: "preparing",
        passes: [],
        startedAt: timestamp,
      },
    ],
    activePool: { issues: [], coverageGaps: [] },
    archivedPools: [],
    sessions: [],
    interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
    pr: { status: "pending" },
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 1,
    ...overrides,
  };
}
