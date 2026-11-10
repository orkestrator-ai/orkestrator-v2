/**
 * Stage transcripts are referenced by the backend-owned pipeline record, not
 * embedded in it (efficiency plan step 16). The tab fetches the viewed stage's
 * committed body on demand and reports a stored transcript it cannot read.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { type BuildPipeline, buildPipelineStore } from "@/stores/buildPipelineStore";
import * as realBackend from "@/lib/backend";
import {
  buildPipelineChangeReadOptions,
  hydrateBuildPipeline,
} from "@/lib/build-pipeline-persistence";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

import { graphRunCacheKey, graphRunStore } from "@/stores/graphRunStore";
import { act as activationOf, agentSession } from "@/components/graph-run/graph-run.test-fixtures";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/*
 * react-virtuoso measures a real viewport, so its rows never render under
 * happy-dom. Stubbed exactly as the sibling suites do.
 */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: ({
    messages,
    renderMessage,
    computeItemKey,
    emptyState,
    header,
    footer,
  }: any) => (
    <div>
      {header}
      {messages.length === 0 ? emptyState : null}
      {messages.map((message: unknown, index: number) => (
        <div
          key={computeItemKey(index, message)}
          data-testid="transcript-row"
          data-row-id={computeItemKey(index, message)}
        >
          {renderMessage(index, message, null)}
        </div>
      ))}
      <div data-testid="transcript-footer">{footer}</div>
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
const { GraphActivationTranscript } =
  await import("@/components/graph-run/GraphActivationTranscript");

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
  const view = renderInAppCommandScope(element(true));
  fireEvent.click(screen.getByRole("tab", { name: /^Verify,/ }));
  return { rerender: (isActive = true) => view.rerender(element(isActive)) };
}

describe("BuildChatTab referenced transcripts", () => {
  beforeEach(() => {
    cleanup();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineControlMock.mockClear();
    pauseBuildPipelineMock.mockClear();
    appCommandStore(buildPipelineStore).setState({
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

  test("tool runs either side of a withheld document render as one block", async () => {
    const toolEntry = (id: string) => ({
      id,
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Read",
          toolUseId: `${id}-call`,
          toolArgs: { file_path: `${id}.ts` },
          toolState: "success",
        },
      ],
    });
    const draft = '{"status":"pass","criteria":[]}';
    const messages = [
      toolEntry("read-1"),
      { id: "draft", role: "assistant", content: draft, parts: [{ type: "text", content: draft }] },
      toolEntry("read-2"),
      {
        id: "answer",
        role: "assistant",
        content: "All criteria pass",
        parts: [{ type: "text", content: "All criteria pass" }],
      },
    ];
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
      messagePatches: [{ sessionKey: "verify-key", startIndex: 0, revision: 2, messages }],
    }));

    renderTab();

    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());
    expect(screen.queryByText(draft) === null).toBe(true);
    expect(screen.getAllByTestId("transcript-row")).toHaveLength(2);
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
    act(() => appCommandStore(buildPipelineStore).getState().replacePipeline(active));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(appCommandStore(buildPipelineStore).getState().pipelines.get(pipeline.id)?.phase).toBe(
        "paused",
      ),
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
    const view = renderInAppCommandScope(element(true, true));
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
    const logs = captureLogs();
    try {
      renderTab();
      await waitFor(() => expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(logs.records()).toContainEqual(
          expect.objectContaining({
            level: "warn",
            area: "web.build-pipeline",
            event: "transcript.load-failed",
            fields: expect.objectContaining({
              error: expect.objectContaining({ message: "temporary backend restart" }),
            }),
          }),
        ),
      );
      getBuildPipelineConditionalMock.mockImplementation(answer);
      expect(await screen.findByText("All criteria pass")).toBeTruthy();
      expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(2);
    } finally {
      logs.restore();
    }
  });
});

const adjacentTool = (id: string) => ({
  id,
  role: "assistant",
  content: "",
  parts: [
    {
      type: "tool-invocation",
      content: "",
      toolName: "Read",
      toolUseId: `${id}-call`,
      toolArgs: { file_path: `${id}.ts` },
      toolState: "success",
    },
  ],
});

test("graph activation reads retain the merged row through singleton trimming and regrowth", () => {
  const activation = activationOf(
    { nodeId: "builder" },
    { session: agentSession({ agent: "codex" }) },
  );
  const entries = [adjacentTool("a"), adjacentTool("b"), adjacentTool("c")];
  const publish = (messages: unknown[], revision: number) =>
    act(() => {
      appCommandStore(graphRunStore).setState({
        transcripts: new Map([
          [
            graphRunCacheKey("run-alias", activation.key),
            {
              status: "ready",
              error: null,
              revision,
              view: {
                status: "found",
                messages,
                startIndex: 0,
                messageCount: messages.length,
                revision,
                complete: true,
              },
            },
          ],
        ]),
      });
    });
  publish(entries, 1);
  const element = (
    <GraphActivationTranscript
      runId="run-alias"
      environmentId="env-alias"
      containerId={undefined}
      activation={activation}
      isActive={false}
      ownsGlobalShortcuts={false}
    />
  );
  const view = renderInAppCommandScope(element);
  const original = screen.getByTestId("transcript-row");
  expect(original.getAttribute("data-row-id")).toBe("a");
  expect(original.textContent).toContain("3");
  for (const [index, messages] of [
    entries.slice(1),
    entries.slice(2),
    [...entries.slice(2), adjacentTool("d")],
  ].entries()) {
    publish(messages, index + 2);
    expect(screen.getAllByTestId("transcript-row")).toHaveLength(1);
    expect(screen.getByTestId("transcript-row")).toBe(original);
    expect(original.getAttribute("data-row-id")).toBe("a");
  }
  view.unmount();
  appCommandStore(graphRunStore).setState({ transcripts: new Map() });
});

test("pipeline row aliases survive acceptance revealing and hiding a document", () => {
  const document = JSON.stringify({ complete: true, rationale: "All checks pass." });
  const entries = [
    adjacentTool("a"),
    {
      id: "verdict",
      role: "assistant",
      content: document,
      parts: [{ type: "text", content: document }],
    },
    adjacentTool("b"),
    adjacentTool("c"),
  ];
  const element = (accepted: boolean, messages = entries) => {
    const session = {
      ...pipeline.sessions[1]!,
      transcript: undefined,
      messages,
      structuredResultStatus: accepted ? ("accepted" as const) : ("pending" as const),
    };
    return (
      <PipelineSessionTranscript
        pipeline={{ ...pipeline, sessions: [session] }}
        session={session}
        visible
        isActive={false}
        ownsGlobalShortcuts={false}
        environmentId="env-alias"
        containerId={undefined}
        composer={false}
      />
    );
  };
  const view = renderInAppCommandScope(element(false));
  const original = screen.getByTestId("transcript-row");
  expect(original.getAttribute("data-row-id")).toBe("a");
  view.rerender(element(true));
  expect(
    screen.getAllByTestId("transcript-row").map((row) => row.getAttribute("data-row-id")),
  ).toEqual(["a", "verdict", "b"]);
  expect(screen.getAllByTestId("transcript-row")[0]).toBe(original);
  view.rerender(element(false));
  expect(screen.getByTestId("transcript-row")).toBe(original);
  view.rerender(element(false, entries.slice(3)));
  expect(screen.getByTestId("transcript-row")).toBe(original);
  view.rerender(element(false, [...entries.slice(3), adjacentTool("d")]));
  expect(screen.getByTestId("transcript-row")).toBe(original);
});

test("moves the review report out of the footer exactly once when wide and back when narrowed", () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const OriginalObserver = globalThis.ResizeObserver;
  let width = 900;
  const callbacks = new Set<() => void>();
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width } as DOMRect;
  };
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe() {
      callbacks.add(this.callback);
    }
    disconnect() {
      callbacks.delete(this.callback);
    }
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  const report = TEST_STRUCTURED_REVIEW_REPORT;
  const session = {
    ...pipeline.sessions[0]!,
    phase: "review" as const,
    messages: verifyMessages,
    reviewReport: report,
  };
  const loaded = { ...pipeline, structuredReview: report, sessions: [session] };
  try {
    const view = renderInAppCommandScope(
      <PipelineSessionTranscript
        pipeline={loaded}
        session={session}
        visible
        isActive={false}
        ownsGlobalShortcuts={false}
        environmentId="env-1"
        containerId={undefined}
        composer={false}
      />,
    );
    const row = screen.getByTestId("transcript-row");
    const footer = screen.getByTestId("transcript-footer");
    expect(footer.querySelectorAll("article").length).toBe(1);
    act(() => {
      width = 1280;
      for (const callback of Array.from(callbacks)) callback();
    });
    expect(screen.getAllByRole("article").length).toBe(1);
    expect(footer.querySelectorAll("article").length).toBe(0);
    expect(screen.getByTestId("pipeline-report-beside").querySelector("article")).toBeTruthy();
    expect(screen.getByTestId("transcript-row")).toBe(row);
    act(() => {
      width = 900;
      for (const callback of Array.from(callbacks)) callback();
    });
    expect(screen.getAllByRole("article").length).toBe(1);
    expect(footer.querySelectorAll("article").length).toBe(1);
    expect(screen.queryByTestId("pipeline-report-beside") === null).toBe(true);
    expect(screen.getByTestId("transcript-row")).toBe(row);
    view.unmount();
  } finally {
    cleanup();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    globalThis.ResizeObserver = OriginalObserver;
  }
});
