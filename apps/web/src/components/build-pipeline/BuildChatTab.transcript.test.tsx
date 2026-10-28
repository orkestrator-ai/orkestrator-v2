/**
 * Stage transcripts are referenced by the backend-owned pipeline record, not
 * embedded in it (efficiency plan step 16). The tab fetches the viewed stage's
 * committed body on demand and reports a stored transcript it cannot read.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import * as realBackend from "@/lib/backend";
import {
  buildPipelineChangeReadOptions,
  hydrateBuildPipeline,
} from "@/lib/build-pipeline-persistence";
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
const getBuildPipelineControlMock = mock(async (..._args: unknown[]): Promise<unknown> => null);
const pauseBuildPipelineMock = mock(async (..._args: unknown[]): Promise<unknown> => null);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getBuildPipelineConditional: getBuildPipelineConditionalMock,
  getBuildPipelineControl: getBuildPipelineControlMock,
  pauseBuildPipeline: pauseBuildPipelineMock,
}));

const { BuildChatTab } = await import("./BuildChatTab");
const { PipelineSessionTranscript } = await import("./PipelineSessionTranscript");

afterEach(cleanup);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

const verifyMessages = [
  {
    id: "answer-2",
    role: "assistant",
    content: "All criteria pass",
    parts: [{ type: "text", content: "All criteria pass" }],
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
  const element = (isActive: boolean) => (
    <BuildChatTab
      isActive={isActive}
      data={{
        environmentId: "env-1",
        pipelineId: pipeline.id,
        taskId: "task-1",
        isLocal: true,
      }}
    />
  );
  const view = render(element(true));
  return { rerender: (isActive = true) => view.rerender(element(isActive)) };
}

describe("BuildChatTab referenced transcripts", () => {
  beforeEach(() => {
    cleanup();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineControlMock.mockClear();
    pauseBuildPipelineMock.mockClear();
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

    fireEvent.click(screen.getByRole("tab", { name: /^Build,/ }));
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

  test("a body-less pause response preserves the loaded stage transcript", async () => {
    const active = { ...pipeline, phase: "building" as const, backendRevision: 9 };
    pauseBuildPipelineMock.mockImplementation(async () => ({
      ...active,
      phase: "paused" as const,
      pausedFromPhase: "building" as const,
      backendRevision: 10,
    }));
    renderTab();
    expect(await screen.findByText("All criteria pass")).toBeTruthy();
    act(() => useBuildPipelineStore.getState().replacePipeline(active));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe("paused"),
    );
    expect(screen.getByText("All criteria pass")).toBeTruthy();
  });

  test("watches only the visible active session and releases body reads on hide, switch and unmount", async () => {
    const loaded = {
      ...pipeline,
      sessions: pipeline.sessions.map((session) => ({ ...session, messages: verifyMessages })),
    };
    const element = (visible: boolean, isActive: boolean, sessionIndex = 0, next = loaded) => (
      <PipelineSessionTranscript
        pipeline={next}
        session={next.sessions[sessionIndex]}
        visible={visible}
        isActive={isActive}
        ownsGlobalShortcuts={false}
        environmentId="env-1"
        containerId={undefined}
        composer={false}
      />
    );
    const view = render(element(true, true));
    expect(buildPipelineChangeReadOptions(pipeline.id)).toEqual({
      transcripts: true,
      prioritySessionKey: "build-key",
    });
    // Exercise the same option selection used by pipeline change events.
    getBuildPipelineConditionalMock.mockResolvedValueOnce({ unchanged: true, revision: 8 });
    await hydrateBuildPipeline(pipeline.id, undefined, buildPipelineChangeReadOptions(pipeline.id));
    expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1);

    view.rerender(element(false, true));
    expect(buildPipelineChangeReadOptions(pipeline.id)).toEqual({});
    getBuildPipelineControlMock.mockResolvedValueOnce({ unchanged: true, revision: 8 });
    await hydrateBuildPipeline(pipeline.id, undefined, buildPipelineChangeReadOptions(pipeline.id));
    expect(getBuildPipelineControlMock).toHaveBeenCalledTimes(1);
    expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1);

    view.rerender(element(true, true, 1));
    expect(buildPipelineChangeReadOptions(pipeline.id)).toEqual({
      transcripts: true,
      prioritySessionKey: "verify-key",
    });
    view.rerender(element(true, false, 1));
    expect(buildPipelineChangeReadOptions(pipeline.id)).toEqual({});
    view.rerender(element(true, true, 1));
    const other = { ...loaded, id: "pipeline-2" };
    view.rerender(element(true, true, 0, other));
    expect(buildPipelineChangeReadOptions(pipeline.id)).toEqual({});
    expect(buildPipelineChangeReadOptions(other.id)).toEqual({
      transcripts: true,
      prioritySessionKey: "build-key",
    });
    view.unmount();
    // If switching leaked the previous registration, either pipeline would
    // still ask for message bodies after its last view was released.
    expect(buildPipelineChangeReadOptions(pipeline.id)).toEqual({});
    expect(buildPipelineChangeReadOptions(other.id)).toEqual({});
    getBuildPipelineControlMock.mockResolvedValueOnce({ unchanged: true, revision: 8 });
    await hydrateBuildPipeline(other.id, undefined, buildPipelineChangeReadOptions(other.id));
    expect(getBuildPipelineControlMock).toHaveBeenCalledTimes(2);
    expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1);
  });

  test("a failed stage fetch retries while the completed tab remains open", async () => {
    const answer = getBuildPipelineConditionalMock.getMockImplementation()!;
    getBuildPipelineConditionalMock.mockImplementationOnce(async () => {
      throw new Error("temporary backend restart");
    });
    const warn = console.warn;
    console.warn = mock(() => undefined) as typeof console.warn;
    try {
      renderTab();
      await waitFor(() => expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(console.warn).toHaveBeenCalled());
      getBuildPipelineConditionalMock.mockImplementation(answer);
      expect(await screen.findByText("All criteria pass")).toBeTruthy();
      expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(2);
    } finally {
      console.warn = warn;
    }
  });
});
