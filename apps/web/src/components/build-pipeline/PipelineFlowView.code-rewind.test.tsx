import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { build, rewoundToFirstVerify, session, validationRun } from "./pipeline-test-fixture";
import {
  inspector,
  previewCodeRewindMock,
  renderPipelineTab,
  restartStepMock,
  restoreBuildChatTabMocks,
  rewindCodeMock,
  selectNode,
} from "./build-chat-tab-test-support";

const START = "a".repeat(40);
const HEAD = "c".repeat(40);

afterAll(restoreBuildChatTabMocks);
beforeEach(() => {
  previewCodeRewindMock.mockClear();
  rewindCodeMock.mockClear();
  restartStepMock.mockClear();
});
afterEach(() => {
  cleanup();
  useFlowGraphViewStore.setState({
    views: new Map(),
    collapsed: new Set(),
    expandedAttempts: new Set(),
  });
});

const completed = () =>
  build({
    phase: "complete",
    currentSessionIndex: 2,
    sessions: [
      session("build", "build", 0, { headAtStart: START, producedReviewPackagePlan: true }),
      session("review", "review", 60, { headAtStart: HEAD }),
      session("verify", "verify", 120),
    ],
  });

const button = (name: string) => within(inspector()).queryByRole("button", { name });

describe("package-only restart", () => {
  test("a build that wrote the package plan prepares it again on its own", () => {
    renderPipelineTab(completed());
    selectNode("Build");
    fireEvent.click(button("Prepare package again")!);
    expect(restartStepMock).toHaveBeenCalledWith("pipeline-1", "review-package:build");
    // A step that did not write the plan has no such action.
    selectNode("Review");
    expect(button("Prepare package again")).toBeNull();
  });

  test("the Prepare node of a package written by the build names that build", () => {
    renderPipelineTab(
      build({
        phase: "building",
        sessions: [session("build", "build", 0, { producedReviewPackagePlan: true })],
        validationRun: validationRun({ status: "running" }),
      }),
    );
    selectNode("Prepare");
    fireEvent.click(button("Prepare package again")!);
    expect(restartStepMock).toHaveBeenCalledWith("pipeline-1", "review-package:build");
  });

  test("a dedicated preparation session restarts through Restart from here instead", () => {
    renderPipelineTab(
      build({
        phase: "reviewing",
        currentSessionIndex: 1,
        sessions: [
          session("build", "build", 0),
          session("fix", "prep", 60, { label: "Package Preparation Session" }),
        ],
      }),
    );
    selectNode("Prepare");
    expect(button("Prepare package again")).toBeNull();
    expect(button("Restart from here")).not.toBeNull();
  });
});

describe("rewinding the code to a step", () => {
  test("only steps with a recorded start commit offer it, and never history", () => {
    renderPipelineTab(completed());
    selectNode("Build");
    expect(button("Rewind code to here…")).not.toBeNull();
    selectNode("Verify");
    expect(button("Rewind code to here…")).toBeNull();

    cleanup();
    const history = rewoundToFirstVerify();
    history.sessions = history.sessions.map((entry) => ({ ...entry, headAtStart: START }));
    renderPipelineTab(history);
    selectNode("Previous attempt");
    expect(button("Rewind code to here…")).toBeNull();
  });

  test("the confirmation names the dropped commits and sends the HEAD it showed", async () => {
    previewCodeRewindMock.mockImplementationOnce(async (pipelineId, stageId) => ({
      pipelineId,
      sessionKey: stageId,
      iteration: 0,
      targetCommit: START,
      head: HEAD,
      commits: [
        { sha: HEAD, subject: "fix: address review" },
        { sha: "b".repeat(40), subject: "feat: build it" },
      ],
      commitCount: 3,
      upstream: { ref: "origin/build", droppedCommits: 2 },
      pullRequest: { url: "https://github.com/acme/repo/pull/1", state: "open" },
    }));
    renderPipelineTab(completed());
    selectNode("Build");
    fireEvent.click(button("Rewind code to here…")!);
    const dialog = await screen.findByTestId("pipeline-code-rewind-dialog");
    expect(previewCodeRewindMock).toHaveBeenCalledWith("pipeline-1", "build");
    await waitFor(() =>
      expect(within(dialog).getByTestId("pipeline-code-rewind-commits").textContent).toContain(
        "fix: address review",
      ),
    );
    expect(dialog.textContent).toContain("Resets the branch to aaaaaaa");
    expect(dialog.textContent).toContain("and 1 more commit");
    expect(dialog.textContent).toContain(
      "origin/build already has 2 commits that the rewind drops, and so does the pull request",
    );
    expect(dialog.textContent).toContain("force-pushes with lease");

    fireEvent.click(within(dialog).getByRole("button", { name: "Drop 3 commits and restart" }));
    await waitFor(() => expect(rewindCodeMock).toHaveBeenCalledWith("pipeline-1", "build", HEAD));
    await waitFor(() => expect(screen.queryByTestId("pipeline-code-rewind-dialog")).toBeNull());
  });

  test("a blocked preview explains why and cannot be confirmed", async () => {
    previewCodeRewindMock.mockImplementationOnce(async (pipelineId, stageId) => ({
      pipelineId,
      sessionKey: stageId,
      iteration: 0,
      targetCommit: START,
      head: HEAD,
      commits: [],
      commitCount: 0,
      uncommittedPaths: ["src/app.ts"],
      blocked:
        "The worktree has uncommitted changes, which a reset would destroy. Commit or discard them first.",
    }));
    renderPipelineTab(completed());
    selectNode("Build");
    fireEvent.click(button("Rewind code to here…")!);
    const dialog = await screen.findByTestId("pipeline-code-rewind-dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toContain("uncommitted"),
    );
    expect(dialog.textContent).toContain("src/app.ts");
    const confirm = within(dialog).getByRole("button", { name: "Rewind and restart" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(rewindCodeMock).not.toHaveBeenCalled();
  });

  test("a previous attempt says the code was reset and where the old tip is", () => {
    const history = rewoundToFirstVerify();
    history.rewinds = history.rewinds!.map((rewind) => ({
      ...rewind,
      code: {
        from: HEAD,
        to: START,
        droppedCommits: 2,
        backupRef: "refs/orkestrator/build-pipeline-rewinds/pipeline-1/rewind-1",
      },
    }));
    renderPipelineTab(history);
    selectNode("Previous attempt");
    expect(inspector().textContent).toContain(
      "the code was reset from ccccccc to aaaaaaa, dropping 2 commits.",
    );
    expect(inspector().textContent).toContain(
      "refs/orkestrator/build-pipeline-rewinds/pipeline-1/rewind-1",
    );
  });
});
