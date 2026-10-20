/**
 * Transcript-artifact authority for reviewer turns (Multi Review and the
 * build pipeline's fan-out): each dispatched turn gets an artifact grant owned
 * by the reviewer session's own key, delivered the way its provider can carry
 * it, and revoked when the turn settles or its send is refused.
 */
import { describe, expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  ProviderDispatchPreparationError,
  type BuildPipelineProvider,
} from "./build-pipeline-provider.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { ReviewFanoutRunner, type ReviewFanoutHost } from "./review-fanout.js";
import { beginWorkflowArtifactTurn, type ArtifactTurnDispatch } from "./workflow-artifact-turns.js";

const policy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "looped-review",
);
const CONNECTION = { url: "http://127.0.0.1:43123/mcp", token: "attempt-capability" };

function dispatchDouble(options: { toolsEnabled?: boolean } = {}) {
  const begun: Array<Parameters<ArtifactTurnDispatch["beginTurn"]>[0]> = [];
  const settled: Array<[string, string, string]> = [];
  const dispatch: ArtifactTurnDispatch = {
    beginTurn(input) {
      begun.push(input);
      return { grant: `oag1.grant-for-${input.turnId}` };
    },
    settleTurn(environmentId, conversationKey, turnId) {
      settled.push([environmentId, conversationKey, turnId]);
    },
    toolsEnabled: () => options.toolsEnabled ?? true,
  };
  return { dispatch, begun, settled };
}

function harness(
  agent: ReviewerRecord["agent"],
  status: "running" | "idle",
  sendImpl?: () => Promise<void>,
) {
  const sends: Array<Record<string, unknown>> = [];
  const attached: Array<Record<string, unknown> | undefined> = [];
  const provider = {
    async createSession() {
      return "unused";
    },
    async prepareDispatch(_sessionId: string, options?: Record<string, unknown>) {
      attached.push(options);
    },
    async send(_sessionId: string, _prompt: string, options: Record<string, unknown>) {
      sends.push(options);
      await sendImpl?.();
    },
    async status() {
      return status;
    },
    async messages() {
      return [];
    },
    async structured() {
      return null;
    },
  } as unknown as BuildPipelineProvider;
  const reviewer: ReviewerRecord = {
    id: "reviewer-1",
    agent,
    model: "default",
    status: "running",
    sessionKey: "multi-review:workflow-1:reviewer:reviewer-1",
    providerSessionId: "review-session",
    requestId: "review-request",
    dispatchState: "prepared",
    resultTransport: "tool-v1",
  };
  const artifacts = dispatchDouble();
  const host: ReviewFanoutHost = {
    workflowId: "workflow-1",
    targetBranch: "main",
    label: "test review",
    reviewerMode: "plan",
    sessionKeyFor: () => "multi-review:workflow-1:reviewer:reviewer-1",
    sessionLabelFor: () => "Reviewer",
    async provider() {
      return provider;
    },
    async executionPolicy() {
      return policy;
    },
    agentMcp: async () =>
      agent === "opencode"
        ? { ...CONNECTION, token: "broker", workflowResultCapability: "signed-attempt" }
        : CONNECTION,
    async save() {},
    async assertFence() {},
    async reviewerPrompt() {
      return "Inspect the immutable review package";
    },
    async resolveUnattendedInteractions() {},
    async abandonSession() {},
    progress: new MultiReviewProgressTracker(),
    artifactTurns: { dispatch: artifacts.dispatch, environmentId: "env-1", projectId: "project-1" },
  };
  return { host, reviewer, sends, attached, artifacts };
}

describe("reviewer turns' artifact authority", () => {
  test("an HTTP bridge turn gets an artifact-only connection owned by the reviewer session", async () => {
    const h = harness("claude", "running");
    await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);

    expect(h.artifacts.begun).toEqual([
      {
        environmentId: "env-1",
        projectId: "project-1",
        conversationKey: "multi-review:workflow-1:reviewer:reviewer-1",
        turnId: "review-request",
        providerSessionId: "review-session",
        needsGrant: true,
      },
    ]);
    const delivered = { ...CONNECTION, artifacts: { token: "oag1.grant-for-review-request" } };
    // The attach and the prompt carry the same connection, so the bridge does
    // not rebuild its session between them.
    expect(h.attached[0]?.agentMcp).toEqual(delivered);
    expect(h.sends[0]?.agentMcp).toEqual(delivered);
    expect(h.sends[0]?.artifactGrant).toBeUndefined();
    // The workflow-result tool and key are the attempt's own, unchanged.
    expect(h.sends[0]).toMatchObject({
      readOnly: true,
      workflowResultTool: "submit_review_report",
      workflowResultKey: "review-request",
    });
    expect(h.artifacts.settled).toEqual([]);
  });

  test("an OpenCode turn gets the grant as its trusted instruction instead", async () => {
    const h = harness("opencode", "running");
    await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);

    expect(h.sends[0]?.artifactGrant).toBe("oag1.grant-for-review-request");
    expect(h.sends[0]?.agentMcp).toEqual({
      ...CONNECTION,
      token: "broker",
      workflowResultCapability: "signed-attempt",
    });
  });

  test("the grant ends when the turn settles", async () => {
    const h = harness("claude", "idle");
    await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);

    expect(h.sends).toHaveLength(1);
    expect(h.artifacts.settled).toContainEqual([
      "env-1",
      "multi-review:workflow-1:reviewer:reviewer-1",
      "review-request",
    ]);
  });

  test("a refused send never leaves its grant live", async () => {
    const h = harness("claude", "running", async () => {
      throw new ProviderDispatchPreparationError("mcp add failed");
    });
    await new ReviewFanoutRunner(h.host).advanceReviewers([h.reviewer]);

    expect(h.reviewer.dispatchState).toBe("prepared");
    expect(h.artifacts.settled).toEqual([
      ["env-1", "multi-review:workflow-1:reviewer:reviewer-1", "review-request"],
    ]);
  });
});

describe("beginWorkflowArtifactTurn", () => {
  const input = {
    environmentId: "env-1",
    projectId: "project-1",
    conversationKey: "build-1:verify:0:session",
    turnId: "turn-1",
    providerSessionId: "provider-1",
  };

  test("mints nothing an agent could not use", () => {
    const { dispatch, begun } = dispatchDouble();
    // An HTTP bridge without a tool-mode connection has nowhere to carry it.
    expect(beginWorkflowArtifactTurn(dispatch, { ...input, agent: "codex" })).toBeUndefined();
    expect(begun).toEqual([]);
    // Nor while artifact tools are not served at all.
    const off = dispatchDouble({ toolsEnabled: false });
    expect(
      beginWorkflowArtifactTurn(off.dispatch, { ...input, agent: "claude", agentMcp: CONNECTION }),
    ).toBeUndefined();
    expect(off.begun).toEqual([]);
    expect(beginWorkflowArtifactTurn(undefined, { ...input, agent: "opencode" })).toBeUndefined();
  });

  test("never extends the workflow-result connection's own credential", () => {
    const { dispatch } = dispatchDouble();
    const turn = beginWorkflowArtifactTurn(dispatch, {
      ...input,
      agent: "pi",
      agentMcp: CONNECTION,
    });
    expect(turn).toEqual({
      agentMcp: { ...CONNECTION, artifacts: { token: "oag1.grant-for-turn-1" } },
    });
    expect(turn?.agentMcp?.token).toBe(CONNECTION.token);
  });
});
