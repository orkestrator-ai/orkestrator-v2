import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { PipelineReviewTab } from "./PipelineReviewTab";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";
import { formatObservedAt } from "@/lib/view-freshness";
import {
  CREATED,
  build,
  session,
  sessionlessReviewerRetry,
  validationRun,
} from "./pipeline-test-fixture";
import {
  BuildChatTab,
  graphNode,
  inspector,
  renderPipelineTab,
  retryReviewerMock,
  restoreBuildChatTabMocks,
  selectNode,
} from "./build-chat-tab-test-support";

afterAll(restoreBuildChatTabMocks);
afterEach(() => {
  cleanup();
  useFlowGraphViewStore.setState({ views: new Map(), collapsed: new Set() });
});

const reviewing = () =>
  build({
    phase: "reviewing",
    reviewers: [
      { agent: "claude", model: "opus" },
      { agent: "codex", model: "gpt" },
    ],
    reviewFanout: {
      reviewers: [
        { id: "r1", agent: "claude", model: "opus", status: "failed", error: "Failed" },
        { id: "r2", agent: "codex", model: "gpt", status: "running" },
      ],
    },
  });

describe("pipeline inspector controls", () => {
  test("a second sessionless failure exposes retry after superseded consolidation", async () => {
    const pipeline = sessionlessReviewerRetry("failed");
    retryReviewerMock.mockClear();
    renderPipelineTab(pipeline);
    selectNode("Reviewer 1");
    expect(screen.getByTestId("pipeline-inspector-status").textContent).toBe("Failed");
    expect(graphNode("Reviewer 1").textContent).toContain("Retry creation failed");
    const retry = within(inspector()).getByRole("button", { name: "Retry reviewer" });
    expect(retry.hasAttribute("disabled")).toBe(false);
    fireEvent.contextMenu(graphNode("Reviewer 1"));
    expect(screen.getByRole("menuitem", { name: "Retry reviewer" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(retry);
    await waitFor(() => expect(retryReviewerMock).toHaveBeenCalledWith(pipeline.id, "retry"));
  });

  for (const dedicated of [true, false]) {
    test.each(["failed", "incomplete"] as const)(
      `${dedicated ? "dedicated" : "synthetic"} Prepare inspector reflects %s validation commands`,
      (status) => {
        const run = validationRun();
        run.results[0] = { ...run.results[0]!, status, exitCode: status === "failed" ? 1 : null };
        renderPipelineTab(
          build({
            phase: "reviewing",
            sessions: [
              session("build", "work", 0),
              ...(dedicated
                ? [session("fix", "prep", 60, { label: "Package Preparation Session" })]
                : []),
            ],
            validationRun: run,
          }),
        );
        selectNode("Prepare");
        expect(graphNode("Prepare").getAttribute("data-flow-state")).toBe("failed");
        expect(screen.getByTestId("pipeline-inspector-status").textContent).toBe("Failed");
      },
    );
  }

  test("only the focused active view publishes its session, including reactivation", () => {
    const pipeline = build({
      phase: "reviewing",
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "codex", model: "gpt" },
      ],
      sessions: [
        session("build", "build", 0),
        session("review", "reviewer", 60, {
          label: "Review 1",
          reviewPassId: "pass",
          status: "running",
        }),
      ],
      currentSessionIndex: 1,
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      viewedSessionIds: new Map(),
    });
    const Views = ({
      active,
      focused = active,
    }: {
      active: "build" | "review";
      focused?: "build" | "review";
    }) => (
      <>
        <section aria-label="Build view">
          <BuildChatTab
            data={{
              pipelineId: pipeline.id,
              environmentId: pipeline.environmentId,
              taskId: pipeline.taskId,
              isLocal: true,
            }}
            isActive={active === "build"}
            ownsGlobalShortcuts={focused === "build"}
          />
        </section>
        <section aria-label="Review view">
          <PipelineReviewTab
            pipelineId={pipeline.id}
            environmentId={pipeline.environmentId}
            passKey="review-pass-1"
            isActive={active === "review"}
            ownsGlobalShortcuts={focused === "review"}
          />
        </section>
      </>
    );
    const { rerender } = render(<Views active="build" />);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Build view" })).getByRole("tab", {
        name: /^Build,/,
      }),
    );
    expect(useBuildPipelineStore.getState().viewedSessionIds.get(pipeline.id)).toBe(
      "build-session",
    );
    // Hidden review follows progress but must not overwrite the visible selection.
    act(() =>
      useBuildPipelineStore.getState().replacePipeline({
        ...pipeline,
        backendRevision: 2,
        sessions: [
          ...pipeline.sessions.map((entry) =>
            entry.phase === "review"
              ? { ...entry, status: "idle" as const, reviewerOutcome: "completed" as const }
              : entry,
          ),
          session("review", "consolidation", 120, {
            label: "Consolidation",
            reviewPassId: "pass",
            status: "running",
          }),
        ],
        currentSessionIndex: 2,
      }),
    );
    expect(useBuildPipelineStore.getState().viewedSessionIds.get(pipeline.id)).toBe(
      "build-session",
    );
    rerender(<Views active="review" />);
    expect(useBuildPipelineStore.getState().viewedSessionIds.get(pipeline.id)).toBe(
      "consolidation-session",
    );
    rerender(<Views active="build" />);
    expect(useBuildPipelineStore.getState().viewedSessionIds.get(pipeline.id)).toBe(
      "build-session",
    );
  });

  test.each(["pending", "running"] as const)(
    "follows a %s reviewer retry instead of discarded consolidation",
    (status) => {
      const pipeline = reviewing();
      pipeline.reviewFanout!.reviewers[0] = { id: "r1", agent: "claude", model: "opus", status };
      pipeline.reviewFanout!.reviewers[1]!.status = "completed";
      pipeline.sessions = [
        session("review", "failed", 60, {
          label: "Review 1",
          reviewPassId: "r1",
          reviewerOutcome: "failed",
        }),
        session("review", "completed", 60, {
          label: "Review 2",
          reviewPassId: "r1",
          reviewerOutcome: "completed",
        }),
        session("review", "discarded", 120, {
          label: "Consolidation",
          reviewPassId: "r1",
          superseded: true,
        }),
      ];
      pipeline.reviewFanout!.reviewers[1]!.sessionKey = "completed";
      renderPipelineTab(pipeline);
      expect(graphNode("Reviewer 1").getAttribute("aria-selected")).toBe("true");
      expect(graphNode("Consolidation").getAttribute("data-flow-state")).toBe("cancelled");
    },
  );

  test("collapsed inspector retains an accessible name", () => {
    renderPipelineTab(reviewing());
    expect(screen.getByRole("tabpanel", { name: /^Reviewer 2,/ })).toBe(inspector());
    fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
    expect(screen.getByRole("tabpanel", { name: "Reviewer 2" })).toBe(inspector());
  });

  test.each(["cancelled", "interactive-request", "consolidated", "other-stage"])(
    "does not offer reviewer retry for %s",
    (reason) => {
      const pipeline = reviewing();
      if (reason === "cancelled") {
        pipeline.phase = "failed";
        pipeline.error = "Build cancelled by user";
      } else if (reason === "interactive-request") {
        pipeline.phase = "failed";
        pipeline.failureContext = { phase: "reviewing", kind: "interactive-request" };
      } else if (reason === "other-stage") {
        pipeline.phase = "failed";
        pipeline.failureContext = { phase: "verifying", kind: "stage-transition" };
      } else {
        pipeline.reviewFanout!.report = TEST_STRUCTURED_REVIEW_REPORT;
      }
      renderPipelineTab(pipeline);
      selectNode("Reviewer 1");
      expect(within(inspector()).queryByRole("button", { name: "Retry reviewer" }) === null).toBe(
        true,
      );
      fireEvent.contextMenu(graphNode("Reviewer 1"));
      expect(screen.queryByRole("menuitem", { name: "Retry reviewer" }) === null).toBe(true);
    },
  );

  test.each(["reviewing", "paused", "failed"] as const)(
    "offers retry for a failed reviewer in %s review",
    (phase) => {
      const pipeline = reviewing();
      pipeline.phase = phase;
      if (phase === "paused") pipeline.pausedFromPhase = "reviewing";
      if (phase === "failed")
        pipeline.failureContext = { phase: "reviewing", kind: "stage-transition" };
      renderPipelineTab(pipeline);
      selectNode("Reviewer 1");
      expect(
        within(inspector())
          .getByRole("button", { name: "Retry reviewer" })
          .hasAttribute("disabled"),
      ).toBe(false);
    },
  );

  test.each(["verifying", "creating-pr"] as const)(
    "a %s startup failure remains visible and retryable after a reviewer failure",
    (phase) => {
      renderPipelineTab(
        build({
          phase: "failed",
          error: "Could not launch the next stage",
          failureContext: { phase, kind: "stage-transition" },
          reviewers: reviewing().reviewers,
          sessions: [
            session("build", "build", 0),
            session("review", "rev-1", 60, {
              label: "Review 1",
              reviewerOutcome: "failed",
              error: "Historical reviewer failure",
            }),
            session("review", "rev-2", 60, { label: "Review 2", reviewerOutcome: "completed" }),
            session("review", "consolidation", 120, { label: "Consolidation" }),
            ...(phase === "creating-pr" ? [session("verify", "verify", 180)] : []),
          ],
        }),
      );
      selectNode(phase === "verifying" ? "Verify" : "Ship");
      expect(screen.getByTestId("pipeline-inspector-status").textContent).toBe("Failed");
      expect(graphNode(phase === "verifying" ? "Verify" : "Ship").textContent).toContain(
        "Could not launch the next stage",
      );
      expect(
        within(inspector())
          .getByRole("button", { name: "Retry failed step" })
          .hasAttribute("disabled"),
      ).toBe(false);
    },
  );

  test("validation keeps Prepare running until terminal evidence arrives", () => {
    const pipeline = build({
      phase: "reviewing",
      sessions: [
        session("build", "build", 0),
        session("fix", "prep", 60, { label: "Package Preparation Session" }),
      ],
      validationRun: validationRun({ status: "running", completedAt: undefined }),
    });
    renderPipelineTab(pipeline, { isActive: true });
    selectNode("Prepare");
    expect(screen.getByTestId("pipeline-inspector-status").textContent).toBe("Running");
    act(() =>
      useBuildPipelineStore.setState({
        pipelines: new Map([[pipeline.id, { ...pipeline, validationRun: validationRun() }]]),
      }),
    );
    expect(screen.getByTestId("pipeline-inspector-status").textContent).toBe("Complete");
  });
});

describe("pipeline zoom controls", () => {
  const largePanel = () => {
    const reviewers = Array.from({ length: 16 }, (_, index) => ({
      id: `r${index + 1}`,
      agent: "claude" as const,
      model: "opus",
      status: "running" as const,
    }));
    return build({
      phase: "reviewing",
      reviewers: reviewers.map(({ agent, model }) => ({ agent, model })),
      reviewFanout: { reviewers },
    });
  };

  test("offer Fit, which zooms the whole graph into view and back from 100%", () => {
    renderPipelineTab(largePanel());
    const controls = screen.getByRole("group", { name: "Zoom" });
    const level = screen.getByTestId("pipeline-zoom-level");
    expect(level.textContent).toBe("100%");
    fireEvent.click(within(controls).getByRole("button", { name: "Fit the whole pipeline" }));
    const fitted = Number.parseInt(level.textContent!, 10);
    expect(fitted).toBeLessThan(100);
    expect(fitted).toBeGreaterThanOrEqual(20);
    fireEvent.click(level);
    expect(level.textContent).toBe("100%");
  });
});

describe("failed node faces", () => {
  const error =
    '\n  Reviewer exited with code 1\nTraceback (most recent call last):\n  File "review.py", line 4';

  test("show only the error's first line and keep the whole text as the description", () => {
    const pipeline = reviewing();
    pipeline.reviewFanout!.reviewers[0]!.error = error;
    renderPipelineTab(pipeline);
    const node = graphNode("Reviewer 1");
    expect(node.getAttribute("data-flow-state")).toBe("failed");
    const face = node.querySelector<HTMLElement>("[data-flow-node-error]")!;
    expect(face.textContent).toBe("Reviewer exited with code 1");
    expect(face.className).toContain("truncate");
    expect(face.getAttribute("aria-hidden")).toBe("true");
    const description = document.getElementById(node.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toBe(error);
    expect(description.className).toContain("sr-only");
  });

  test("open the whole error in the tooltip", async () => {
    const pipeline = reviewing();
    pipeline.reviewFanout!.reviewers[0]!.error = error;
    renderPipelineTab(pipeline);
    const node = graphNode("Reviewer 1");
    fireEvent.click(node);
    act(() => node.focus());
    const tooltip = await screen.findByTestId("pipeline-node-error-tooltip");
    expect(tooltip.textContent).toContain("Reviewer exited with code 1");
    expect(tooltip.textContent).toContain('File "review.py", line 4');
  });
});

describe("node face rows", () => {
  const rows = (node: HTMLElement) =>
    [...node.querySelectorAll<HTMLElement>("[data-flow-node-row]")].map((row) => [
      row.getAttribute("data-flow-node-row"),
      row.textContent,
    ]);
  const running = (overrides: Partial<Parameters<typeof session>[3]> = {}) =>
    build({
      phase: "building",
      agentType: "claude",
      sessions: [
        session("build", "build", 0, {
          status: "running",
          completedAt: undefined,
          agent: "claude",
          model: "opus",
          reasoningEffort: "high",
          ...overrides,
        }),
      ],
    });

  test("a running node puts its title, model and clock on three rows", () => {
    const now = Date.parse("2026-07-29T00:02:35.000Z");
    const dateNow = Date.now;
    Date.now = () => now;
    try {
      renderPipelineTab(running({ tokenCount: 48_200 }));
      const node = graphNode("Build");
      expect(rows(node)).toEqual([
        ["title", "Build"],
        ["detail", "claude · opus · high"],
        ["runtime", "2m 35s · 48k tokensrunning"],
      ]);
      // The title is never squeezed by the clock: it shares its row with nothing.
      const title = node.querySelector<HTMLElement>("[data-flow-node-title]")!;
      expect(title.className).toContain("shrink-0");
      // Only the subtitle truncates, with its whole text in the tooltip.
      const detail = node.querySelector<HTMLElement>("[data-flow-node-detail]")!;
      expect(detail.className).toContain("truncate");
      expect(detail.title).toBe("claude · opus · high");
      // The graph gives the taller face its own height, so its edges meet its centre.
      expect(node.style.height).toBe("82px");
    } finally {
      Date.now = dateNow;
    }
  });

  test("a running node whose provider has not reported usage shows a dash", () => {
    const now = Date.parse("2026-07-29T00:00:10.000Z");
    const dateNow = Date.now;
    Date.now = () => now;
    try {
      renderPipelineTab(running());
      const node = graphNode("Build");
      expect(screen.getByLabelText("Build runtime and token usage").textContent).toBe("10s · —");
      expect(node.textContent).not.toContain("Tokens pending");
      expect(node.getAttribute("aria-label")).toBe("Build, Running, 10s");
      selectNode("Build");
      expect(inspector().textContent).not.toContain("Tokens pending");
    } finally {
      Date.now = dateNow;
    }
  });

  test("every step that ran has its clock on the third row, the ticket its start", () => {
    renderPipelineTab(
      build({
        phase: "verifying",
        agentType: "claude",
        currentSessionIndex: 1,
        sessions: [
          // Recorded before stage sessions kept their end time.
          session("build", "build", 0, { completedAt: undefined }),
          session("verify", "verify", 3_420, { status: "running", completedAt: undefined }),
        ],
      }),
    );
    const runtimeRow = (title: string) =>
      graphNode(title).querySelector<HTMLElement>('[data-flow-node-row="runtime"]')?.textContent;
    const started = formatObservedAt(CREATED)!;
    const ticket = graphNode("Ticket");
    expect(runtimeRow("Ticket")).toBeUndefined();
    const startRow = ticket.querySelector('[data-flow-node-row="start"]');
    expect(startRow?.tagName).toBe("TIME");
    expect(startRow?.getAttribute("datetime")).toBe(CREATED);
    expect(startRow?.textContent).toBe(`Started ${started}`);
    expect(ticket.getAttribute("aria-label")).toBe(`Ticket, Started with, Started ${started}`);
    expect(ticket.style.height).toBe("82px");
    expect(runtimeRow("Setup")).toBe("0s");
    expect(runtimeRow("Build")).toBe("57m 0s");
  });

  test.each([undefined, "not-a-date"])(
    "a ticket with invalid or missing createdAt (%s) has no start or runtime row",
    (createdAt) => {
      const pipeline = build({});
      if (createdAt === undefined) Reflect.deleteProperty(pipeline, "createdAt");
      else pipeline.createdAt = createdAt;
      renderPipelineTab(pipeline);
      const ticket = graphNode("Ticket");
      expect(ticket.querySelector('[data-flow-node-row="start"]')).toBeNull();
      expect(ticket.querySelector('[data-flow-node-row="runtime"]')).toBeNull();
      expect(ticket.getAttribute("aria-label")).toBe("Ticket, Started with");
      expect(ticket.style.height).toBe("64px");
    },
  );

  test("steps ahead keep two rows, with their badge beside the title", () => {
    renderPipelineTab(running());
    const verify = graphNode("Verify");
    expect(verify.hasAttribute("data-flow-placeholder")).toBe(true);
    expect(rows(verify)).toEqual([
      ["title", "Verifyahead"],
      ["detail", "claude · Provider default"],
    ]);
    expect(verify.style.height).toBe("64px");
    expect(rows(graphNode("PR"))).toEqual([
      ["title", "PR"],
      ["detail", "No pull request yet"],
    ]);
  });

  test.each([false, true])("renders a production-shaped idle Build (paused: %s)", (paused) => {
    renderPipelineTab(
      build({
        phase: paused ? "paused" : "reviewing",
        ...(paused ? { pausedFromPhase: "building" as const } : {}),
        agentType: "claude",
        sessions: [
          {
            phase: "build",
            iteration: 0,
            sessionKey: "build",
            sdkSessionId: "build-session",
            status: "idle",
            startedAt: "2026-07-29T00:00:00.000Z",
            label: "Build Session",
            ...(paused ? { completedAt: "2026-07-29T00:00:50.000Z" } : { tokenCount: 1_200 }),
          },
        ],
      }),
    );
    const node = graphNode("Build");
    expect(node.getAttribute("data-flow-state")).toBe(paused ? "paused" : "complete");
    expect(screen.getByLabelText("Build runtime and token usage").textContent).toBe(
      paused ? "50s" : "1.2k tokens",
    );
    expect(node.style.height).toBe("82px");
  });

  test("a finished node keeps its final runtime on the third row", () => {
    renderPipelineTab(
      build({
        phase: "reviewing",
        agentType: "claude",
        sessions: [
          session("build", "build", 0, {
            agent: "claude",
            model: "opus",
            reasoningEffort: "high",
            tokenCount: 120_000,
          }),
        ],
      }),
    );
    const node = graphNode("Build");
    expect(node.getAttribute("data-flow-state")).toBe("complete");
    expect(rows(node)).toEqual([
      ["title", "Build"],
      ["detail", "claude · opus · high"],
      ["runtime", "50s · 120k tokens"],
    ]);
    // Finishing does not change the node's height, so the graph does not jump.
    expect(node.style.height).toBe("82px");
  });
});
