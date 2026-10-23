import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  MultiReviewReviewerTranscript,
  MultiReviewStepKind,
  MultiReviewStepTranscript,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import {
  MultiReviewFindingsBadge,
  ReviewerTranscriptTail,
  StepTranscriptTail,
} from "./MultiReviewInspector";
import { reviewSeverityStyles } from "./StructuredReviewReportView";

const CREATED_AT = "2026-08-14T00:00:00.000Z";

function message(id: string, parts: NativeMessage["parts"]): NativeMessage {
  return { id, role: "assistant", content: "", parts, createdAt: CREATED_AT };
}

function transcript(
  overrides: Partial<MultiReviewReviewerTranscript> = {},
): MultiReviewReviewerTranscript {
  return {
    workflowId: "multi-1",
    reviewerId: "reviewer-1",
    workflowPhase: "reviewing",
    agent: "codex",
    model: "gpt-5.6",
    status: "running",
    transcript: "snapshot",
    sourceToken: "token-1",
    startedAt: CREATED_AT,
    messages: [
      {
        id: "row-1",
        role: "assistant",
        content: "Read",
        createdAt: CREATED_AT,
        parts: [
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
            toolArgs: { file_path: "src/review.ts" },
            toolUseId: "tool-1",
            toolState: "success",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function workflowRevision(revision: number): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [],
    fixModel: { agent: "codex", model: "gpt-5.6" },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    backendRevision: revision,
  };
}

beforeEach(() => {
  useMultiReviewStore.setState({ workflows: new Map() });
  useMessagePartExpansionStore.getState().reset();
});
afterEach(cleanup);

describe("ReviewerTranscriptTail", () => {
  test("reads the reviewer's tail and echoes its token on the next read", async () => {
    useMultiReviewStore.getState().replaceWorkflow(workflowRevision(1));
    const loadTranscript = mock(
      async (_workflowId: string, _reviewerId: string, options?: { knownSourceToken?: string }) =>
        options?.knownSourceToken === "token-1"
          ? transcript({ transcript: "unchanged", messages: [] })
          : transcript(),
    );
    render(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession
        live
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    const tail = screen.getByTestId("multi-review-transcript-tail");
    await waitFor(() => expect(tail.textContent).toContain("review.ts"));
    expect(loadTranscript.mock.calls[0]).toEqual([
      "multi-1",
      "reviewer-1",
      { knownSourceToken: undefined },
    ]);

    // A checkpoint reads again at once; an unchanged answer keeps the lines.
    act(() => useMultiReviewStore.getState().replaceWorkflow(workflowRevision(2)));
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
    expect(loadTranscript.mock.calls[1]?.[2]).toEqual({ knownSourceToken: "token-1" });
    expect(tail.textContent).toContain("review.ts");
  });

  test("renders narrative and tool calls as the chat transcript does", async () => {
    useMultiReviewStore.getState().replaceWorkflow(workflowRevision(1));
    const base = transcript();
    const loadTranscript = mock(async () =>
      transcript({
        messages: [
          ...base.messages,
          {
            id: "row-2",
            role: "assistant",
            content: "Found **one** issue.",
            createdAt: CREATED_AT,
            parts: [{ type: "text", content: "Found **one** issue." }],
          },
        ],
      }),
    );
    render(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession
        live={false}
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    const tail = screen.getByTestId("multi-review-transcript-tail");
    // Markdown renders, rather than one flattened line of text.
    expect((await within(tail).findByText("one")).tagName).toBe("STRONG");
    expect(tail.querySelector("[data-tail-kind]") === null).toBe(true);
    expect(tail.textContent).toContain("review.ts");
  });

  test("does not read a reviewer that has no session yet, or while the tab is hidden", () => {
    const loadTranscript = mock(async () => transcript());
    const view = render(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession={false}
        live
        isActive
        loadTranscript={loadTranscript}
      />,
    );
    expect(screen.getByText("The transcript appears here once this reviewer starts.")).toBeTruthy();
    view.rerender(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession
        live
        isActive={false}
        loadTranscript={loadTranscript}
      />,
    );
    expect(loadTranscript).not.toHaveBeenCalled();
  });

  test("shows a read failure in place of the tail", async () => {
    render(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession
        live={false}
        isActive
        loadTranscript={mock(async () => {
          throw new Error("Multi review reviewer not found");
        })}
      />,
    );
    expect(await screen.findByText("Multi review reviewer not found")).toBeTruthy();
  });
});

function stepTranscript(
  overrides: Partial<MultiReviewStepTranscript> = {},
): MultiReviewStepTranscript {
  return {
    workflowId: "multi-1",
    step: "consolidate",
    workflowPhase: "consolidating",
    session: "own",
    agent: "codex",
    model: "gpt-6",
    sessionStatus: "running",
    startedAt: CREATED_AT,
    transcript: "snapshot",
    sourceToken: "step-token-1",
    messages: [
      {
        id: "s1",
        role: "user",
        content: "Consolidate the reviewer reports",
        createdAt: CREATED_AT,
        parts: [{ type: "text", content: "Consolidate the reviewer reports" }],
      },
      {
        id: "s2",
        role: "assistant",
        content: "Read",
        createdAt: CREATED_AT,
        parts: [
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
            toolArgs: { file_path: "reports/reviewer-1.json" },
            toolUseId: "tool-1",
            toolState: "success",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function renderStepTail(
  loadTranscript: (
    workflowId: string,
    step: MultiReviewStepKind,
    options?: { knownSourceToken?: string },
  ) => Promise<MultiReviewStepTranscript>,
  props: Partial<Parameters<typeof StepTranscriptTail>[0]> = {},
) {
  return render(
    <StepTranscriptTail
      workflowId="multi-1"
      step="consolidate"
      access={{ kind: "own" }}
      live
      isActive
      loadTranscript={loadTranscript}
      {...props}
    />,
  );
}

describe("StepTranscriptTail", () => {
  afterEach(() => resetReadCoordinatorForTests());

  test("reads the step's tail on selection and every checkpoint, echoing its token", async () => {
    useMultiReviewStore.getState().replaceWorkflow(workflowRevision(1));
    const loadTranscript = mock(
      async (
        _workflowId: string,
        _step: MultiReviewStepKind,
        options?: { knownSourceToken?: string },
      ) =>
        options?.knownSourceToken === "step-token-1"
          ? stepTranscript({ transcript: "unchanged", messages: [] })
          : stepTranscript(),
    );
    renderStepTail(loadTranscript);

    const tail = screen.getByRole("log", { name: "Latest consolidation activity" });
    await waitFor(() => expect(tail.textContent).toContain("reviewer-1.json"));
    // The workflow's own prompt is not the step's output.
    expect(within(tail).queryByText(/Consolidate the reviewer reports/) === null).toBe(true);
    expect(loadTranscript.mock.calls[0]).toEqual([
      "multi-1",
      "consolidate",
      { knownSourceToken: undefined },
    ]);

    act(() => useMultiReviewStore.getState().replaceWorkflow(workflowRevision(2)));
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
    expect(loadTranscript.mock.calls[1]?.[2]).toEqual({ knownSourceToken: "step-token-1" });
    expect(tail.textContent).toContain("reviewer-1.json");
  });

  for (const trigger of ["completion", "reactivation"] as const) {
    test(`reads a fresh tail after ${trigger} during a pending read`, async () => {
      useMultiReviewStore.getState().replaceWorkflow(workflowRevision(1));
      let resolve!: (value: MultiReviewStepTranscript) => void;
      const pending = new Promise<MultiReviewStepTranscript>((done) => {
        resolve = done;
      });
      const final = stepTranscript({
        sourceToken: "final-token",
        messages: [message("final", [{ type: "text", content: "Consolidation finished." }])],
      });
      const loadTranscript = mock(
        async (
          _workflowId: string,
          _step: MultiReviewStepKind,
          _options?: { knownSourceToken?: string },
        ) => (loadTranscript.mock.calls.length === 1 ? pending : final),
      );
      const view = renderStepTail(loadTranscript);
      await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(1));
      const show = (isActive: boolean) =>
        view.rerender(
          <StepTranscriptTail
            workflowId="multi-1"
            step="consolidate"
            access={{ kind: "own" }}
            live={false}
            isActive={isActive}
            loadTranscript={loadTranscript}
          />,
        );
      if (trigger === "completion") {
        act(() => {
          useMultiReviewStore.getState().replaceWorkflow(workflowRevision(2));
          useMultiReviewStore.getState().replaceWorkflow(workflowRevision(3));
        });
        show(true);
      } else {
        show(false);
        show(true);
      }
      expect(loadTranscript).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolve(stepTranscript());
        await pending;
      });
      await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
      expect(loadTranscript.mock.calls[1]?.[2]).toEqual({ knownSourceToken: "step-token-1" });
      expect(await screen.findByText("Consolidation finished.")).toBeTruthy();
    });
  }

  test("polls only while the step is live, visible and its tab active", async () => {
    const { clock, document: fakeDocument } = installFakeReadCoordinator();
    const loadTranscript = mock(async () => stepTranscript());
    const view = renderStepTail(loadTranscript);
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(1));

    await act(() => clock.advance(4_000));
    expect(loadTranscript).toHaveBeenCalledTimes(2);

    // Hidden window: the coordinator stops polling.
    act(() => fakeDocument.setVisibility("hidden"));
    await act(() => clock.advance(12_000));
    const whileHidden = loadTranscript.mock.calls.length;
    await act(() => clock.advance(12_000));
    expect(loadTranscript).toHaveBeenCalledTimes(whileHidden);
    act(() => fakeDocument.setVisibility("visible"));

    // A settled step stops polling; its last checkpoint already read it.
    view.rerender(
      <StepTranscriptTail
        workflowId="multi-1"
        step="consolidate"
        access={{ kind: "own" }}
        live={false}
        isActive
        loadTranscript={loadTranscript}
      />,
    );
    await act(() => clock.advance(1));
    const settled = loadTranscript.mock.calls.length;
    await act(() => clock.advance(20_000));
    expect(loadTranscript).toHaveBeenCalledTimes(settled);

    // An inactive tab reads nothing at all.
    view.rerender(
      <StepTranscriptTail
        workflowId="multi-1"
        step="consolidate"
        access={{ kind: "own" }}
        live
        isActive={false}
        loadTranscript={loadTranscript}
      />,
    );
    await act(() => clock.advance(20_000));
    expect(loadTranscript).toHaveBeenCalledTimes(settled);
  });

  test("does not read a session another step is using, and says which", () => {
    const loadTranscript = mock(async () => stepTranscript());
    renderStepTail(loadTranscript, { access: { kind: "other-step", step: "fix" } });
    expect(
      screen.getByText(
        "This step's session is now running Fix. Open session to read the whole conversation.",
      ),
    ).toBeTruthy();
    cleanup();
    renderStepTail(loadTranscript, { step: "fix", access: { kind: "none" } });
    expect(screen.getByText("The transcript appears here once this step starts.")).toBeTruthy();
    expect(loadTranscript).not.toHaveBeenCalled();
  });

  test("shows the backend's word when the session moved on since the snapshot", async () => {
    renderStepTail(
      mock(async () => stepTranscript({ session: "other-step", sessionStep: "fix", messages: [] })),
    );
    expect(
      await screen.findByText(
        "This step's session is now running Fix. Open session to read the whole conversation.",
      ),
    ).toBeTruthy();
  });

  test("hides schema-shaped output the way a reviewer's is hidden", async () => {
    const plan = JSON.stringify({ headRef: "a".repeat(40), commands: [], limitations: [] });
    const answer = stepTranscript({
      step: "prepare",
      messages: [
        {
          id: "p1",
          role: "assistant",
          content: plan,
          createdAt: CREATED_AT,
          parts: [{ type: "text", content: "Discovering the validation commands." }],
        },
        {
          id: "p2",
          role: "assistant",
          content: plan,
          createdAt: CREATED_AT,
          parts: [{ type: "text", content: plan }],
        },
        {
          id: "p3",
          role: "assistant",
          content: "",
          createdAt: CREATED_AT,
          parts: [{ type: "text", content: '{"reviewScope": {"targetBranch": "main", "filesRev' }],
        },
      ],
    });
    renderStepTail(
      mock(async () => answer),
      { step: "prepare" },
    );
    const tail = screen.getByRole("log", { name: "Latest review package generation activity" });
    expect(await within(tail).findByText("Discovering the validation commands.")).toBeTruthy();
    expect(tail.textContent).not.toContain("headRef");
    expect(tail.textContent).not.toContain("reviewScope");
  });
});

describe("transcript tail display bounds and activity", () => {
  for (const kind of ["reviewer", "step"] as const) {
    test(`${kind} keeps only the newest 40 projected display messages`, async () => {
      // Prompts are projected out before applying the tail limit.
      const rows = Array.from({ length: 45 }, (_, index) => [
        message(`text-${index}`, [{ type: "text", content: `Visible message ${index}` }]),
        {
          ...message(`prompt-${index}`, [{ type: "text", content: `Hidden prompt ${index}` }]),
          role: "user",
        },
      ]).flat();
      if (kind === "step") renderStepTail(mock(async () => stepTranscript({ messages: rows })));
      else
        render(
          <ReviewerTranscriptTail
            workflowId="multi-1"
            reviewerId="reviewer-1"
            hasSession
            live
            isActive
            loadTranscript={mock(async () => transcript({ messages: rows }))}
          />,
        );
      expect(await screen.findByText("Visible message 44")).toBeTruthy();
      for (let index = 0; index < 5; index += 1)
        expect(screen.queryByText(`Visible message ${index}`) === null).toBe(true);
      for (let index = 5; index < 45; index += 1)
        expect(screen.getByText(`Visible message ${index}`)).toBeTruthy();
      expect(screen.queryByText(/Hidden prompt/) === null).toBe(true);
    });
  }

  for (const live of [true, false]) {
    for (const hasMessages of [true, false]) {
      test(`Working shimmer: live=${live}, messages=${hasMessages}`, async () => {
        const loadTranscript = mock(async () =>
          stepTranscript({
            messages: hasMessages
              ? [message("activity", [{ type: "text", content: "Inspecting files" }])]
              : [],
          }),
        );
        renderStepTail(loadTranscript, { live });
        await screen.findByText(
          hasMessages
            ? "Inspecting files"
            : live
              ? "Waiting for the step's first output…"
              : "No text transcript was produced for this step.",
        );
        expect(screen.queryByText("Working…") !== null).toBe(live && hasMessages);
      });
    }
  }
});

describe("deferred tail tool bodies", () => {
  for (const kind of ["reviewer", "prepare", "consolidate", "fix"] as const) {
    for (const fails of [false, true]) {
      test(`${kind} expands a summary-only Bash row and handles ${fails ? "rejection" : "output"}`, async () => {
        const detailRef = `inspector-${kind}-${fails}`;
        const rows = [
          message(`row-${detailRef}`, [
            {
              type: "tool-invocation",
              content: "Bash",
              toolName: "Bash",
              toolUseId: detailRef,
              toolArgs: { command: "pwd" },
              toolState: "success",
              detailRef,
            },
          ]),
        ];
        const loadToolDetails = mock(async (_workflowId: string, _target: string, ref: string) => {
          if (fails) throw new Error("Deferred body unavailable");
          return { detailRef: ref, toolOutput: "Deferred Bash output" };
        });
        if (kind === "reviewer")
          render(
            <ReviewerTranscriptTail
              workflowId="workflow-tools"
              reviewerId="reviewer-tools"
              hasSession
              live={false}
              isActive
              loadTranscript={mock(async () => transcript({ messages: rows }))}
              loadToolDetails={loadToolDetails}
            />,
          );
        else
          renderStepTail(
            mock(async () => stepTranscript({ messages: rows })),
            { workflowId: "workflow-tools", step: kind, live: false, loadToolDetails },
          );
        const trigger = await screen.findByRole("button", { name: /pwd/ });
        expect(loadToolDetails).not.toHaveBeenCalled();
        fireEvent.click(trigger);
        expect(
          await screen.findByText(fails ? "Deferred body unavailable" : "Deferred Bash output"),
        ).toBeTruthy();
        expect(loadToolDetails).toHaveBeenCalledWith(
          "workflow-tools",
          kind === "reviewer" ? "reviewer-tools" : kind,
          detailRef,
        );
      });
    }
  }

  test("removes a pending deferred body when the step session is handed on", async () => {
    useMultiReviewStore.getState().replaceWorkflow(workflowRevision(1));
    let resolve!: (value: { detailRef: string; toolOutput: string }) => void;
    const detailRef = "inspector-handoff";
    const loadToolDetails = mock(
      () =>
        new Promise<{ detailRef: string; toolOutput: string }>((done) => {
          resolve = done;
        }),
    );
    const loadTranscript = mock(async () =>
      loadTranscript.mock.calls.length === 1
        ? stepTranscript({
            messages: [
              message("handoff", [
                {
                  type: "tool-invocation",
                  content: "Bash",
                  toolName: "Bash",
                  toolArgs: { command: "pwd" },
                  toolState: "success",
                  detailRef,
                },
              ]),
            ],
          })
        : stepTranscript({ session: "other-step", sessionStep: "fix", messages: [] }),
    );
    renderStepTail(loadTranscript, { loadToolDetails });
    fireEvent.click(await screen.findByRole("button", { name: /pwd/ }));
    await waitFor(() => expect(loadToolDetails).toHaveBeenCalledTimes(1));
    act(() => useMultiReviewStore.getState().replaceWorkflow(workflowRevision(2)));
    await screen.findByText(/This step's session is now running Fix/);
    await act(async () => resolve({ detailRef, toolOutput: "Old session output" }));
    expect(screen.queryByText("Old session output") === null).toBe(true);
  });
});

describe("MultiReviewFindingsBadge", () => {
  test("lists each finding with its severity, location and the reviewers that raised it", () => {
    render(
      <MultiReviewFindingsBadge
        reviewerCount={2}
        findings={[
          {
            key: "a",
            severity: "P0",
            title: "Restart resets the shared clock",
            file: "src/tab.tsx",
            line: 312,
            sources: [
              { reviewerId: "r1", index: 0, agent: "claude", model: "opus", standing: "confirmed" },
              {
                reviewerId: "r2",
                index: 1,
                agent: "codex",
                model: "gpt-5.6",
                standing: "confirmed",
              },
            ],
            provisional: false,
          },
          {
            key: "b",
            severity: "P2",
            title: "Copy mismatch",
            file: "src/footer.tsx",
            line: null,
            sources: [
              {
                reviewerId: "r2",
                index: 1,
                agent: "codex",
                model: "gpt-5.6",
                standing: "confirmed",
              },
            ],
            provisional: false,
          },
        ]}
      />,
    );

    // Collapsed, it is a count per severity.
    const badge = screen.getByRole("button", { name: "Issues so far: 1 P0, 0 P1, 1 P2" });
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listitem") === null).toBe(true);
    expect(badge.textContent).toBe("P0 1P1 0P2 1");

    fireEvent.click(badge);
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("heading", { name: "Issues so far" })).toBeTruthy();
    expect(screen.getByTestId("multi-review-findings-count").textContent).toBe(
      "2 · from 2 reviewers",
    );
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first!).getByText("P0").className).toContain(reviewSeverityStyles.P0);
    expect(within(first!).getByText("src/tab.tsx:312").closest("p")!.className).toContain(
      "font-mono",
    );
    expect(within(first!).getByLabelText("Raised by Reviewer 1, Reviewer 2")).toBeTruthy();
    expect(within(first!).getByTitle("Reviewer 1 · claude · opus").className).toContain(
      "text-orange-400",
    );
    expect(within(second!).getByText("src/footer.tsx")).toBeTruthy();
  });

  test("marks rows no accepted report confirms yet", () => {
    render(
      <MultiReviewFindingsBadge
        reviewerCount={1}
        provisionalCount={2}
        findings={[
          {
            key: "live",
            severity: "P1",
            title: "Reported while running",
            file: "src/live.ts",
            line: 4,
            sources: [
              {
                reviewerId: "r2",
                index: 1,
                agent: "codex",
                model: "gpt-5.6",
                standing: "provisional",
              },
            ],
            provisional: true,
          },
          {
            key: "failed",
            severity: "P2",
            title: "Reported before a failure",
            file: "src/failed.ts",
            line: null,
            sources: [
              { reviewerId: "r3", index: 2, agent: "claude", model: "opus", standing: "failed" },
            ],
            provisional: true,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("multi-review-findings-badge"));
    expect(screen.getByTestId("multi-review-findings-count").textContent).toBe(
      "0 · from 1 reviewer · 2 provisional",
    );
    const [live, failed] = screen.getAllByRole("listitem");
    expect(within(live!).getByTestId("multi-review-finding-standing").textContent).toBe(
      "provisional",
    );
    expect(within(live!).getByLabelText("Reported provisionally by Reviewer 2")).toBeTruthy();
    expect(within(live!).getByTitle("Reviewer 2 · codex · gpt-5.6 · provisional")).toBeTruthy();
    expect(within(failed!).getByTestId("multi-review-finding-standing").textContent).toBe(
      "unconfirmed (reviewer failed)",
    );
  });

  test("explains an empty list", () => {
    const view = render(<MultiReviewFindingsBadge findings={[]} reviewerCount={0} />);
    fireEvent.click(screen.getByTestId("multi-review-findings-badge"));
    expect(screen.getByText("Issues appear here as reviewers report them.")).toBeTruthy();
    view.rerender(<MultiReviewFindingsBadge findings={[]} reviewerCount={1} />);
    expect(screen.getByTestId("multi-review-findings-count").textContent).toBe(
      "0 · from 1 reviewer",
    );
    expect(screen.getByText("The completed reviewers reported no issues.")).toBeTruthy();
  });

  test("closes on a click outside or Escape, but not on a click inside", () => {
    render(
      <div>
        <button type="button">Elsewhere</button>
        <MultiReviewFindingsBadge findings={[]} reviewerCount={1} />
      </div>,
    );
    const badge = screen.getByTestId("multi-review-findings-badge");
    fireEvent.click(badge);
    fireEvent.pointerDown(screen.getByTestId("multi-review-findings"));
    expect(screen.queryByTestId("multi-review-findings") === null).toBe(false);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByTestId("multi-review-findings") === null).toBe(true);
    expect(badge.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(badge);
    fireEvent.keyDown(badge, { key: "Escape" });
    expect(screen.queryByTestId("multi-review-findings") === null).toBe(true);
  });
});

test("badge Escape is local to an active tab and respects another pane's fullscreen", () => {
  const view = render(
    <div>
      <button data-flow-fullscreen>Other fullscreen pane</button>
      <MultiReviewFindingsBadge findings={[]} reviewerCount={0} isActive />
    </div>,
  );
  const badge = screen.getByTestId("multi-review-findings-badge");
  fireEvent.click(badge);
  const outside = screen.getByRole("button", { name: "Other fullscreen pane" });
  const escape = (target: Element) => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(target, event);
    return event.defaultPrevented;
  };
  expect(escape(outside)).toBe(false);
  expect(screen.getByTestId("multi-review-findings")).toBeTruthy();
  const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  handled.preventDefault();
  fireEvent(badge, handled);
  expect(screen.getByTestId("multi-review-findings")).toBeTruthy();
  expect(escape(badge)).toBe(true);
  expect(document.activeElement).toBe(badge);
  fireEvent.click(badge);
  view.rerender(
    <div>
      <button data-flow-fullscreen>Other fullscreen pane</button>
      <MultiReviewFindingsBadge findings={[]} reviewerCount={0} isActive={false} />
    </div>,
  );
  expect(screen.queryByTestId("multi-review-findings") === null).toBe(true);
  expect(escape(screen.getByTestId("multi-review-findings-badge"))).toBe(false);
  view.rerender(
    <div>
      <button data-flow-fullscreen>Other fullscreen pane</button>
      <MultiReviewFindingsBadge findings={[]} reviewerCount={0} isActive />
    </div>,
  );
  expect(screen.queryByTestId("multi-review-findings") === null).toBe(true);
});
