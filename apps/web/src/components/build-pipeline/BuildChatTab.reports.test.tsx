import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  REVIEW_PACKAGE_SESSION_LABEL,
  type ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { mockToastError, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import { rewoundToFirstVerify } from "./pipeline-test-fixture";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";
import {
  graph,
  graphNode,
  inspector,
  listProps,
  pipeline,
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
 * Structured results in stage transcripts, keyboard walking, banners and badges.
 */

afterAll(restoreBuildChatTabMocks);

describe("BuildChatTab reports and verdicts", () => {
  beforeEach(() => {
    cleanup();
    retryStageMock.mockClear();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
  });

  test("shows only the completed turn's final verification verdict", async () => {
    const inspecting = JSON.stringify({
      complete: false,
      rationale: "I am inspecting the committed diff.",
    });
    const testing = JSON.stringify({
      complete: false,
      rationale: "The branch is clean; I am running tests now.",
    });
    const final = JSON.stringify({
      complete: true,
      rationale: "All acceptance criteria and validation checks passed.",
    });
    renderTab({
      ...pipeline,
      verificationResult: "pass",
      verificationFeedback: "All acceptance criteria and validation checks passed.",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          agent: "codex",
          structuredResultStatus: "accepted",
          messages: [
            {
              id: "verification-answer",
              role: "assistant",
              content: final,
              parts: [
                { type: "text", content: inspecting },
                {
                  type: "tool-invocation",
                  content: "bun test",
                  toolName: "bash",
                  toolState: "success",
                },
                { type: "text", content: testing },
                {
                  type: "tool-invocation",
                  content: "bun run build",
                  toolName: "bash",
                  toolState: "success",
                },
                { type: "text", content: final },
              ],
            },
          ],
        },
      ],
    });

    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(screen.getAllByText("Verification passed")).toHaveLength(1);
    expect(visibleToolInvocations()).toEqual(["bun test", "bun run build"]);
  });

  test("shows only an accepted final verdict extracted from concatenated progress JSON", () => {
    const prose = "Running the full validation suite.";
    const inspecting = JSON.stringify({
      complete: false,
      rationale: "I am inspecting the committed diff.",
    });
    const testing = JSON.stringify({
      complete: false,
      rationale: "The branch is clean; I am running tests now.",
    });
    const final = JSON.stringify({
      complete: true,
      rationale: "All acceptance criteria and validation checks passed.",
    });
    const concatenated = `${inspecting}${testing}${final}`;
    renderTab({
      ...pipeline,
      verificationResult: "pass",
      verificationFeedback: "All acceptance criteria and validation checks passed.",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          agent: "codex",
          structuredResultStatus: "accepted",
          messages: [
            {
              id: "verification-answer",
              role: "assistant",
              content: `${prose}${concatenated}`,
              parts: [
                { type: "text", content: prose },
                { type: "text", content: concatenated },
              ],
            },
          ],
        },
      ],
    });

    expect(screen.getAllByText("Verification passed")).toHaveLength(1);
    expect(screen.queryByText(final) === null).toBe(true);
    expect(visibleTextContents()).toEqual([prose, final]);
    expect(JSON.stringify(listProps.messages)).not.toContain("I am inspecting the committed diff.");
    expect(JSON.stringify(listProps.messages)).not.toContain("The branch is clean");
  });

  test("does not call a provisional running verdict a verification failure", () => {
    const inspecting = JSON.stringify({
      complete: false,
      rationale: "I am inspecting the committed diff.",
    });
    renderTab({
      ...pipeline,
      phase: "verifying",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          agent: "codex",
          status: "running",
          structuredResultStatus: "pending",
          messages: [
            {
              id: "verification-answer",
              role: "assistant",
              content: inspecting,
              parts: [
                { type: "text", content: inspecting },
                {
                  type: "tool-invocation",
                  content: "bun test",
                  toolName: "bash",
                  toolState: "pending",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(visibleToolInvocations()).toEqual(["bun test"]);
    expect(visibleTextContents()).toEqual([]);
  });

  test("shows prose updates while withholding concatenated and streaming verification JSON", () => {
    const waiting = JSON.stringify({
      complete: false,
      rationale: "The full suite is still running.",
    });
    const checking = JSON.stringify({
      complete: false,
      rationale: "Four concurrent test groups remain active.",
    });
    const streaming = '{"complete":false,"rationale":"Inspecting the last test group';
    renderTab({
      ...pipeline,
      phase: "verifying",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          agent: "codex",
          status: "running",
          structuredResultStatus: "pending",
          messages: [
            {
              id: "verification-progress",
              role: "assistant",
              content: streaming,
              parts: [
                { type: "text", content: "The full suite is still running." },
                { type: "text", content: `${waiting}${checking}` },
                {
                  type: "tool-invocation",
                  content: "bun run test",
                  toolName: "bash",
                  toolState: "pending",
                },
                { type: "text", content: streaming },
              ],
            },
          ],
        },
      ],
    });

    expect(visibleTextContents()).toEqual(["The full suite is still running."]);
    expect(visibleToolInvocations()).toEqual(["bun run test"]);
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(JSON.stringify(listProps.messages)).not.toContain("Four concurrent test groups");
    expect(JSON.stringify(listProps.messages)).not.toContain("Inspecting the last test group");
  });

  test("does not reveal an idle provisional verdict after pause or cancellation", () => {
    const provisional = JSON.stringify({
      complete: false,
      rationale: "Validation has not finished yet.",
    });
    const verification = {
      ...pipeline.sessions[1]!,
      agent: "codex" as const,
      status: "idle" as const,
      structuredResultStatus: "pending" as const,
      messages: [
        {
          id: "verification-answer",
          role: "assistant",
          content: provisional,
          parts: [
            { type: "text", content: provisional },
            {
              type: "tool-invocation",
              content: "bun test",
              toolName: "bash",
              toolState: "pending",
            },
          ],
        },
      ],
    };

    renderTab({
      ...pipeline,
      phase: "paused",
      pausedFromPhase: "verifying",
      sessions: [pipeline.sessions[0]!, verification],
    });
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(visibleToolInvocations()).toEqual(["bun test"]);
    expect(visibleTextContents()).toEqual([]);

    cleanup();
    renderTab({
      ...pipeline,
      phase: "failed",
      error: "Build cancelled",
      sessions: [pipeline.sessions[0]!, verification],
    });
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(screen.getByText("Build cancelled")).toBeTruthy();
  });

  test("does not reveal a verdict while an idle session awaits structured output", () => {
    const provisional = JSON.stringify({
      complete: false,
      rationale: "The provider is still finalizing its result.",
    });
    renderTab({
      ...pipeline,
      phase: "verifying",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          status: "idle",
          structuredResultStatus: "pending",
          messages: [
            {
              id: "verification-answer",
              role: "assistant",
              content: provisional,
              parts: [{ type: "text", content: provisional }],
            },
          ],
        },
      ],
    });

    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(listProps.messages).toEqual([]);
  });

  test("keeps an accepted report visible on an older review stage", async () => {
    const provisional = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      verdict: { ready: "no", reasoning: "Still reviewing." },
    });
    const historical = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    const oldReview = {
      ...reviewSession,
      sessionKey: "old-review-key",
      sdkSessionId: "old-review-session",
      structuredRequestId: "old-review-request",
      label: "Old Review Session",
      messages: [
        {
          id: "old-review-answer",
          role: "assistant",
          content: historical,
          parts: [
            { type: "text", content: provisional },
            { type: "text", content: historical },
          ],
        },
      ],
    };
    const latestReview = {
      ...reviewSession,
      sessionKey: "latest-review-key",
      sdkSessionId: "latest-review-session",
      structuredRequestId: "latest-review-request",
      label: "Latest Review Session",
    };
    renderTab({
      ...reviewed,
      sessions: [pipeline.sessions[0]!, oldReview, latestReview, pipeline.sessions[1]!],
      currentSessionIndex: 3,
      structuredReviewRequestId: "latest-review-request",
    });

    selectNode("Review");
    await waitFor(() => expect(screen.getByText("Structured review report")).toBeTruthy());
    expect(listProps.messages[0]?.parts.map((part: { content: string }) => part.content)).toEqual([
      historical,
    ]);
    expect(screen.queryByText("Still reviewing.") === null).toBe(true);
  });

  test("reveals a legacy historical review only while the pipeline still holds its report", async () => {
    const provisional = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      verdict: { ready: "no", reasoning: "Still reviewing." },
    });
    const historical = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    // A snapshot written before `structuredResultStatus` existed: the stage is
    // idle and the pipeline has moved on, so the fallback decides from the
    // pipeline's own bookkeeping rather than provider activity.
    const legacyReview = {
      ...reviewSession,
      structuredResultStatus: undefined,
      sessionKey: "legacy-review-key",
      sdkSessionId: "legacy-review-session",
      label: "Legacy Review Session",
      messages: [
        {
          id: "legacy-review-answer",
          role: "assistant",
          content: historical,
          parts: [
            { type: "text", content: provisional },
            { type: "text", content: historical },
          ],
        },
      ],
    };
    const latestReview = {
      ...reviewSession,
      sessionKey: "latest-review-key",
      sdkSessionId: "latest-review-session",
      structuredRequestId: "latest-review-request",
      label: "Latest Review Session",
    };

    renderTab({
      ...reviewed,
      sessions: [pipeline.sessions[0]!, legacyReview, latestReview, pipeline.sessions[1]!],
      currentSessionIndex: 3,
      structuredReviewRequestId: "latest-review-request",
    });

    selectNode("Review");
    await waitFor(() => expect(screen.getByText("Structured review report")).toBeTruthy());
    expect(listProps.messages[0]?.parts.map((part: { content: string }) => part.content)).toEqual([
      historical,
    ]);
    expect(screen.queryByText("Still reviewing.") === null).toBe(true);

    cleanup();
    renderTab({
      ...reviewed,
      sessions: [pipeline.sessions[0]!, legacyReview, latestReview, pipeline.sessions[1]!],
      currentSessionIndex: 3,
      // A retry deletes the accepted report before the replacement review lands,
      // so the legacy stage's last payload was never authoritative.
      structuredReview: undefined,
      structuredReviewRequestId: undefined,
    });

    selectNode("Review");
    expect(screen.queryByText("Structured review report") === null).toBe(true);
    expect(listProps.messages).toEqual([]);
  });

  test("reveals a legacy completed verification only while the verdict is recorded", () => {
    const provisional = JSON.stringify({
      complete: false,
      rationale: "I am inspecting the committed diff.",
    });
    const final = JSON.stringify({
      complete: true,
      rationale: "All acceptance criteria and validation checks passed.",
    });
    const legacyVerify = {
      ...pipeline.sessions[1]!,
      agent: "codex" as const,
      structuredResultStatus: undefined,
      messages: [
        {
          id: "verification-answer",
          role: "assistant",
          content: final,
          parts: [
            { type: "text", content: provisional },
            {
              type: "tool-invocation",
              content: "bun test",
              toolName: "bash",
              toolState: "success",
            },
            { type: "text", content: final },
          ],
        },
      ],
    };
    const prSession = {
      phase: "pr" as const,
      iteration: 0,
      sessionKey: "pr-key",
      sdkSessionId: "pr-session",
      status: "idle" as const,
      startedAt: "2026-07-29T00:03:00.000Z",
      label: "PR Session",
      messages: [],
    };

    renderTab({
      ...pipeline,
      verificationResult: "pass",
      verificationFeedback: "All acceptance criteria and validation checks passed.",
      currentSessionIndex: 2,
      sessions: [pipeline.sessions[0]!, legacyVerify, prSession],
    });
    selectNode("Verify");
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(screen.getAllByText("Verification passed")).toHaveLength(1);
    expect(visibleToolInvocations()).toEqual(["bun test"]);

    cleanup();
    renderTab({
      ...pipeline,
      verificationResult: undefined,
      verificationFeedback: undefined,
      currentSessionIndex: 2,
      sessions: [pipeline.sessions[0]!, legacyVerify, prSession],
    });
    selectNode("Verify");
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(visibleToolInvocations()).toEqual(["bun test"]);
    expect(visibleTextContents()).toEqual([]);
  });

  test("a superseded legacy Verify keeps its own accepted verdict after live evidence is cleared", async () => {
    const historical = rewoundToFirstVerify();
    const legacy = historical.sessions[2]!;
    legacy.agent = "codex";
    legacy.status = "idle";
    delete legacy.structuredResultStatus;
    // The backend migrates the latest legacy verdict onto its owner before
    // clearing pipeline-level feedback during the rewind.
    legacy.verificationResult = "fail";
    legacy.verificationFeedback = "Historical criterion failed.";
    const provisional = JSON.stringify({ complete: true, rationale: "Still checking." });
    const final = JSON.stringify({ complete: false, rationale: legacy.verificationFeedback });
    legacy.messages = [
      {
        id: "legacy-verdict",
        role: "assistant",
        content: final,
        parts: [
          { type: "text", content: provisional },
          { type: "text", content: final },
        ],
      },
    ];
    expect(historical.verificationResult).toBeUndefined();
    renderTab(historical);
    selectNode("Previous attempt");
    fireEvent.click(within(inspector()).getByRole("button", { name: `${legacy.label} · round 1` }));
    await waitFor(() => expect(screen.getAllByText("Verification failed")).toHaveLength(1));
    expect(visibleTextContents()).toEqual([final]);
    expect(JSON.stringify(listProps.messages)).not.toContain("Still checking.");
    expect(within(inspector()).queryByRole("button", { name: "Restart from here" }) === null).toBe(
      true,
    );
  });

  test("keeps the report's sections collapsed and its JSON out of the transcript", async () => {
    renderTab(reviewed);
    selectNode("Review");
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /Inspect raw JSON/ }) === null).toBe(true);
    expect(screen.queryByLabelText("Raw structured review JSON") === null).toBe(true);
    expect(screen.queryByText("Updates the review workflow.") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /What Changed/ }));
    await waitFor(() => expect(screen.getByText("Updates the review workflow.")).toBeTruthy());
  });

  test("falls back to the newest review stage for a report with no request id", async () => {
    renderTab({
      ...reviewed,
      structuredReviewRequestId: undefined,
      sessions: reviewed.sessions.map((session) =>
        session.sessionKey === "review-key"
          ? { ...session, structuredRequestId: undefined }
          : session,
      ),
      backendRevision: 41,
    });

    selectNode("Review");
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());
  });

  test("falls back to the newest review stage when the request id matches none", async () => {
    // A pipeline can outlive the session its report was requested from. The
    // report is still real, so it must land somewhere rather than vanish.
    renderTab({
      ...reviewed,
      structuredReviewRequestId: "a-request-no-session-claims",
      backendRevision: 46,
    });

    selectNode("Review");
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());
  });

  test("walks the graph with the arrow keys, as a tablist promises", async () => {
    renderTab(reviewed);
    expect(selectedTitle()).toBe("Verify");

    const press = (key: string) => {
      const focused = within(graph())
        .getAllByRole("tab")
        .find((tab) => tab.getAttribute("aria-selected") === "true")!;
      fireEvent.keyDown(focused, { key });
    };
    press("ArrowLeft");
    await waitFor(() => expect(selectedTitle()).toBe("Review"));
    expect(document.activeElement).toBe(graphNode("Review"));
    expect(screen.getByText("The review is complete")).toBeTruthy();

    press("ArrowRight");
    await waitFor(() => expect(selectedTitle()).toBe("Verify"));
    // Up and Down walk the same order, for the stacked column.
    press("ArrowUp");
    await waitFor(() => expect(selectedTitle()).toBe("Review"));
    press("ArrowDown");
    await waitFor(() => expect(selectedTitle()).toBe("Verify"));

    press("Home");
    await waitFor(() => expect(selectedTitle()).toBe("Ticket"));
    press("End");
    await waitFor(() => expect(selectedTitle()).toBe("PR"));
    // The line has ends: it does not wrap.
    press("ArrowRight");
    expect(selectedTitle()).toBe("PR");
  });

  test("moves onto and past the Prepare node with the arrow keys", async () => {
    const packageSession: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      phase: "fix",
      sessionKey: "package-key",
      sdkSessionId: "package-session",
      label: REVIEW_PACKAGE_SESSION_LABEL,
    };
    renderTab({
      ...reviewed,
      sessions: [pipeline.sessions[0]!, packageSession, reviewSession, pipeline.sessions[1]!],
      currentSessionIndex: 3,
      validationRun: validationRun({ id: "validation-keys" }),
    });
    expect(selectedTitle()).toBe("Verify");

    fireEvent.keyDown(graphNode("Verify"), { key: "ArrowLeft" });
    await waitFor(() => expect(selectedTitle()).toBe("Review"));
    fireEvent.keyDown(graphNode("Review"), { key: "ArrowLeft" });
    await waitFor(() => expect(selectedTitle()).toBe("Prepare"));
    expect(document.activeElement).toBe(graphNode("Prepare"));
    expect(within(inspector()).getByRole("tab", { name: "Tests" })).toBeTruthy();

    fireEvent.keyDown(graphNode("Prepare"), { key: "ArrowLeft" });
    await waitFor(() => expect(selectedTitle()).toBe("Build"));
  });

  test("moves from the focused node when it differs from the selected one", async () => {
    renderTab(reviewed);
    const build = graphNode("Build");
    build.focus();

    fireEvent.keyDown(build, { key: "ArrowRight" });

    await waitFor(() => expect(selectedTitle()).toBe("Review"));
    expect(document.activeElement).toBe(graphNode("Review"));
  });

  test("holds the arrow-key stage the same way it holds a clicked one", async () => {
    renderTab(reviewed);

    fireEvent.keyDown(graphNode("Verify"), { key: "ArrowLeft" });
    fireEvent.keyDown(graphNode("Review"), { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());

    // Selecting from the keyboard is a choice, not an auto-follow, so a later
    // backend push must not drag the user off the stage they picked.
    act(() => {
      useBuildPipelineStore.getState().replacePipeline({
        ...reviewed,
        currentSessionIndex: 1,
        backendRevision: 47,
      });
    });

    expect(screen.getByText("Implementation complete")).toBeTruthy();
    expect(screen.queryByText("The review is complete") === null).toBe(true);
  });

  test("keeps one node in the page tab sequence, not all of them", async () => {
    renderTab(reviewed);
    const tabStops = () =>
      within(graph())
        .getAllByRole("tab")
        .filter((tab) => tab.getAttribute("tabindex") === "0")
        .map((tab) => tab.getAttribute("aria-label")?.split(", ")[0]);

    // Otherwise Tab walks every node before reaching the inspector.
    expect(tabStops()).toEqual(["Verify"]);

    selectNode("Build");
    await waitFor(() => expect(tabStops()).toEqual(["Build"]));
  });

  test("ignores keys that mean nothing to the graph", () => {
    renderTab(reviewed);
    const verify = graphNode("Verify");

    fireEvent.keyDown(verify, { key: "a" });
    fireEvent.keyDown(verify, { key: "PageDown" });
    fireEvent.keyDown(verify, { key: "Enter" });

    expect(selectedTitle()).toBe("Verify");
  });

  test("shows no review banner while following the pipeline past review", async () => {
    renderTab(reviewed);

    // The review's outcome lives on its node and in the key information
    // panel, not in a banner above the graph.
    expect(selectedTitle()).toBe("Verify");
    expect(screen.queryByRole("button", { name: /The review reported/ }) === null).toBe(true);

    selectNode("Review");
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());
  });

  test("counts issues on the node that holds the report, and only that node", () => {
    // The backend records each report's counts on the session that filed it.
    renderTab({
      ...reviewed,
      sessions: reviewed.sessions.map((session) =>
        session.phase === "review"
          ? { ...session, reviewIssueCounts: { P0: 0, P1: 1, P2: 0 } }
          : session,
      ),
    });

    const counted = within(graph())
      .getAllByRole("tab")
      .filter((tab) => (tab.getAttribute("aria-label") ?? "").endsWith("1 issue"))
      .map((tab) => tab.getAttribute("aria-label")?.split(", ")[0]);
    expect(counted).toEqual(["Review"]);
    expect(graphNode("Review").querySelector("[data-severity]")).toBeTruthy();
  });

  test("says nothing about a review for a pipeline that has not had one", () => {
    renderTab({ ...pipeline, backendRevision: 42 });

    expect(screen.queryByRole("button", { name: /The review reported/ }) === null).toBe(true);
    expect(screen.queryByText(/Report ·/) === null).toBe(true);
  });

  test("names the transcript panel after the stage whose tab is selected", async () => {
    renderTab(reviewed);
    const panel = screen.getByRole("tabpanel");
    const selectedTabId = () =>
      screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.id ??
      null;

    expect(panel.getAttribute("aria-labelledby")).toBe(selectedTabId());

    selectNode("Review");
    await waitFor(() => expect(panel.getAttribute("aria-labelledby")).toBe(selectedTabId()));
    // Two build tabs can be mounted at once, so the ids cannot be constants.
    expect(panel.id).not.toBe("build-stage-transcript");
    expect(screen.getAllByRole("tab").every((tab) => tab.id.length > 0)).toBe(true);
  });

  test("distinguishes a running stage from a failed one in the graph", () => {
    renderTab({
      ...reviewed,
      phase: "reviewing",
      sessions: [
        { ...reviewed.sessions[0]!, status: "error" },
        { ...reviewed.sessions[1]!, status: "running", messages: [] },
      ],
      currentSessionIndex: 1,
      backendRevision: 43,
    });

    expect(graphNode("Build").getAttribute("data-flow-state")).toBe("failed");
    expect(graphNode("Review").getAttribute("data-flow-state")).toBe("running");
    expect(graphNode("Review").querySelector(".animate-spin")).toBeTruthy();
    // A running stage with nothing synchronized yet says so.
    expect(screen.getByText(/This stage is running/)).toBeTruthy();
  });

  test("names the warned active stage while a historical stage is pinned", async () => {
    renderTab({
      ...reviewed,
      phase: "verifying",
      stallWarning: {
        sessionId: "verify-session",
        detectedAt: "2026-07-29T00:12:00.000Z",
      },
      backendRevision: 48,
    });

    selectNode("Build");
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());
    const warning = screen.getByText(/transcript has not changed/);
    expect(warning.textContent).toContain("Verification Session is still running");
    expect(warning.textContent).not.toContain("Build Session is still running");
  });

  test("keeps the stall warning off a pipeline that is no longer running", () => {
    const stalled = {
      sessionId: "verify-session",
      detectedAt: "2026-07-29T00:12:00.000Z",
    };

    // The banner asserts the stage "is still running". The backend clears the
    // warning on every terminal and paused transition, so a snapshot that still
    // carries one was written by an older build and must not make that claim.
    renderTab({ ...reviewed, phase: "paused", stallWarning: stalled, backendRevision: 54 });
    expect(screen.queryByText(/transcript has not changed/) === null).toBe(true);

    cleanup();
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "Verification crashed",
      stallWarning: stalled,
      backendRevision: 55,
    });
    expect(screen.queryByText(/transcript has not changed/) === null).toBe(true);
    expect(screen.getByText("Verification crashed")).toBeTruthy();
  });

  test("names the active stage when the warned session is not in the snapshot", () => {
    renderTab({
      ...reviewed,
      phase: "verifying",
      // A retry can replace the session list under a warning the backend has
      // not cleared yet; the banner is still true, so it must still render.
      stallWarning: {
        sessionId: "a-session-no-stage-claims",
        detectedAt: "2026-07-29T00:12:00.000Z",
      },
      backendRevision: 56,
    });

    const warning = screen.getByText(/transcript has not changed/);
    expect(warning.textContent).toContain("The active stage is still running");
  });

  test("keeps the error and offers a retry for the failed stage", async () => {
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "The prompt was never dispatched",
      failureContext: { phase: "building", kind: "prompt-dispatch", sessionId: "build-session" },
      backendRevision: 57,
    });

    // Only an interactive-request failure moves the message and the control
    // into the recovery banner; every other failure keeps both here.
    expect(
      screen
        .getAllByText("The prompt was never dispatched")
        .filter((element) => element.className.includes("bg-destructive/10")),
    ).toHaveLength(1);
    const header = within(screen.getByTestId("build-pipeline-header"));
    expect(header.queryByRole("button", { name: /^Restart/ }) === null).toBe(true);
    const retry = header.getByRole("button", { name: "Retry Build Stage" });
    expect(screen.queryByRole("button", { name: "Retry failed build phase" }) === null).toBe(true);
    expect(graphNode("Build").getAttribute("data-flow-state")).toBe("failed");
    fireEvent.click(retry);
    await waitFor(() => expect(retryStageMock).toHaveBeenCalledWith(reviewed.id));
  });

  test("retries the failed step from its node", async () => {
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "Verification did not complete",
      failureContext: { phase: "verifying", kind: "stage-transition", sessionId: "verify-session" },
      backendRevision: 57,
    });

    expect(selectedTitle()).toBe("Verify");
    fireEvent.click(within(inspector()).getByRole("button", { name: "Retry failed step" }));
    await waitFor(() => expect(retryStageMock).toHaveBeenCalledWith(reviewed.id));
    expect(mockToastSuccess).toHaveBeenCalledWith("Failed stage restarted");
  });

  test("shows a retry rejection and re-enables the failed-stage control", async () => {
    retryStageMock.mockRejectedValueOnce(new Error("retry command unavailable"));
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "The prompt was never dispatched",
      failureContext: { phase: "building", kind: "prompt-dispatch" },
      backendRevision: 58,
    });

    const retry = screen.getByRole("button", {
      name: "Retry Build Stage",
    }) as HTMLButtonElement;
    fireEvent.click(retry);

    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(mockToastError).toHaveBeenCalledWith("Failed to restart the stage", {
      description: "retry command unavailable",
    });
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Failed stage restarted");
  });

  test("reports a retry that resolves to another failed snapshot", async () => {
    const failedAgain: BuildPipeline = {
      ...reviewed,
      phase: "failed",
      error: "fresh session could not be created",
      failureContext: { phase: "building", kind: "stage-transition" },
      backendRevision: 59,
    };
    retryStageMock.mockResolvedValueOnce(failedAgain);
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "The prompt was never dispatched",
      failureContext: { phase: "building", kind: "prompt-dispatch" },
      backendRevision: 58,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry Build Stage" }));

    await waitFor(() => {
      expect(useBuildPipelineStore.getState().pipelines.get(reviewed.id)).toEqual(failedAgain);
    });
    expect(mockToastError).toHaveBeenCalledWith("Failed to restart the stage", {
      description: "fresh session could not be created",
    });
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Failed stage restarted");
  });

  test("labels the failed-stage retry for every resumable phase", () => {
    const cases: Array<[ResumableBuildPhase, string]> = [
      ["creating-environment", "Retry Environment Creation"],
      ["starting-environment", "Retry Environment Start"],
      ["waiting-for-setup", "Retry Setup"],
      ["building", "Retry Build Stage"],
      ["reviewing", "Retry Review Stage"],
      ["addressing", "Retry Address Stage"],
      ["verifying", "Retry Verification Stage"],
      ["fixing", "Retry Fix Stage"],
      ["creating-pr", "Retry PR Stage"],
      ["resolving-conflicts", "Retry Conflict Resolution"],
    ];
    for (const [phase, label] of cases) {
      cleanup();
      renderTab({
        ...reviewed,
        phase: "failed",
        error: "stage failed",
        failureContext: {
          phase,
          kind: "stage-transition",
          sessionId: "failed-session",
        },
        backendRevision: 60,
      });
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  test("badges no stage that declined nothing", () => {
    renderTab({
      ...pipeline,
      autoDeclineCount: 0,
      sessions: [
        { ...pipeline.sessions[0]!, autoDeclineCount: 0 },
        // Written before the counter existed, so it carries none at all.
        pipeline.sessions[1]!,
      ],
      backendRevision: 58,
    });

    expect(screen.queryByText(/input request/) === null).toBe(true);
    expect(screen.queryByText(/auto-declined/) === null).toBe(true);
  });

  test("says on each stage how many requests it declined, with its own history", async () => {
    const interaction = (id: string, title: string) => ({
      id,
      provider: "codex" as const,
      kind: "question" as const,
      phase: "build" as const,
      requestedAt: 1,
      resolvedAt: 2,
      outcome: "auto-declined-headless" as const,
      title,
      questions: [],
    });
    renderTab({
      ...pipeline,
      id: "interaction-history",
      autoDeclineCount: 3,
      sessions: [
        {
          ...pipeline.sessions[0]!,
          autoDeclineCount: 1,
          interactionTranscript: [interaction("build-question", "Build choice")],
        },
        {
          ...pipeline.sessions[1]!,
          autoDeclineCount: 2,
          interactionTranscript: [interaction("verify-question", "Verify choice")],
        },
      ],
      currentSessionIndex: 1,
      backendRevision: 49,
    });

    expect(within(inspector()).getByText("2 input requests auto-declined")).toBeTruthy();
    expect(screen.getByText(/3 unattended input requests were auto-declined/)).toBeTruthy();
    expect(screen.getByText(/Verify choice/)).toBeTruthy();

    selectNode("Build");
    await waitFor(() => expect(screen.getByText(/Build choice/)).toBeTruthy());
    expect(within(inspector()).getByText("1 input request auto-declined")).toBeTruthy();
    expect(screen.queryByText(/Verify choice/) === null).toBe(true);
  });

  test("says on the stage when its configured model was substituted", () => {
    const message = "claude-sonnet-5 isn't available with your OpenCode login; using GPT-5.6 Luna.";
    renderTab({
      ...pipeline,
      id: "model-substitution",
      sessions: [
        {
          ...pipeline.sessions[0]!,
          agent: "opencode",
          model: "opencode-go/gpt-5.6-luna",
          modelSubstitution: {
            requestedModelId: "opencode/claude-sonnet-5",
            modelId: "opencode-go/gpt-5.6-luna",
            message,
          },
        },
        pipeline.sessions[1]!,
      ],
      currentSessionIndex: 1,
      backendRevision: 50,
    });

    expect(within(inspector()).queryByText(message) === null).toBe(true);
    selectNode("Build");
    expect(within(inspector()).getByText(message)).toBeTruthy();
  });
});
