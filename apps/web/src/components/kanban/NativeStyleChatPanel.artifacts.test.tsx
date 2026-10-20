/**
 * Published artifacts in a feature-planning chat. Planning messages are plain
 * text, so no publish call anchors them: each publication of the chat's own
 * conversation appears at its publication time, as an unanchored row does in
 * a native tab, and its card resolves in that conversation.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { featurePlanningConversationKey } from "@orkestrator/protocol/feature-planning";
import { invoke } from "@/lib/native/backend";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { clearArtifactPublicationCache } from "@/hooks/useArtifactPublications";
import { clearArtifactRequestCache } from "@/lib/chat/artifact-requests";
import {
  installWorkflowArtifactBackend,
  listedConversations,
  workflowArtifactRef,
  workflowPublicationView,
} from "@/lib/chat/workflow-artifact-test-support";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
/* react-virtuoso renders no rows under happy-dom; stubbed as the sibling suites do. */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: (props: {
    messages: Array<{ id: string }>;
    renderMessage: (index: number, message: unknown, previous: unknown) => ReactNode;
    footer?: ReactNode;
  }) => (
    <div>
      {props.messages.map((message, index) => (
        <div key={index} data-row-id={message.id}>
          {props.renderMessage(index, message, null)}
        </div>
      ))}
      {props.footer}
    </div>
  ),
}));

const { NativeStyleChatPanel } = await import("./FeaturesView");

afterAll(() => {
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const FEATURE_KEY = featurePlanningConversationKey("feature-1");
const STORY_KEY = featurePlanningConversationKey("feature-1", "story-1");

const messages = [
  {
    id: "user-1",
    role: "user" as const,
    content: "Plan the export feature",
    createdAt: "2026-10-20T10:00:00.000Z",
  },
  {
    id: "assistant-1",
    role: "assistant" as const,
    content: "Here is the plan.",
    createdAt: "2026-10-20T10:00:10.000Z",
  },
];

function renderPanel(conversationKey: string) {
  return render(
    <NativeStyleChatPanel
      messages={messages}
      artifactConversation={{
        environmentId: "env-plan",
        conversationKey,
        generation: "codex-session-1",
      }}
      stripState={(content) => content}
      persistKey={`feature-chat-${conversationKey}`}
      draft=""
      setDraft={() => undefined}
      isRunning={false}
      loadingText="Codex is working..."
      placeholder="Describe the feature"
      onSend={() => undefined}
    />,
  );
}

describe("published artifacts in a feature-planning chat", () => {
  beforeEach(() => {
    cleanup();
    resetTranscriptArtifactCapabilities();
    clearArtifactRequestCache();
    clearArtifactPublicationCache();
    invokeMock.mockReset();
    installWorkflowArtifactBackend(invokeMock, [
      {
        environmentId: "env-plan",
        logicalSessionKey: FEATURE_KEY,
        publications: [
          workflowPublicationView(workflowArtifactRef("art_plan00001", "Rollout timeline"), {
            publishedAt: "2026-10-20T10:00:05.000Z",
          }),
        ],
      },
      {
        environmentId: "env-plan",
        logicalSessionKey: STORY_KEY,
        publications: [
          workflowPublicationView(workflowArtifactRef("art_story0001", "Story mock-up"), {
            publishedAt: "2026-10-20T10:00:05.000Z",
          }),
        ],
      },
    ]);
  });

  test("the chat's publication appears in place, resolved in its own conversation", async () => {
    const { container } = renderPanel(FEATURE_KEY);
    expect(await screen.findByText("Rollout timeline")).toBeTruthy();
    expect(screen.queryByText("Story mock-up") === null).toBe(true);
    // Between the request and the reply that followed the turn that published it.
    const rows = Array.from(container.querySelectorAll("[data-row-id]")).map((row) =>
      row.getAttribute("data-row-id"),
    );
    expect(rows).toEqual(["user-1", "orkestrator-artifact:pub_plan00001", "assistant-1"]);
    expect(container.querySelector('[data-artifact-notice="detached"]') === null).toBe(true);
    await waitFor(() =>
      expect(listedConversations(invokeMock)).toContain(`env-plan/${FEATURE_KEY}`),
    );
  });

  test("a story's refinement chat shows only that story's publications", async () => {
    renderPanel(STORY_KEY);
    expect(await screen.findByText("Story mock-up")).toBeTruthy();
    expect(screen.queryByText("Rollout timeline") === null).toBe(true);
  });
});
