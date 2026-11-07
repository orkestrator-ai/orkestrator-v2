/**
 * Shared set-up for the BuildChatTab suites: the backend and transcript-list
 * stubs, the pipeline fixtures, and helpers that drive the flow graph.
 *
 * Importing this module registers the stubs, so a suite imports it before it
 * loads `./BuildChatTab`, and calls {@link restoreBuildChatTabMocks} after.
 *
 * The tab renders inside a node scope of its own ({@link renderInBuildChat},
 * plan item 3011): seed and read its stores through {@link pipelineStore} or
 * `buildChatScope().store(def)`, and call {@link cleanupBuildChatScope} after
 * each test. The scope's node answers `get_build_pipeline` through the
 * `getBuildPipelineControlMock`/`getBuildPipelineConditionalMock` stubs.
 */
import { mock } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderInNodeScope,
  type RenderInNodeScopeOptions,
} from "@/test/render-in-node-scope";
import { buildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import type {
  BuildPipelineCodeRewindPreview,
  PipelineQueuedSteerDelivery,
} from "@orkestrator/protocol/build-pipeline";
import * as realBackend from "@/lib/backend";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { restoreMatchMedia } from "../../../../../tests/mocks/match-media";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";

const realBackendSnapshot = { ...realBackend };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/**
 * The props the tab handed the transcript list on its last render.
 *
 * `computeItemKey`, `find` and the scroll wiring are the list's contract with
 * the tab and never reach the DOM, so the stub records them rather than letting
 * them go unasserted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let listProps: any = null;

/*
 * react-virtuoso measures a real viewport, so its rows never render under
 * happy-dom. Every native chat tab's suite stubs it the same way to assert on
 * the transcript the shared renderer produced.
 */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: (props: any) => {
    listProps = props;
    const { messages, renderMessage, resolvePreviousMessage, emptyState, footer } = props;
    return (
      <div>
        {messages.length === 0 ? emptyState : null}
        {messages.map((message: unknown, index: number) => (
          <div key={index}>
            {renderMessage(
              index,
              message,
              // Mirror the real list so the tab's resolver actually runs here.
              resolvePreviousMessage
                ? resolvePreviousMessage(messages, index)
                : index > 0
                  ? messages[index - 1]
                  : null,
            )}
          </div>
        ))}
        {footer}
      </div>
    );
  },
}));
export const pauseBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...pipelineStore().getState().pipelines.get(pipelineId)!,
  phase: "paused" as const,
  backendRevision: 9,
}));
export const resumeBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...pipelineStore().getState().pipelines.get(pipelineId)!,
  phase: "building" as const,
  backendRevision: 10,
}));
export const cancelBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...pipelineStore().getState().pipelines.get(pipelineId)!,
  phase: "failed" as const,
  error: "Build cancelled",
  backendRevision: 11,
}));
export const sendMessageMock = mock(async (pipelineId: string, text: string) => ({
  ...pipelineStore().getState().pipelines.get(pipelineId)!,
  pendingUserMessages: [{ id: "queued-1", text, createdAt: "2026-07-29T00:02:00.000Z" }],
  backendRevision: 12,
}));
export const steerPipelineMock = mock(
  async (
    pipelineId: string,
    _text: string,
  ): Promise<{
    pipeline: BuildPipeline;
    delivery: "steered" | "queued";
  }> => ({
    pipeline: {
      ...pipelineStore().getState().pipelines.get(pipelineId)!,
      backendRevision: 13,
    },
    delivery: "steered",
  }),
);
export const steerQueuedMock = mock(
  async (
    pipelineId: string,
    messageId: string,
  ): Promise<{
    pipeline: BuildPipeline;
    delivery: PipelineQueuedSteerDelivery;
    notice?: string;
  }> => {
    const current = pipelineStore().getState().pipelines.get(pipelineId)!;
    return {
      pipeline: {
        ...current,
        pendingUserMessages: current.pendingUserMessages?.filter(({ id }) => id !== messageId),
        backendRevision: current.backendRevision + 1,
      },
      delivery: "steered",
    };
  },
);
export const removeQueuedMock = mock(
  async (
    pipelineId: string,
    messageId: string,
  ): Promise<{ pipeline: BuildPipeline; removed: boolean }> => {
    const current = pipelineStore().getState().pipelines.get(pipelineId)!;
    return {
      pipeline: {
        ...current,
        pendingUserMessages: current.pendingUserMessages?.filter(({ id }) => id !== messageId),
        backendRevision: current.backendRevision + 1,
      },
      removed: true,
    };
  },
);
export const restartCurrentStepMock = mock(async (pipelineId: string) => ({
  ...pipelineStore().getState().pipelines.get(pipelineId)!,
  backendRevision: 13,
}));
export const retryStageMock = mock(async (pipelineId: string): Promise<BuildPipeline> => ({
  ...pipelineStore().getState().pipelines.get(pipelineId)!,
  phase: "building" as const,
  error: undefined,
  failureContext: undefined,
  backendRevision: 14,
}));
export const restartStepMock = mock(
  async (pipelineId: string, _stageId: string, _selection?: unknown): Promise<BuildPipeline> => ({
    ...pipelineStore().getState().pipelines.get(pipelineId)!,
    phase: "building" as const,
    backendRevision: 15,
  }),
);
export const skipStepMock = mock(
  async (pipelineId: string, _stageId: string): Promise<BuildPipeline> => ({
    ...pipelineStore().getState().pipelines.get(pipelineId)!,
    phase: "reviewing" as const,
    backendRevision: 17,
  }),
);
export const retryInteractionFailureMock = mock(async (pipelineId: string) => ({
  ...pipelineStore().getState().pipelines.get(pipelineId)!,
  phase: "building" as const,
  error: undefined,
  failureContext: undefined,
  backendRevision: pipelineStore().getState().pipelines.get(pipelineId)!.backendRevision + 1,
}));
export const retryReviewerMock = mock(
  async (pipelineId: string, _reviewerId: string): Promise<BuildPipeline> => ({
    ...pipelineStore().getState().pipelines.get(pipelineId)!,
    backendRevision: 16,
  }),
);
export const restartReviewerMock = mock(
  async (pipelineId: string, _reviewerId: string): Promise<BuildPipeline> => ({
    ...pipelineStore().getState().pipelines.get(pipelineId)!,
    backendRevision: 17,
  }),
);
export const stopReviewerMock = mock(
  async (pipelineId: string, _reviewerId: string): Promise<BuildPipeline> => ({
    ...pipelineStore().getState().pipelines.get(pipelineId)!,
    backendRevision: 17,
  }),
);
export const previewCodeRewindMock = mock(
  async (pipelineId: string, stageId: string): Promise<BuildPipelineCodeRewindPreview> => ({
    pipelineId,
    sessionKey: stageId,
    iteration: 0,
    commits: [],
    commitCount: 0,
  }),
);
export const rewindCodeMock = mock(
  async (pipelineId: string, _stageId: string, _expectedHead: string): Promise<BuildPipeline> => ({
    ...pipelineStore().getState().pipelines.get(pipelineId)!,
    phase: "building" as const,
    backendRevision: 18,
  }),
);
export const getBuildPipelineConditionalMock = mock(
  async (_pipelineId: string, ..._rest: unknown[]) => null as unknown,
);
export const getBuildPipelineControlMock = mock(
  async (_pipelineId: string, ..._rest: unknown[]) => null as unknown,
);

const BUILD_CHAT_NODE = "bk_build-chat-node" as BackendId;

let buildChat: { windowScope: WindowScope; client: FakeNodeClient; scope: NodeScope } | null = null;

/**
 * The node scope the build tab renders in, created on first use. Its node
 * answers the pipeline point reads (`get_build_pipeline`, with
 * `knownSessions` for a transcript read) through the two stubs above.
 */
export function buildChatScope(): NodeScope {
  if (!buildChat) {
    type Args = Readonly<Record<string, unknown>>;
    // The tab's controls call its node (plan item 4007): each command reaches
    // the suite's stub with the arguments the `lib/backend` wrapper was given.
    const id = (args: Args) => args.pipelineId as string;
    const client = new FakeNodeClient({
      nodeId: BUILD_CHAT_NODE,
      invoke: {
        pause_build_pipeline: (args: Args) => pauseBuildPipelineMock(id(args)),
        resume_build_pipeline: (args: Args) => resumeBuildPipelineMock(id(args)),
        cancel_build_pipeline: (args: Args) => cancelBuildPipelineMock(id(args)),
        send_build_pipeline_message: (args: Args) => sendMessageMock(id(args), args.text as string),
        steer_build_pipeline: (args: Args) => steerPipelineMock(id(args), args.text as string),
        steer_queued_build_pipeline_message: (args: Args) =>
          steerQueuedMock(id(args), args.messageId as string),
        remove_queued_build_pipeline_message: (args: Args) =>
          removeQueuedMock(id(args), args.messageId as string),
        restart_build_pipeline_current_step: (args: Args) => restartCurrentStepMock(id(args)),
        retry_build_pipeline_stage: (args: Args) => retryStageMock(id(args)),
        restart_build_pipeline_step: (args: Args) =>
          "selection" in args
            ? restartStepMock(id(args), args.stageId as string, args.selection as never)
            : restartStepMock(id(args), args.stageId as string),
        preview_build_pipeline_code_rewind: (args: Args) =>
          previewCodeRewindMock(id(args), args.stageId as string),
        rewind_build_pipeline_code: (args: Args) =>
          rewindCodeMock(id(args), args.stageId as string, args.expectedHead as string),
        skip_build_pipeline_step: (args: Args) => skipStepMock(id(args), args.stageId as string),
        retry_build_pipeline_reviewer: (args: Args) =>
          retryReviewerMock(id(args), args.reviewerId as string),
        restart_build_pipeline_reviewer: (args: Args) =>
          restartReviewerMock(id(args), args.reviewerId as string),
        stop_build_pipeline_reviewer: (args: Args) =>
          stopReviewerMock(id(args), args.reviewerId as string),
        retry_build_pipeline_interaction_failure: (args: Args) =>
          retryInteractionFailureMock(id(args)),
        stop_review_validation_command: (args: Args) =>
          stopReviewValidationCommandMock(
            args.environmentId as string,
            args.run as NonNullable<BuildPipeline["validationRun"]>,
            args.resultId as string,
          ),
        // The launch options' OpenCode catalogue: none cached on this node.
        get_opencode_model_catalog_cache: () => null,
        get_build_pipeline: (args: Readonly<Record<string, unknown>>) =>
          "knownSessions" in args
            ? getBuildPipelineConditionalMock(
                args.pipelineId as string,
                args.knownRevision,
                args.knownSessions,
                args.prioritySessionKey,
              )
            : getBuildPipelineControlMock(args.pipelineId as string, args.knownRevision),
      },
    });
    const windowScope = new WindowScope();
    buildChat = { windowScope, client, scope: windowScope.open({ role: "command", client }) };
  }
  return buildChat.scope;
}

/** The rendered scope's pipelines. */
export function pipelineStore() {
  return buildChatScope().store(buildPipelineStore);
}

/** Renders `ui` inside {@link buildChatScope}. */
export function renderInBuildChat(
  ui: ReactElement,
  options: Omit<RenderInNodeScopeOptions, "client" | "windowScope" | "nodeId" | "role"> = {},
) {
  buildChatScope();
  return renderInNodeScope(ui, {
    ...options,
    windowScope: buildChat!.windowScope,
    client: buildChat!.client,
  });
}

/** Unmounts what was rendered and drops the scope, so the next test starts empty. */
export function cleanupBuildChatScope(): void {
  cleanupNodeScopes();
  buildChat?.windowScope.dispose();
  buildChat = null;
}
export const stopReviewValidationCommandMock = mock(
  async (
    _environmentId: string,
    run: NonNullable<BuildPipeline["validationRun"]>,
    _resultId?: string,
  ) => run,
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  pauseBuildPipeline: pauseBuildPipelineMock,
  resumeBuildPipeline: resumeBuildPipelineMock,
  cancelBuildPipeline: cancelBuildPipelineMock,
  sendBuildPipelineMessage: sendMessageMock,
  steerBuildPipeline: steerPipelineMock,
  steerQueuedBuildPipelineMessage: steerQueuedMock,
  removeQueuedBuildPipelineMessage: removeQueuedMock,
  restartBuildPipelineCurrentStep: restartCurrentStepMock,
  retryBuildPipelineStage: retryStageMock,
  restartBuildPipelineStep: restartStepMock,
  previewBuildPipelineCodeRewind: previewCodeRewindMock,
  rewindBuildPipelineCode: rewindCodeMock,
  skipBuildPipelineStep: skipStepMock,
  retryBuildPipelineReviewer: retryReviewerMock,
  restartBuildPipelineReviewer: restartReviewerMock,
  stopBuildPipelineReviewer: stopReviewerMock,
  retryBuildPipelineInteractionFailure: retryInteractionFailureMock,
  getBuildPipelineConditional: getBuildPipelineConditionalMock,
  getBuildPipelineControl: getBuildPipelineControlMock,
  stopReviewValidationCommand: stopReviewValidationCommandMock,
}));

export const { BuildChatTab } = await import("./BuildChatTab");

export function resetListProps(): void {
  listProps = null;
}

export function restoreBuildChatTabMocks(): void {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
  restoreMatchMedia();
}

export const pipeline: BuildPipeline = {
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
      messages: [
        {
          id: "answer-1",
          role: "assistant",
          parts: [{ type: "text", content: "Implementation complete" }],
        },
      ],
    },
    {
      phase: "verify",
      iteration: 0,
      sessionKey: "verify-key",
      sdkSessionId: "verify-session",
      status: "idle",
      startedAt: "2026-07-29T00:01:00.000Z",
      label: "Verification Session",
      messages: [
        {
          id: "answer-2",
          role: "assistant",
          content: "All criteria pass",
          parts: [{ type: "text", content: "All criteria pass" }],
        },
      ],
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

export type ValidationRun = NonNullable<BuildPipeline["validationRun"]>;

export function validationRun(overrides: Partial<ValidationRun> = {}): ValidationRun {
  const command = {
    id: "test",
    command: "mise run test",
    cwd: ".",
    dependsOn: [] as string[],
    resources: ["turbo"],
    weight: 2 as const,
    timeoutMs: 1_200_000,
  };
  return {
    id: "validation-1",
    status: "completed",
    startedAt: "2026-09-08T20:00:04.000Z",
    completedAt: "2026-09-08T20:00:07.000Z",
    plan: {
      headRef: "a".repeat(40),
      commands: [command],
      limitations: [],
    },
    results: [
      {
        id: "test",
        command: "mise run test",
        status: "passed",
        exitCode: 0,
        stdoutPath: ".orkestrator/test.stdout",
        stderrPath: ".orkestrator/test.stderr",
        stdoutBytes: 24,
        stderrBytes: 0,
        durationMs: 3_000,
        limitation: null,
      },
    ],
    ...overrides,
  };
}

export function validationResult(
  status: ValidationRun["results"][number]["status"],
  exitCode: number | null = status === "passed" || status === "skipped" ? 0 : 1,
): ValidationRun["results"][number] {
  return {
    id: "test",
    command: "mise run test",
    status,
    exitCode,
    stdoutPath: ".orkestrator/test.stdout",
    stderrPath: ".orkestrator/test.stderr",
    stdoutBytes: 24,
    stderrBytes: 0,
    durationMs: 3_000,
    limitation: null,
  };
}

/** The graph's tablist. */
export function graph(): HTMLElement {
  return screen.getByRole("tablist", { name: "Build pipeline" });
}

function titlePattern(title: string): RegExp {
  return new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`);
}

/** The graph node whose title is exactly `title`. */
export function graphNode(title: string): HTMLElement {
  return within(graph()).getByRole("tab", { name: titlePattern(title) });
}

export function queryGraphNode(title: string): HTMLElement | null {
  return within(graph()).queryByRole("tab", { name: titlePattern(title) });
}

export function selectNode(title: string): void {
  fireEvent.click(graphNode(title));
}

/** Every node's title, left to right. */
export function nodeTitles(): string[] {
  return within(graph())
    .getAllByRole("tab")
    .map((tab) => tab.getAttribute("aria-label")?.split(", ")[0] ?? "");
}

/** The selected node's title. */
export function selectedTitle(): string | null {
  const selected = within(graph())
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true");
  return selected?.getAttribute("aria-label")?.split(", ")[0] ?? null;
}

export function headerText(text: string): HTMLElement {
  return within(screen.getByTestId("build-pipeline-header")).getByText(text);
}

export function inspector(): HTMLElement {
  return screen.getByTestId("pipeline-inspector");
}

/** Installs `next` as the only pipeline and renders its tab. */
export function renderPipelineTab(
  next: BuildPipeline,
  props: { isActive?: boolean; ownsGlobalShortcuts?: boolean } = {},
) {
  pipelineStore().setState({
    pipelines: new Map([[next.id, next]]),
    buildEnvironmentIds: new Set([next.environmentId]),
    viewedSessionIds: new Map(),
  });
  return renderInBuildChat(
    <BuildChatTab
      data={{
        pipelineId: next.id,
        environmentId: next.environmentId,
        taskId: next.taskId,
        isLocal: true,
      }}
      {...props}
    />,
  );
}

export const reviewSession: BuildPipeline["sessions"][number] = {
  phase: "review",
  iteration: 0,
  sessionKey: "review-key",
  sdkSessionId: "review-session",
  status: "idle",
  startedAt: "2026-07-29T00:00:30.000Z",
  label: "Review Session",
  structuredRequestId: "review-request",
  structuredResultStatus: "accepted",
  messages: [
    {
      id: "review-answer",
      role: "assistant",
      content: "The review is complete",
      parts: [
        { type: "text", content: "The review is complete" },
        {
          type: "tool-invocation",
          content: "shell",
          toolName: "shell",
          toolArgs: { command: "git diff --stat" },
          toolState: "success",
          toolOutput: "1 file changed",
        },
      ],
    },
  ],
};
export const reviewed: BuildPipeline = {
  ...pipeline,
  sessions: [pipeline.sessions[0]!, reviewSession, pipeline.sessions[1]!],
  currentSessionIndex: 2,
  structuredReview: TEST_STRUCTURED_REVIEW_REPORT,
  structuredReviewRequestId: "review-request",
  backendRevision: 40,
};

export function renderTab(next: BuildPipeline) {
  pipelineStore().setState({
    pipelines: new Map([[next.id, next]]),
    buildEnvironmentIds: new Set([next.environmentId]),
  });
  renderInBuildChat(
    <BuildChatTab
      data={{
        pipelineId: next.id,
        environmentId: next.environmentId,
        taskId: next.taskId,
        isLocal: true,
      }}
    />,
  );
}

/*
 * The pipeline transcript runs through the same adapter as the chat tabs, so
 * tool activity arrives grouped into a `tool-group` and one provider turn is
 * split into several timestamped rows. These helpers flatten both so the
 * assertions below stay about *which* activity survived payload filtering
 * rather than about the section boundaries, which `pipeline-transcript.test.ts`
 * owns.
 */
export interface RenderedPart {
  type: string;
  content: string;
  parts?: RenderedPart[];
}

export function renderedParts(): RenderedPart[] {
  return (listProps.messages as Array<{ parts: RenderedPart[] }>).flatMap(
    (message) => message.parts,
  );
}

export function visibleToolInvocations(): string[] {
  const collect = (parts: RenderedPart[]): string[] =>
    parts.flatMap((part) => {
      if (part.type === "tool-invocation") return [part.content];
      if (part.type === "tool-group" || part.type === "agent-group") {
        return collect(part.parts ?? []);
      }
      return [];
    });
  return collect(renderedParts());
}

export function visibleTextContents(): string[] {
  return renderedParts()
    .filter((part) => part.type === "text")
    .map((part) => part.content);
}

/** Shows one of the inspector's own views ("Transcript", "Tests"). */
export function showInspectorTab(name: string): void {
  const trigger = within(inspector()).getByRole("tab", { name });
  fireEvent.mouseDown(trigger);
  fireEvent.focus(trigger);
}

/** The data `<BuildChatTab>` takes for `pipeline`. */
export const tabData = {
  pipelineId: "pipeline-1",
  environmentId: "env-1",
  taskId: "task-1",
  isLocal: true,
};
