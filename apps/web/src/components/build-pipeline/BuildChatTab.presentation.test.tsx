import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  BUILD_PIPELINE_AGENTS,
  REVIEW_PACKAGE_SESSION_LABEL,
  pipelineIndependentReviewLabel,
} from "@orkestrator/protocol/build-pipeline";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { nativeAgentAdapters } from "@/components/native-agent/adapter";
import { mockToastError, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";
import {
  BuildChatTab,
  graphNode,
  inspector,
  listProps,
  nodeTitles,
  pipeline,
  queryGraphNode,
  renderTab,
  restoreBuildChatTabMocks,
  retryStageMock,
  reviewSession,
  reviewed,
  selectNode,
  selectedTitle,
  validationRun,
  visibleTextContents,
  visibleToolInvocations,
} from "./build-chat-tab-test-support";

/**
 * What the build tab shows for each stage: graph nodes and their transcripts.
 */

afterAll(restoreBuildChatTabMocks);

describe("BuildChatTab presentation", () => {
  beforeEach(() => {
    cleanup();
    retryStageMock.mockClear();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
  });

  test("shows each reviewer with its friendly model name, elapsed time, and tokens", () => {
    const previousModels = useAgentModelCatalogStore.getState().codexModels;
    useAgentModelCatalogStore.setState({
      codexModels: [
        {
          id: "gpt-5.6-sol",
          name: "GPT 5.6 Sol",
          description: "Frontier coding model",
          reasoningEfforts: ["high"],
        },
      ],
    });
    const reviewA = {
      ...reviewSession,
      agent: "codex" as const,
      model: "gpt-5.6-sol",
      label: "Review 1",
      sessionKey: "review-iteration-1-a",
      sdkSessionId: "review-iteration-1-a-session",
      completedAt: "2026-07-29T00:02:05.000Z",
      tokenCount: 12_345,
    };
    const reviewB = {
      ...reviewA,
      label: "Review 2",
      sessionKey: "review-iteration-1-b",
      sdkSessionId: "review-iteration-1-b-session",
    };

    try {
      renderTab({
        ...reviewed,
        reviewers: [
          { agent: "codex", model: "gpt-5.6-sol" },
          { agent: "codex", model: "gpt-5.6-sol" },
        ],
        sessions: [pipeline.sessions[0]!, reviewA, reviewB, pipeline.sessions[1]!],
        currentSessionIndex: 3,
      });

      expect(graphNode("Reviewer 1")).toBeTruthy();
      expect(graphNode("Reviewer 2")).toBeTruthy();
      expect(screen.getAllByText(/GPT 5\.6 Sol/)).toHaveLength(2);
      expect(screen.getByLabelText("Reviewer 1 runtime and token usage").textContent).toBe(
        "1m 35s · 12k tokens",
      );
    } finally {
      cleanup();
      useAgentModelCatalogStore.setState({ codexModels: previousModels });
    }
  });

  test("advances a running review iteration timer while the tab is active", () => {
    const originalNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    let now = Date.parse("2026-07-29T00:00:05.000Z");
    let tick: (() => void) | undefined;
    Date.now = () => now;
    window.setInterval = ((callback: TimerHandler) => {
      tick = callback as () => void;
      return 45;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => undefined) as typeof window.clearInterval;
    const runningReview = {
      ...reviewSession,
      agent: "codex" as const,
      model: "gpt-5.4",
      label: "Review 1",
      sessionKey: "running-review",
      sdkSessionId: "running-review-session",
      status: "running" as const,
      startedAt: "2026-07-29T00:00:00.000Z",
      completedAt: undefined,
      tokenCount: undefined,
    };
    const running = {
      ...pipeline,
      phase: "reviewing" as const,
      sessions: [runningReview],
      currentSessionIndex: 0,
      reviewers: [
        { agent: "codex" as const, model: "gpt-5.4" },
        { agent: "claude" as const, model: "opus" },
      ],
    };
    useBuildPipelineStore.setState({
      pipelines: new Map([[running.id, running]]),
      buildEnvironmentIds: new Set([running.environmentId]),
      viewedSessionIds: new Map(),
    });

    try {
      render(
        <BuildChatTab
          data={{
            pipelineId: running.id,
            environmentId: running.environmentId,
            taskId: running.taskId,
            isLocal: true,
          }}
          isActive
        />,
      );
      const runtime = screen.getByLabelText("Reviewer 1 runtime and token usage");
      expect(runtime.textContent).toBe("5s · Tokens pending");

      now += 1_000;
      act(() => tick?.());
      expect(runtime.textContent).toBe("6s · Tokens pending");
    } finally {
      cleanup();
      Date.now = originalNow;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("keeps a surviving Review 2 in its own slot with its configured model", () => {
    const previousModels = useAgentModelCatalogStore.getState().codexModels;
    useAgentModelCatalogStore.setState({
      codexModels: [
        {
          id: "gpt-5.6-sol",
          name: "GPT 5.6 Sol",
          description: "Frontier coding model",
          reasoningEfforts: ["high"],
        },
        {
          id: "opus",
          name: "Opus",
          description: "Claude reviewer",
          reasoningEfforts: ["high"],
        },
      ],
    });
    const reviewTwo = {
      ...reviewSession,
      agent: "codex" as const,
      model: "gpt-5.6-sol",
      label: pipelineIndependentReviewLabel(1),
      sessionKey: "sparse-review-2",
      sdkSessionId: "sparse-review-2-session",
      completedAt: "2026-07-29T00:02:05.000Z",
      tokenCount: 2_000,
    };

    try {
      renderTab({
        ...reviewed,
        reviewers: [
          { agent: "claude", model: "opus" },
          { agent: "codex", model: "gpt-5.6-sol" },
        ],
        sessions: [pipeline.sessions[0]!, reviewTwo, pipeline.sessions[1]!],
        currentSessionIndex: 2,
      });

      expect(graphNode("Reviewer 2")).toBeTruthy();
      expect(queryGraphNode("Reviewer 1")).toBeNull();
      expect(within(graphNode("Reviewer 2")).getByText(/GPT 5\.6 Sol/)).toBeTruthy();
      expect(screen.queryByText(/Opus/) === null).toBe(true);
    } finally {
      cleanup();
      useAgentModelCatalogStore.setState({ codexModels: previousModels });
    }
  });

  test("shows the live retry pair once per slot and keeps each slot's configured model", () => {
    const previousModels = useAgentModelCatalogStore.getState().codexModels;
    useAgentModelCatalogStore.setState({
      codexModels: [
        {
          id: "gpt-5.6-sol",
          name: "GPT 5.6 Sol",
          description: "Frontier coding model",
          reasoningEfforts: ["high"],
        },
        {
          id: "opus",
          name: "Opus",
          description: "Claude reviewer",
          reasoningEfforts: ["high"],
        },
      ],
    });
    const staleA = {
      ...reviewSession,
      agent: "codex" as const,
      model: "gpt-5.6-sol",
      label: pipelineIndependentReviewLabel(0),
      sessionKey: "stale-a",
      sdkSessionId: "stale-a-session",
      completedAt: "2026-07-29T00:01:00.000Z",
      tokenCount: 1_000,
    };
    const staleB = {
      ...staleA,
      model: "opus",
      label: pipelineIndependentReviewLabel(1),
      sessionKey: "stale-b",
      sdkSessionId: "stale-b-session",
    };
    const liveA = {
      ...staleA,
      sessionKey: "live-a",
      sdkSessionId: "live-a-session",
      status: "running" as const,
      completedAt: undefined,
      tokenCount: undefined,
    };
    const liveB = {
      ...staleB,
      sessionKey: "live-b",
      sdkSessionId: "live-b-session",
      status: "running" as const,
      completedAt: undefined,
      tokenCount: undefined,
    };

    try {
      renderTab({
        ...reviewed,
        phase: "reviewing",
        reviewers: [
          { agent: "codex", model: "gpt-5.6-sol" },
          { agent: "claude", model: "opus" },
        ],
        reviewFanout: {
          reviewers: [
            {
              id: "live-1",
              agent: "codex",
              model: "gpt-5.6-sol",
              status: "running",
              sessionKey: "live-a",
            },
            {
              id: "live-2",
              agent: "claude",
              model: "opus",
              status: "running",
              sessionKey: "live-b",
            },
          ],
        },
        sessions: [pipeline.sessions[0]!, staleA, staleB, liveA, liveB],
        currentSessionIndex: 4,
      });

      expect(graphNode("Reviewer 1")).toBeTruthy();
      expect(graphNode("Reviewer 2")).toBeTruthy();
      // The earlier attempts are history behind each slot, not nodes of their own.
      expect(nodeTitles().filter((title) => title.startsWith("Reviewer"))).toEqual([
        "Reviewer 1",
        "Reviewer 2",
      ]);
      expect(within(graphNode("Reviewer 1")).getByText(/GPT 5\.6 Sol/)).toBeTruthy();
      expect(within(graphNode("Reviewer 2")).getByText(/Opus/)).toBeTruthy();
      selectNode("Reviewer 1");
      expect(within(inspector()).getByText("1 earlier attempt in this pass")).toBeTruthy();
    } finally {
      cleanup();
      useAgentModelCatalogStore.setState({ codexModels: previousModels });
    }
  });

  test("shows Provider default when a reviewer pinned no model", () => {
    const unpinned = {
      ...reviewSession,
      agent: "codex" as const,
      label: pipelineIndependentReviewLabel(0),
      sessionKey: "unpinned-review",
      sdkSessionId: "unpinned-review-session",
    };

    renderTab({
      ...reviewed,
      reviewers: [{ agent: "codex" }, { agent: "claude" }],
      reviewFanout: {
        reviewers: [
          {
            id: "unpinned-1",
            agent: "codex",
            model: "default",
            modelUnpinned: true,
            status: "completed",
            sessionKey: "unpinned-review",
          },
        ],
      },
      sessions: [pipeline.sessions[0]!, unpinned, pipeline.sessions[1]!],
      currentSessionIndex: 2,
    });

    expect(graphNode("Reviewer 1")).toBeTruthy();
    expect(within(graphNode("Reviewer 1")).getByText(/Provider default/)).toBeTruthy();
  });

  test("freezes a running review timer while inactive and restores persisted metadata on reactivation", () => {
    const originalNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    let now = Date.parse("2026-07-29T00:00:05.000Z");
    let tick: (() => void) | undefined;
    Date.now = () => now;
    window.setInterval = ((callback: TimerHandler) => {
      tick = callback as () => void;
      return 46;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => undefined) as typeof window.clearInterval;
    const runningReview = {
      ...reviewSession,
      agent: "codex" as const,
      model: "gpt-5.4",
      label: pipelineIndependentReviewLabel(0),
      sessionKey: "inactive-review",
      sdkSessionId: "inactive-review-session",
      status: "running" as const,
      startedAt: "2026-07-29T00:00:00.000Z",
      tokenCount: 12_345,
    };
    const running = {
      ...pipeline,
      phase: "reviewing" as const,
      sessions: [runningReview],
      currentSessionIndex: 0,
      reviewers: [{ agent: "codex" as const, model: "gpt-5.4" }],
    };
    useBuildPipelineStore.setState({
      pipelines: new Map([[running.id, running]]),
      buildEnvironmentIds: new Set([running.environmentId]),
      viewedSessionIds: new Map(),
    });

    try {
      const view = render(
        <BuildChatTab
          data={{
            pipelineId: running.id,
            environmentId: running.environmentId,
            taskId: running.taskId,
            isLocal: true,
          }}
        />,
      );
      const runtime = () => screen.getByLabelText("Reviewer 1 runtime and token usage");
      expect(runtime().textContent).toBe("5s · 12k tokens");
      expect(tick).toBeUndefined();

      now += 4_000;
      view.rerender(
        <BuildChatTab
          data={{
            pipelineId: running.id,
            environmentId: running.environmentId,
            taskId: running.taskId,
            isLocal: true,
          }}
          isActive
        />,
      );
      expect(runtime().textContent).toBe("9s · 12k tokens");
      now += 1_000;
      act(() => tick?.());
      expect(runtime().textContent).toBe("10s · 12k tokens");
    } finally {
      cleanup();
      Date.now = originalNow;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("marks the shown stage as selected in the graph", async () => {
    renderTab(reviewed);

    // The pipeline is followed to its current stage until the user picks one.
    expect(selectedTitle()).toBe("Verify");

    selectNode("Build");
    await waitFor(() => expect(selectedTitle()).toBe("Build"));
  });

  test("renders tool activity through the shared transcript components", () => {
    renderTab(reviewed);
    selectNode("Review");

    // The tool row, not a flattened dump of every part's text.
    expect(screen.getByText("Shell")).toBeTruthy();
    expect(screen.getByText("git diff --stat")).toBeTruthy();
    expect(screen.getByText("The review is complete")).toBeTruthy();
    expect(screen.queryByText(/"toolArgs"/) === null).toBe(true);
  });

  test("hides the package creation JSON while retaining its progress and tools", () => {
    const plan = JSON.stringify({
      headRef: "a".repeat(40),
      commands: [{ id: "test", command: "mise run test" }],
      limitations: [],
    });
    const packageSession: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      phase: "fix",
      sessionKey: "package-key",
      sdkSessionId: "package-session",
      label: REVIEW_PACKAGE_SESSION_LABEL,
      messages: [
        {
          id: "package-answer",
          role: "assistant",
          content: `I found the repository checks.\n${plan}`,
          parts: [
            { type: "text", content: "I found the repository checks." },
            {
              type: "tool-invocation",
              content: "mise tasks validate",
              toolName: "shell",
              toolState: "success",
            },
            { type: "text", content: plan },
          ],
        },
      ],
    };
    renderTab({
      ...reviewed,
      sessions: [pipeline.sessions[0]!, packageSession, reviewSession, pipeline.sessions[1]!],
      currentSessionIndex: 3,
    });

    selectNode("Prepare");

    expect(visibleTextContents()).toEqual(["I found the repository checks."]);
    expect(visibleToolInvocations()).toEqual(["mise tasks validate"]);
    expect(JSON.stringify(listProps.messages)).not.toContain('"headRef"');
    expect(screen.queryByText(plan) === null).toBe(true);
  });

  test("hides package JSON on a single-review Build Session that ran the schema", () => {
    const plan = JSON.stringify({
      headRef: "a".repeat(40),
      commands: [{ id: "test", command: "mise run test" }],
      limitations: [],
    });
    renderTab({
      ...reviewed,
      sessions: [
        {
          ...pipeline.sessions[0]!,
          structuredRequestId: "prep-request",
          structuredResultStatus: "accepted",
          messages: [
            {
              id: "build-answer",
              role: "assistant",
              content: `I found the repository checks.\n${plan}`,
              parts: [
                { type: "text", content: "I found the repository checks." },
                {
                  type: "tool-invocation",
                  content: "mise tasks validate",
                  toolName: "shell",
                  toolState: "success",
                },
                { type: "text", content: plan },
              ],
            },
          ],
        },
        reviewSession,
        pipeline.sessions[1]!,
      ],
      currentSessionIndex: 2,
    });

    selectNode("Build");

    expect(visibleTextContents()).toEqual(["I found the repository checks."]);
    expect(visibleToolInvocations()).toEqual(["mise tasks validate"]);
    expect(JSON.stringify(listProps.messages)).not.toContain('"headRef"');
    expect(screen.queryByText(plan) === null).toBe(true);
  });

  test("hides package JSON on a legacy reused Fix Session", () => {
    const plan = JSON.stringify({
      headRef: "a".repeat(40),
      commands: [{ id: "test", command: "mise run test" }],
      limitations: [],
    });
    renderTab({
      ...reviewed,
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[0]!,
          phase: "fix",
          sessionKey: "legacy-fix-key",
          sdkSessionId: "legacy-fix-session",
          label: "Fix Session",
          structuredRequestId: "legacy-prep",
          structuredResultStatus: "accepted",
          messages: [
            {
              id: "fix-answer",
              role: "assistant",
              content: `I found the repository checks.\n${plan}`,
              parts: [
                { type: "text", content: "I found the repository checks." },
                {
                  type: "tool-invocation",
                  content: "mise tasks validate",
                  toolName: "shell",
                  toolState: "success",
                },
                { type: "text", content: plan },
              ],
            },
          ],
        },
        reviewSession,
        pipeline.sessions[1]!,
      ],
      currentSessionIndex: 3,
    });

    selectNode("Fix");

    expect(visibleTextContents()).toEqual(["I found the repository checks."]);
    expect(visibleToolInvocations()).toEqual(["mise tasks validate"]);
    expect(JSON.stringify(listProps.messages)).not.toContain('"headRef"');
    expect(screen.queryByText(plan) === null).toBe(true);
  });

  test("hides a same-line commands-first or limitations-first package plan", () => {
    const commandsFirst = JSON.stringify({
      commands: [{ id: "test", command: "mise run test" }],
      headRef: "a".repeat(40),
      limitations: [],
    });
    const limitationsFirst = JSON.stringify({
      limitations: ["host capacity"],
      headRef: "a".repeat(40),
      commands: [{ id: "test", command: "mise run test" }],
    });
    renderTab({
      ...reviewed,
      sessions: [
        {
          ...pipeline.sessions[0]!,
          producedReviewPackagePlan: true,
          messages: [
            {
              id: "commands-first",
              role: "assistant",
              content: `Prepared validation. ${commandsFirst}`,
              parts: [{ type: "text", content: `Prepared validation. ${commandsFirst}` }],
            },
            {
              id: "limitations-first",
              role: "assistant",
              content: `Prepared validation. ${limitationsFirst}`,
              parts: [{ type: "text", content: `Prepared validation. ${limitationsFirst}` }],
            },
          ],
        },
        reviewSession,
        pipeline.sessions[1]!,
      ],
      currentSessionIndex: 2,
    });

    selectNode("Build");

    expect(visibleTextContents()).toEqual(["Prepared validation.", "Prepared validation."]);
    expect(JSON.stringify(listProps.messages)).not.toContain('"headRef"');
    expect(JSON.stringify(listProps.messages)).not.toContain('"commands"');
  });

  test("keeps earlier implementation JSON on a reused Build Session", () => {
    const config = '```json\n{"strict":true,"retries":3}\n```';
    const plan = JSON.stringify({
      headRef: "a".repeat(40),
      commands: [{ id: "test", command: "mise run test" }],
      limitations: [],
    });
    renderTab({
      ...reviewed,
      sessions: [
        {
          ...pipeline.sessions[0]!,
          producedReviewPackagePlan: true,
          structuredRequestId: "prep-request",
          structuredResultStatus: "accepted",
          messages: [
            {
              id: "impl",
              role: "assistant",
              content: config,
              parts: [{ type: "text", content: config }],
            },
            {
              id: "plan",
              role: "assistant",
              content: `I found the repository checks.\n${plan}`,
              parts: [
                { type: "text", content: "I found the repository checks." },
                { type: "text", content: plan },
              ],
            },
          ],
        },
        reviewSession,
        pipeline.sessions[1]!,
      ],
      currentSessionIndex: 2,
    });

    selectNode("Build");

    expect(visibleTextContents()).toEqual([config, "I found the repository checks."]);
    expect(JSON.stringify(listProps.messages)).toContain("strict");
    expect(JSON.stringify(listProps.messages)).not.toContain('"headRef"');
  });

  test("still hides package JSON after structured request markers are cleared", () => {
    const plan = JSON.stringify({
      headRef: "a".repeat(40),
      commands: [{ id: "test", command: "mise run test" }],
      limitations: [],
    });
    renderTab({
      ...reviewed,
      sessions: [
        {
          ...pipeline.sessions[0]!,
          messages: [
            {
              id: "build-answer",
              role: "assistant",
              content: `I found the repository checks.\n${plan}`,
              parts: [
                { type: "text", content: "I found the repository checks." },
                { type: "text", content: plan },
              ],
            },
          ],
        },
        reviewSession,
        pipeline.sessions[1]!,
      ],
      currentSessionIndex: 2,
    });

    selectNode("Build");

    expect(visibleTextContents()).toEqual(["I found the repository checks."]);
    expect(JSON.stringify(listProps.messages)).not.toContain('"headRef"');
  });

  test("keeps a resumed fan-out build transcript visible", () => {
    const config = '```json\n{"strict":true,"retries":3}\n```';
    renderTab({
      ...reviewed,
      reviewers: [{ agent: "codex" }, { agent: "claude" }],
      sessions: [
        {
          ...pipeline.sessions[0]!,
          structuredRequestId: "resume-1",
          structuredResultStatus: "pending",
          messages: [
            {
              id: "impl",
              role: "assistant",
              content: config,
              parts: [{ type: "text", content: config }],
            },
          ],
        },
        reviewSession,
        pipeline.sessions[1]!,
      ],
      currentSessionIndex: 2,
    });

    selectNode("Build");

    expect(visibleTextContents()).toEqual([config]);
    expect(JSON.stringify(listProps.messages)).toContain("strict");
  });

  test("keeps the transcript list mounted when visiting the tests and returning", () => {
    // The stub records prop identity only. Real react-virtuoso scroll
    // retention across a display:none toggle belongs to the Playwright
    // component suite; happy-dom never mounts Virtuoso rows.
    renderTab({
      ...reviewed,
      validationRun: validationRun({ id: "validation-scroll" }),
      currentSessionIndex: 2,
    });

    selectNode("Build");
    const before = JSON.stringify(listProps.messages);
    expect(before).toContain("Implementation complete");

    selectNode("Prepare");
    expect(screen.getByLabelText("Review validation")).toBeTruthy();
    expect(JSON.stringify(listProps.messages)).toBe(before);

    selectNode("Build");
    expect(screen.queryByLabelText("Review validation") === null).toBe(true);
    expect(JSON.stringify(listProps.messages)).toBe(before);
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });

  test.each(Array.from(BUILD_PIPELINE_AGENTS))(
    "shows the shared thinking footer for a running %s stage",
    (agent) => {
      const label = nativeAgentAdapters[agent].label;
      renderTab({
        ...pipeline,
        agentType: agent,
        phase: "building",
        sessions: [
          {
            ...pipeline.sessions[0]!,
            agent,
            status: "running",
          },
        ],
        currentSessionIndex: 0,
        backendRevision: 39 + label.length,
      });

      const indicator = screen.getByRole("status");
      expect(indicator.textContent).toBe(`${label} is thinking...`);
      expect(indicator.classList.contains("agent-thinking-shimmer")).toBe(true);
      expect(indicator.closest(".chat-status-row")).toBeTruthy();
    },
  );

  test("does not show a thinking footer for the idle stage a user is reading", async () => {
    renderTab({
      ...pipeline,
      phase: "verifying",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          status: "running",
        },
      ],
      backendRevision: 47,
    });
    expect(screen.getByText("Codex is thinking...")).toBeTruthy();

    selectNode("Build");

    await waitFor(() => expect(screen.queryByText(/is thinking\.\.\./) === null).toBe(true));
  });

  test.each(["failed", "paused"] as const)(
    "does not show a thinking footer when the pipeline is %s with a stale running session",
    (phase) => {
      renderTab({
        ...pipeline,
        phase,
        sessions: [
          {
            ...pipeline.sessions[0]!,
            status: "running",
          },
        ],
        currentSessionIndex: 0,
        backendRevision: 51,
      });

      expect(screen.queryByRole("status") === null).toBe(true);
      expect(screen.queryByText(/is thinking\.\.\./) === null).toBe(true);
    },
  );

  test("stacks the thinking footer under a structured review report while that stage is running", () => {
    renderTab({
      ...reviewed,
      phase: "reviewing",
      currentSessionIndex: 1,
      sessions: [
        reviewed.sessions[0]!,
        {
          ...reviewSession,
          status: "running",
        },
        reviewed.sessions[2]!,
      ],
      backendRevision: 52,
    });

    expect(screen.getByLabelText("Structured review report")).toBeTruthy();
    const indicator = screen.getByRole("status");
    expect(indicator.textContent).toBe("Codex is thinking...");
    expect(indicator.classList.contains("agent-thinking-shimmer")).toBe(true);
    expect(indicator.closest(".chat-status-row")).toBeTruthy();
  });

  test("shows the structured review report only on the stage that produced it", async () => {
    renderTab(reviewed);
    const reportLabel = "Structured review report";

    // The pipeline is following its verification stage, which did not review.
    expect(screen.queryByLabelText(reportLabel) === null).toBe(true);

    selectNode("Review");
    await waitFor(() => expect(screen.getByLabelText(reportLabel)).toBeTruthy());

    selectNode("Build");
    await waitFor(() => expect(screen.queryByLabelText(reportLabel) === null).toBe(true));
  });

  test("shows every multi-model reviewer report and the consolidated report in its transcript", async () => {
    const reviewerOneReport = {
      ...TEST_STRUCTURED_REVIEW_REPORT,
      reviewSummary: "Reviewer one found the dispatch race.",
    };
    const reviewerTwoReport = {
      ...TEST_STRUCTURED_REVIEW_REPORT,
      reviewSummary: "Reviewer two found the recovery gap.",
    };
    const consolidationReport = {
      ...TEST_STRUCTURED_REVIEW_REPORT,
      reviewSummary: "The consolidation retained both findings.",
    };
    const reviewerOnePayload = JSON.stringify(reviewerOneReport);
    const reviewSessions: BuildPipeline["sessions"] = [
      {
        ...reviewSession,
        sessionKey: "review-1-key",
        sdkSessionId: "review-1-session",
        label: "Review 1",
        reviewReport: reviewerOneReport,
        messages: [
          {
            id: "review-1-answer",
            role: "assistant",
            content: reviewerOnePayload,
            parts: [
              { type: "text", content: reviewerOnePayload },
              {
                type: "tool-invocation",
                content: "git diff --stat",
                toolName: "shell",
                toolState: "success",
              },
            ],
          },
        ],
      },
      {
        ...reviewSession,
        sessionKey: "review-2-key",
        sdkSessionId: "review-2-session",
        label: "Review 2",
        reviewReport: reviewerTwoReport,
      },
      {
        ...reviewSession,
        sessionKey: "consolidation-key",
        sdkSessionId: "consolidation-session",
        label: "Consolidation",
        structuredRequestId: "consolidation-request",
        reviewReport: consolidationReport,
      },
    ];
    renderTab({
      ...reviewed,
      reviewers: [{ agent: "codex" }, { agent: "claude" }],
      sessions: [pipeline.sessions[0]!, ...reviewSessions, pipeline.sessions[1]!],
      currentSessionIndex: 4,
      structuredReview: consolidationReport,
      structuredReviewRequestId: "consolidation-request",
    });

    fireEvent.click(graphNode("Reviewer 1"));
    expect(await screen.findByLabelText("Reviewer report")).toBeTruthy();
    expect(visibleTextContents()).not.toContain(reviewerOnePayload);
    expect(visibleToolInvocations()).toEqual(["git diff --stat"]);
    fireEvent.click(screen.getByRole("button", { name: "Review summary" }));
    expect(screen.getByText("Reviewer one found the dispatch race.")).toBeTruthy();

    fireEvent.click(graphNode("Reviewer 2"));
    expect(await screen.findByLabelText("Reviewer report")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review summary" }));
    expect(screen.getByText("Reviewer two found the recovery gap.")).toBeTruthy();

    selectNode("Consolidation");
    expect(await screen.findByLabelText("Consolidated Multi Review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review summary" }));
    expect(screen.getByText("The consolidation retained both findings.")).toBeTruthy();
  });

  test("shows live fan-out reports but hides discarded session reports after a retry", async () => {
    const reviewerReport = {
      ...TEST_STRUCTURED_REVIEW_REPORT,
      reviewSummary: "This report belongs to the abandoned panel.",
    };
    const reviewer = {
      ...reviewSession,
      sessionKey: "retained-review-key",
      sdkSessionId: "retained-review-session",
      label: "Retained Review",
      reviewReport: reviewerReport,
    };
    const base = {
      ...reviewed,
      reviewers: [{ agent: "codex" as const }, { agent: "claude" as const }],
      sessions: [pipeline.sessions[0]!, reviewer, pipeline.sessions[1]!],
      currentSessionIndex: 2,
      structuredReview: undefined,
      structuredReviewRequestId: undefined,
    };

    renderTab({
      ...base,
      reviewFanout: {
        reviewers: [
          {
            id: "reviewer-1",
            agent: "codex",
            model: "gpt-5",
            status: "completed",
          },
          {
            id: "reviewer-2",
            agent: "claude",
            model: "opus",
            status: "running",
          },
        ],
      },
    });
    selectNode("Review");
    expect(await screen.findByLabelText("Reviewer report")).toBeTruthy();
    expect(graphNode("Review").getAttribute("aria-label")).toMatch(/\d+ issues?$/);

    cleanup();
    renderTab(base);
    selectNode("Review");
    expect(screen.queryByLabelText("Reviewer report") === null).toBe(true);
    expect(screen.queryByLabelText("Consolidated Multi Review") === null).toBe(true);
  });

  test("hides provisional transcript reports and shows the authoritative report once", async () => {
    const provisional = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      issues: [],
      testCoverageGaps: [],
      verdict: {
        ready: "no",
        reasoning: "Review work is still in progress.",
      },
    });
    const final = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    renderTab({
      ...reviewed,
      sessions: reviewed.sessions.map((session) =>
        session.phase === "review"
          ? {
              ...session,
              messages: [
                {
                  id: "review-answer",
                  role: "assistant",
                  content: final,
                  parts: [
                    { type: "text", content: provisional },
                    {
                      type: "tool-invocation",
                      content: "git diff --stat",
                      toolName: "shell",
                      toolState: "success",
                    },
                    { type: "text", content: final },
                  ],
                },
              ],
            }
          : session,
      ),
    });

    selectNode("Review");
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());

    expect(screen.getAllByText("Structured review report")).toHaveLength(1);
    expect(screen.queryByText(/Ready: no/) === null).toBe(true);
    expect(visibleToolInvocations()).toEqual(["git diff --stat"]);
    // Both the provisional and the final payload are schema-shaped text, so the
    // transcript keeps only the tool activity between them.
    expect(visibleTextContents()).toEqual([]);
  });

  test("withholds a half-written report draft and keeps the reviewer's prose", async () => {
    // What a provider that answers a schema-constrained turn in the text
    // channel actually streams: prose progress, then longer and longer drafts
    // of the report. A draft validates as nothing, so no payload filter claims
    // it, and it would otherwise render as a wall of raw JSON. The review
    // prompt tells the agent this withholding happens.
    const draft = '{"reviewScope":{"targetBranch":"main","filesReviewed":["a.ts"';
    const fencedDraft = '```json\n{"issues":[{"severity":"P1",\n```';
    renderTab({
      ...reviewed,
      sessions: reviewed.sessions.map((session) =>
        session.phase === "review"
          ? {
              ...session,
              messages: [
                {
                  id: "review-answer",
                  role: "assistant",
                  content: draft,
                  parts: [
                    { type: "text", content: "Inspecting the changed files." },
                    { type: "text", content: draft },
                    {
                      type: "tool-invocation",
                      content: "git diff --stat",
                      toolName: "shell",
                      toolState: "success",
                    },
                    { type: "text", content: fencedDraft },
                    {
                      type: "text",
                      content: 'The config `{"strict":true}` is already covered.',
                    },
                  ],
                },
              ],
            }
          : session,
      ),
    });

    selectNode("Review");
    await waitFor(() => expect(screen.getByText("Inspecting the changed files.")).toBeTruthy());

    expect(visibleTextContents()).toEqual([
      "Inspecting the changed files.",
      'The config `{"strict":true}` is already covered.',
    ]);
    expect(visibleToolInvocations()).toEqual(["git diff --stat"]);
    expect(screen.queryByText(/filesReviewed/) === null).toBe(true);
  });
});
