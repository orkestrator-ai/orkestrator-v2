/**
 * Stage transcripts are referenced by the backend-owned pipeline record, not
 * embedded in it (efficiency plan step 16). The tab fetches the viewed stage's
 * committed body on demand and reports a stored transcript it cannot read.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import * as realBackend from "@/lib/backend";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

const realBackendSnapshot = { ...realBackend };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/*
 * react-virtuoso measures a real viewport, so its rows never render under
 * happy-dom. Stubbed exactly as the sibling suites do.
 */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: ({ messages, renderMessage, emptyState, header, footer }: any) => (
    <div>
      {header}
      {messages.length === 0 ? emptyState : null}
      {messages.map((message: unknown, index: number) => (
        <div key={index}>{renderMessage(index, message, null)}</div>
      ))}
      {footer}
    </div>
  ),
}));

const getBuildPipelineConditionalMock = mock(async (..._args: unknown[]): Promise<unknown> => null);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getBuildPipelineConditional: getBuildPipelineConditionalMock,
}));

const { BuildChatTab } = await import("./BuildChatTab");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

const verifyMessages = [
  {
    info: { id: "answer-2", role: "assistant" },
    parts: [{ type: "text", text: "All criteria pass" }],
  },
];

function reference(sdkSessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    sdkSessionId,
    manifestRevision: 2,
    revision: 2,
    messageCount: 1,
    bytes: 64,
    complete: true,
    committedAt: "2026-07-29T00:02:00.000Z",
    ...overrides,
  };
}

/** A pipeline as a body-free project list delivers it. */
const pipeline: BuildPipeline = {
  id: "pipeline-1",
  taskId: "task-1",
  projectId: "project-1",
  environmentId: "env-1",
  environmentType: "local",
  agentType: "codex",
  phase: "complete",
  sessions: [
    {
      phase: "build",
      iteration: 0,
      sessionKey: "build-key",
      sdkSessionId: "build-session",
      status: "idle",
      startedAt: "2026-07-29T00:00:00.000Z",
      label: "Build Session",
      messageRevision: 2,
      transcript: reference("build-session", { complete: false, omittedMessages: 3 }),
      transcriptCheckpointError: "quota",
    },
    {
      phase: "verify",
      iteration: 0,
      sessionKey: "verify-key",
      sdkSessionId: "verify-session",
      status: "idle",
      startedAt: "2026-07-29T00:01:00.000Z",
      label: "Verification Session",
      messageRevision: 2,
      transcript: reference("verify-session"),
    },
  ],
  currentSessionIndex: 1,
  iteration: 0,
  maxIterations: 3,
  createdAt: "2026-07-29T00:00:00.000Z",
  taskTitle: "Backend-owned build",
  taskSnapshot: {
    title: "Backend-owned build",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    images: [],
  },
  backendRevision: 8,
  controller: "backend",
};

function renderTab() {
  const element = (
    <BuildChatTab
      isActive
      data={{
        environmentId: "env-1",
        pipelineId: pipeline.id,
        taskId: "task-1",
        isLocal: true,
      }}
    />
  );
  const view = render(element);
  return { rerender: () => view.rerender(element) };
}

describe("BuildChatTab referenced transcripts", () => {
  beforeEach(() => {
    cleanup();
    getBuildPipelineConditionalMock.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
      viewedSessionIds: new Map(),
    });
    getBuildPipelineConditionalMock.mockImplementation(async () => ({
      unchanged: false,
      record: {
        version: 2,
        id: pipeline.id,
        projectId: pipeline.projectId,
        environmentId: pipeline.environmentId,
        snapshot: pipeline,
        revision: 8,
        updatedAt: "2026-07-29T00:00:00.000Z",
      },
      messagePatches: [
        { sessionKey: "verify-key", startIndex: 0, revision: 2, messages: verifyMessages },
        { sessionKey: "build-key", startIndex: 0, revision: 2, messages: [], unavailable: true },
      ],
    }));
  });

  test("loads the viewed stage's committed transcript, prioritizing that stage", async () => {
    renderTab();

    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());
    expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1);
    expect(getBuildPipelineConditionalMock.mock.calls[0]).toEqual([
      pipeline.id,
      8,
      {},
      "verify-key",
    ]);
  });

  test("reports an unreadable stored transcript once instead of re-requesting it", async () => {
    const { rerender } = renderTab();
    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: /^Build/ }));
    await waitFor(() =>
      expect(
        screen.getByText("The stored transcript for this stage could not be read."),
      ).toBeTruthy(),
    );
    // The reference says some history was not retained; say so.
    expect(
      screen.getByText(
        /3 messages were not kept in the stored transcript because of its size limit/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("The newest messages of this stage could not be stored yet."),
    ).toBeTruthy();
    const calls = getBuildPipelineConditionalMock.mock.calls.length;
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getBuildPipelineConditionalMock.mock.calls.length).toBe(calls);
  });
});
