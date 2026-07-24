import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  githubIssueDetailKey,
  useGitHubIssuesStore,
} from "@/stores/githubIssuesStore";
import type {
  GitHubIssue,
  GitHubIssueDetail,
  GitHubIssueStatus,
} from "@/types/github";
import { GitHubIssuesView } from "./GitHubIssuesView";

const repository = {
  owner: "acme",
  name: "widget",
  fullName: "acme/widget",
  htmlUrl: "https://github.com/acme/widget",
};

function makeIssue(
  number: number,
  status: GitHubIssueStatus,
  title = `${status} issue`,
): GitHubIssue {
  return {
    id: 100 + number,
    number,
    title,
    body: `${title} body`,
    htmlUrl: `https://github.com/acme/widget/issues/${number}`,
    state: "open",
    locked: false,
    author: { login: "ada" },
    assignees: [],
    labels: [],
    commentsCount: 0,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    status,
  };
}

const issues = [
  makeIssue(1, "backlog", "Backlog candidate"),
  makeIssue(2, "todo", "Ready to start"),
  makeIssue(3, "inprogress", "Being implemented"),
  makeIssue(4, "review", "Awaiting review"),
  makeIssue(5, "review", "Second review"),
];
const loadIssuesMock = mock(async () => undefined);
const loadIssueMock = mock(async () => undefined);
const changeStatusMock = mock(async () => undefined);
const originalState = useGitHubIssuesStore.getState();

afterAll(() => {
  cleanup();
  useGitHubIssuesStore.setState(originalState, true);
});

describe("GitHubIssuesView", () => {
  afterEach(cleanup);

  beforeEach(() => {
    cleanup();
    loadIssuesMock.mockClear();
    loadIssueMock.mockClear();
    changeStatusMock.mockReset();
    changeStatusMock.mockResolvedValue(undefined);
    useGitHubIssuesStore.setState({
      ...originalState,
      snapshots: new Map([[
        "project-1",
        {
          repository,
          viewer: { login: "reviewer" },
          issues,
        },
      ]]),
      details: new Map([
        [
          githubIssueDetailKey("project-1", 2),
          { ...issues[1], comments: [] } as GitHubIssueDetail,
        ],
      ]),
      loadingProjects: new Set(),
      loadingDetails: new Set(),
      projectErrors: new Map(),
      detailErrors: new Map(),
      mutations: new Set(),
      mutationErrors: new Map(),
      loadIssues: loadIssuesMock,
      loadIssue: loadIssueMock,
      changeStatus: changeStatusMock,
    });
  });

  test("loads the current project and groups every open issue with stage counts", async () => {
    render(<GitHubIssuesView projectId="project-1" />);

    expect(screen.getByText("acme/widget")).toBeTruthy();
    expect(screen.getByText("5 open issues · signed in as @reviewer")).toBeTruthy();
    for (const title of [
      "Backlog candidate",
      "Ready to start",
      "Being implemented",
      "Awaiting review",
      "Second review",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }

    const expectedCounts = new Map([
      ["Backlog", "1"],
      ["Todo", "1"],
      ["In Progress", "1"],
      ["Review", "2"],
    ]);
    for (const [headingName, count] of expectedCounts) {
      const heading = screen.getByRole("heading", {
        level: 3,
        name: headingName,
      });
      const section = heading.closest("section");
      expect(section).not.toBeNull();
      expect(within(section!).getByText(count)).toBeTruthy();
    }
    await waitFor(() => {
      expect(loadIssuesMock).toHaveBeenCalledWith("project-1");
    });
  });

  test("refreshes and changes status through the issue selector", async () => {
    render(<GitHubIssuesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(loadIssuesMock).toHaveBeenCalledTimes(2));

    fireEvent.click(
      screen.getByRole("combobox", { name: "Status for issue #2" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "In Progress" }));

    await waitFor(() => {
      expect(changeStatusMock).toHaveBeenCalledWith(
        "project-1",
        2,
        "inprogress",
      );
    });
  });

  test("opens an issue in the in-app detail view and returns to the board", async () => {
    render(<GitHubIssuesView projectId="project-1" />);

    fireEvent.click(screen.getByText("Ready to start"));
    expect(
      await screen.findByRole("button", { name: "Back to GitHub issues" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(loadIssueMock).toHaveBeenCalledWith("project-1", 2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Back to GitHub issues" }));
    expect(screen.getByText("5 open issues · signed in as @reviewer")).toBeTruthy();
  });

  test("shows an actionable load failure and retries loading", async () => {
    useGitHubIssuesStore.setState({
      snapshots: new Map(),
      projectErrors: new Map([["project-1", "GitHub rate limit reached"]]),
    });
    render(<GitHubIssuesView projectId="project-1" />);

    expect(screen.getByText("GitHub rate limit reached")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(loadIssuesMock).toHaveBeenCalledTimes(2));
  });

  test("shows the authoritative status mutation failure on the board", () => {
    useGitHubIssuesStore.setState({
      mutationErrors: new Map([
        ["status:project-1:2", "Permission denied while moving issue"],
      ]),
    });

    render(<GitHubIssuesView projectId="project-1" />);

    expect(screen.getByText("Permission denied while moving issue")).toBeTruthy();
  });

  test("renders loading and empty repository states", () => {
    useGitHubIssuesStore.setState({
      snapshots: new Map(),
      loadingProjects: new Set(["project-1"]),
    });
    const { rerender } = render(<GitHubIssuesView projectId="project-1" />);
    expect(screen.getByText("Loading open issues")).toBeTruthy();

    act(() => {
      useGitHubIssuesStore.setState({
        snapshots: new Map([[
          "project-1",
          { repository, viewer: { login: "reviewer" }, issues: [] },
        ]]),
        loadingProjects: new Set(),
      });
    });
    rerender(<GitHubIssuesView projectId="project-1" />);
    expect(screen.getByText("No open issues")).toBeTruthy();
  });
});
