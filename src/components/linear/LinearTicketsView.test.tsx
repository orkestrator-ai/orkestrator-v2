import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import * as realSonner from "sonner";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import type { LinearConnectionStatus, LinearIssueDetail, LinearIssueListItem } from "@/types/linear";

const realBackendSnapshot = { ...realBackend };
const realSonnerSnapshot = { ...realSonner };

const connectLinearMock = mock(async (): Promise<LinearConnectionStatus> => ({
  connected: true,
  hasToken: true,
  viewer: { id: "viewer-1", name: "Ada" },
}));
const getLinearConnectionMock = mock(async (): Promise<LinearConnectionStatus> => ({
  connected: true,
  hasToken: true,
  viewer: { id: "viewer-1", name: "Ada" },
}));
const getLinearIssuesMock = mock(async (): Promise<LinearIssueListItem[]> => []);
const getLinearIssueMock = mock(async (): Promise<LinearIssueDetail> => issueDetail);
const openInBrowserMock = mock(async () => undefined);
const startBuildFromLinearIssueMock = mock(async () => undefined);
const navigateToPipelineMock = mock(async () => undefined);
const toastSuccessMock = mock(() => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  connectLinear: connectLinearMock,
  getLinearConnection: getLinearConnectionMock,
  getLinearIssues: getLinearIssuesMock,
  getLinearIssue: getLinearIssueMock,
  openInBrowser: openInBrowserMock,
}));

mock.module("sonner", () => ({
  ...realSonnerSnapshot,
  toast: {
    ...realSonnerSnapshot.toast,
    success: toastSuccessMock,
  },
}));

const { LinearTicketsViewContent } = await import("./LinearTicketsView");

const issues: LinearIssueListItem[] = [
  {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Add Linear integration",
    status: "Todo",
    updatedAt: "2026-06-28T12:00:00.000Z",
    teamKey: "ENG",
  },
  {
    id: "issue-2",
    identifier: "ENG-124",
    title: "Polish dashboard",
    status: "Done",
    updatedAt: "2026-06-27T12:00:00.000Z",
    teamKey: "ENG",
  },
];

const issueDetail: LinearIssueDetail = {
  ...issues[0]!,
  description: "Build Linear support",
  createdAt: "2026-06-20T12:00:00.000Z",
  url: "https://linear.app/acme/issue/ENG-123",
  assigneeName: "Ada",
  priorityLabel: "High",
  creatorName: "Grace",
  projectName: "Integrations",
  cycleName: "Cycle 1",
  labels: ["linear", "pipeline"],
};

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("sonner", () => realSonnerSnapshot);
});

describe("LinearTicketsView", () => {
  beforeEach(() => {
    cleanup();
    connectLinearMock.mockClear();
    getLinearConnectionMock.mockReset();
    getLinearConnectionMock.mockResolvedValue({
      connected: true,
      hasToken: true,
      viewer: { id: "viewer-1", name: "Ada" },
    });
    getLinearIssuesMock.mockReset();
    getLinearIssuesMock.mockResolvedValue(issues);
    getLinearIssueMock.mockReset();
    getLinearIssueMock.mockResolvedValue(issueDetail);
    openInBrowserMock.mockClear();
    startBuildFromLinearIssueMock.mockClear();
    navigateToPipelineMock.mockClear();
    toastSuccessMock.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  function renderLinearTicketsView() {
    return render(
      <LinearTicketsViewContent
        projectId="project-1"
        buildPipeline={{
          startBuildFromLinearIssue: startBuildFromLinearIssueMock,
          navigateToPipeline: navigateToPipelineMock,
        }}
      />,
    );
  }

  test("shows a connect state and can start Linear connection setup", async () => {
    getLinearConnectionMock.mockResolvedValueOnce({
      connected: false,
      hasToken: false,
    });

    renderLinearTicketsView();

    expect(await screen.findByText("Linear is not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /connect linear/i }));
    fireEvent.change(screen.getByPlaceholderText("lin_api_..."), {
      target: { value: "lin_api_secret" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^connect$/i }).at(-1)!);

    await waitFor(() => {
      expect(connectLinearMock).toHaveBeenCalledWith("lin_api_secret");
      expect(toastSuccessMock).toHaveBeenCalledWith("Linear connected");
    });
  });

  test("loads tickets and filters by one or more Linear statuses", async () => {
    renderLinearTicketsView();

    expect(await screen.findByText("Add Linear integration")).toBeTruthy();
    expect(screen.getByText("Polish dashboard")).toBeTruthy();

    fireEvent.click(screen.getAllByText("Todo")[0]!);

    await waitFor(() => {
      expect(screen.getByText("Add Linear integration")).toBeTruthy();
      expect(screen.queryByText("Polish dashboard")).toBeNull();
    });

    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => {
      expect(screen.getByText("Polish dashboard")).toBeTruthy();
    });
  });

  test("opens ticket details and starts a Linear-backed build", async () => {
    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));

    expect(await screen.findByText("Build Linear support")).toBeTruthy();
    expect(screen.getByText("Grace")).toBeTruthy();
    expect(screen.getByText("Integrations")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /build local/i }));

    await waitFor(() => {
      expect(startBuildFromLinearIssueMock).toHaveBeenCalledWith(issueDetail, "project-1", "local");
    });
  });

  test("shows a recoverable detail load error", async () => {
    getLinearIssueMock
      .mockRejectedValueOnce(new Error("Linear detail unavailable"))
      .mockResolvedValueOnce(issueDetail);

    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Linear detail unavailable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByText("Build Linear support")).toBeTruthy();
    });
  });

  test("clears failed completion comment state when retrying from ticket details", async () => {
    const pipelineId = useBuildPipelineStore.getState().createPipeline({
      taskId: "issue-1",
      projectId: "project-1",
      environmentType: "local",
      agentType: "codex",
      taskTitle: "ENG-123: Add Linear integration",
      taskSnapshot: {
        title: "ENG-123: Add Linear integration",
        description: "Build Linear support",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      source: {
        type: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-123",
      },
    });
    useBuildPipelineStore.getState().setPhase(pipelineId, "complete");
    useBuildPipelineStore.getState().setCompletionCommentStatus(pipelineId, "failed", {
      error: "Linear unavailable",
    });

    renderLinearTicketsView();

    fireEvent.click(await screen.findByText("Add Linear integration"));
    expect(await screen.findByText("Linear comment failed: Linear unavailable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /retry comment/i }));

    expect(useBuildPipelineStore.getState().pipelines.get(pipelineId)?.completionCommentStatus).toBeUndefined();
  });
});
