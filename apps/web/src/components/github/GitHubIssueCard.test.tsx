import { beforeEach, describe, expect, mock, test } from "bun:test";
import { DndContext } from "@dnd-kit/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GitHubIssue } from "@/types/github";
import { GitHubIssueCard, getGitHubStageLabel } from "./GitHubIssueCard";

const issue: GitHubIssue = {
  id: 101,
  number: 42,
  title: "Ship the issue workflow",
  body: "Body",
  htmlUrl: "https://github.com/acme/widget/issues/42",
  state: "open",
  locked: false,
  author: { login: "ada" },
  assignees: [{ login: "grace" }],
  labels: [
    { name: "enhancement", color: "84b6eb" },
    { name: "priority", color: "not-a-color" },
    { name: "backend", color: "0e8a16" },
    { name: "customer", color: "fbca04" },
  ],
  commentsCount: 3,
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-24T10:00:00.000Z",
  status: "todo",
};

describe("GitHubIssueCard", () => {
  beforeEach(cleanup);

  function renderCard(overrides: Partial<React.ComponentProps<typeof GitHubIssueCard>> = {}) {
    const onOpen = mock(() => undefined);
    const onStatusChange = mock(() => undefined);
    render(
      <DndContext>
        <GitHubIssueCard
          issue={issue}
          onOpen={onOpen}
          onStatusChange={onStatusChange}
          {...overrides}
        />
      </DndContext>,
    );
    return { onOpen, onStatusChange };
  }

  test("renders issue metadata, bounded labels, comments, and assignees", () => {
    renderCard();

    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("Ship the issue workflow")).toBeTruthy();
    expect(screen.getByText("enhancement")).toBeTruthy();
    expect(screen.getByText("priority")).toBeTruthy();
    expect(screen.getByText("backend")).toBeTruthy();
    expect(screen.queryByText("customer") === null).toBe(true);
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByLabelText("3 comments")).toBeTruthy();
    expect(screen.getByLabelText("Assigned to grace")).toBeTruthy();
    expect((screen.getByText("priority") as HTMLElement).style.color).toBe("#6b7280");
  });

  test("opens the issue and changes its workflow status", async () => {
    const { onOpen, onStatusChange } = renderCard();

    fireEvent.click(screen.getByText("Ship the issue workflow"));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("combobox", { name: "Status for issue #42" }));
    fireEvent.click(await screen.findByRole("option", { name: "Review" }));

    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("review");
    });
  });

  test("disables drag and status controls while a status update is pending", () => {
    renderCard({ statusPending: true });

    expect(
      (screen.getByRole("button", { name: "Drag issue #42" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("combobox", {
          name: "Status for issue #42",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("provides stable labels for every workflow stage and unknown values", () => {
    expect(getGitHubStageLabel("backlog")).toBe("Backlog");
    expect(getGitHubStageLabel("todo")).toBe("Todo");
    expect(getGitHubStageLabel("inprogress")).toBe("In Progress");
    expect(getGitHubStageLabel("review")).toBe("Review");
    expect(getGitHubStageLabel("unexpected" as never)).toBe("unexpected");
  });
});
