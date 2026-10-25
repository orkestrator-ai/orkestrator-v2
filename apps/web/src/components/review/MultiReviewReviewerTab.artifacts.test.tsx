import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

/*
 * Virtuoso renders no rows in happy-dom; render every row in order, as the
 * other reviewer-tab suites do, and restore the real list afterwards.
 */
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  ...realVirtualizedMessageListSnapshot,
  VirtualizedMessageList: (props: {
    messages: unknown[];
    renderMessage: (index: number, message: unknown, previous: unknown) => ReactNode;
    emptyState?: ReactNode;
    header?: ReactNode;
    footer?: ReactNode;
  }) => (
    <div>
      {props.header}
      {props.messages.length === 0 ? props.emptyState : null}
      {props.messages.map((message, index) => (
        <div key={index}>
          {props.renderMessage(index, message, index > 0 ? props.messages[index - 1] : null)}
        </div>
      ))}
      {props.footer}
    </div>
  ),
}));
afterAll(() => {
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});
import type {
  MultiReviewReviewerTranscript,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { clearArtifactPublicationCache } from "@/hooks/useArtifactPublications";
import { clearArtifactRequestCache } from "@/lib/chat/artifact-requests";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import {
  installWorkflowArtifactBackend,
  listedConversations,
  workflowArtifactRef,
  workflowPublicationView,
  workflowPublishCall,
} from "@/lib/chat/workflow-artifact-test-support";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { MultiReviewReviewerTab } from "./MultiReviewReviewerTab";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const STARTED_AT = "2026-10-20T10:00:00.000Z";
const REVIEWER_KEY = "multi-review:multi-1:reviewer:reviewer-1";

function workflow(): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-review",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "running",
        startedAt: STARTED_AT,
        sessionKey: REVIEWER_KEY,
        providerSessionId: "provider-session-1",
      },
    ],
    fixModel: { agent: "claude", model: "opus" },
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    backendRevision: 1,
  };
}

function transcript(): MultiReviewReviewerTranscript {
  return {
    workflowId: "multi-1",
    reviewerId: "reviewer-1",
    workflowPhase: "reviewing",
    agent: "claude",
    model: "opus",
    status: "running",
    startedAt: STARTED_AT,
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        createdAt: STARTED_AT,
        parts: [
          { type: "text", content: "Charting the findings" },
          workflowPublishCall("toolu_reviewer", "art_reviewer1"),
        ],
      },
    ],
    transcript: "snapshot",
  };
}

beforeEach(() => {
  resetTranscriptArtifactCapabilities();
  clearArtifactRequestCache();
  clearArtifactPublicationCache();
  invokeMock.mockReset();
  useMultiReviewStore.setState({ workflows: new Map() });
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
});

describe("published artifacts in a Multi Review reviewer tab", () => {
  test("the reviewer's own publication renders as a card beside its publish call", async () => {
    installWorkflowArtifactBackend(invokeMock, [
      {
        environmentId: "env-review",
        logicalSessionKey: REVIEWER_KEY,
        publications: [
          workflowPublicationView(workflowArtifactRef("art_reviewer1", "Findings by area"), {
            toolCallId: "toolu_reviewer",
          }),
        ],
      },
      {
        // Another reviewer's publication never reaches this tab.
        environmentId: "env-review",
        logicalSessionKey: "multi-review:multi-1:reviewer:reviewer-2",
        publications: [workflowPublicationView(workflowArtifactRef("art_other0001", "Not mine"))],
      },
    ]);
    useMultiReviewStore.getState().replaceWorkflow(workflow());
    const { container } = render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-review",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={mock(async () => transcript())}
        refreshIntervalMs={60_000}
      />,
    );

    expect(await screen.findByText("Findings by area")).toBeTruthy();
    expect(container.querySelector('[data-rich-block="artifact"]') === null).toBe(false);
    // Resolved in the reviewer's conversation, never shown as detached.
    expect(container.querySelector('[data-artifact-notice="detached"]') === null).toBe(true);
    expect(screen.queryByText("Not mine") === null).toBe(true);
    expect(listedConversations(invokeMock)).toContain(`env-review/${REVIEWER_KEY}`);
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          (call) =>
            call[0] === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication &&
            (call[1] as { logicalSessionKey?: string }).logicalSessionKey === REVIEWER_KEY,
        ),
      ).toBe(true),
    );
  });

  test("a reviewer whose session is not recorded yet reads no ledger", async () => {
    installWorkflowArtifactBackend(invokeMock, []);
    const pending = workflow();
    pending.reviewers = [{ ...pending.reviewers[0]!, sessionKey: undefined }];
    useMultiReviewStore.getState().replaceWorkflow(pending);
    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-review",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={mock(async () => transcript())}
        refreshIntervalMs={60_000}
      />,
    );
    expect(await screen.findByText("Charting the findings")).toBeTruthy();
    expect(listedConversations(invokeMock)).toEqual([]);
  });
});
