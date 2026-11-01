import { describe, expect, test } from "bun:test";
import {
  githubIssueBuildTicket,
  kanbanTaskBuildTicket,
  linearIssueBuildTicket,
} from "./build-pipeline-tickets.js";

describe("kanbanTaskBuildTicket", () => {
  test("snapshots the ticket, links it and names from its text", () => {
    const ticket = kanbanTaskBuildTicket(
      {
        id: "task-1",
        projectId: "project-1",
        title: "Add login",
        description: "Users sign in",
        acceptanceCriteria: "",
        comments: [{ text: "Use OAuth" }],
      },
      [{ filename: "a.webp", data: "AAAA" }],
    );
    expect(ticket).toEqual({
      id: "task-1",
      projectId: "project-1",
      title: "Add login",
      namingPrompt: "Add login\n\nUsers sign in",
      source: { type: "kanban", taskId: "task-1" },
      taskSnapshot: {
        title: "Add login",
        description: "Users sign in",
        acceptanceCriteria: "",
        comments: [{ text: "Use OAuth" }],
        images: [{ filename: "a.webp", data: "AAAA" }],
      },
    });
  });
});

describe("linearIssueBuildTicket", () => {
  const issue = {
    id: "lin-1",
    identifier: "ENG-7",
    title: "Fix sync",
    description: "Sync drops rows",
    status: "Todo",
    url: "https://linear.app/x/ENG-7",
    teamKey: "ENG",
    updatedAt: "2026-01-01T00:00:00.000Z",
    comments: [{ body: "Seen twice", authorName: "Ada" }, { body: "Anonymous" }],
  };

  test("leads the comments with the issue reference and attributes the rest", () => {
    const ticket = linearIssueBuildTicket(issue, "project-1");
    expect(ticket.id).toBe("lin-1");
    expect(ticket.title).toBe("ENG-7: Fix sync");
    expect(ticket.namingPrompt).toBe("ENG-7\n\nFix sync\n\nSync drops rows\n\nTodo");
    expect(ticket.taskSnapshot.comments).toEqual([
      { text: "Linear issue: ENG-7" },
      { text: "URL: https://linear.app/x/ENG-7" },
      { text: "Status: Todo" },
      { text: "Ada: Seen twice" },
      { text: "Anonymous" },
    ]);
    expect(ticket.source).toEqual({
      type: "linear",
      issueId: "lin-1",
      issueIdentifier: "ENG-7",
      issueUrl: "https://linear.app/x/ENG-7",
      status: "Todo",
      teamKey: "ENG",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("keeps only the issue reference when comments are excluded", () => {
    const ticket = linearIssueBuildTicket(issue, "project-1", false);
    expect(ticket.taskSnapshot.comments.map(({ text }) => text)).toEqual([
      "Linear issue: ENG-7",
      "URL: https://linear.app/x/ENG-7",
      "Status: Todo",
    ]);
  });
});

describe("githubIssueBuildTicket", () => {
  test("uses a lowercased source-qualified id and @-attributed comments", () => {
    const ticket = githubIssueBuildTicket(
      {
        repositoryOwner: "Acme",
        repositoryName: "Widgets",
        number: 42,
        url: "https://github.com/Acme/Widgets/issues/42",
        title: "Crash on start",
        body: "Stack trace",
        labels: [],
        status: "open",
        comments: [
          { id: 1, body: "Same here", authorLogin: "bob" },
          { id: 2, body: "No author" },
        ],
      },
      "project-1",
    );
    expect(ticket.id).toBe("github:acme/widgets#42");
    expect(ticket.title).toBe("#42: Crash on start");
    expect(ticket.namingPrompt).toBe(
      "GitHub issue Acme/Widgets#42\n\nCrash on start\n\nStack trace\n\nopen",
    );
    expect(ticket.taskSnapshot.comments).toEqual([
      { text: "@bob: Same here" },
      { text: "No author" },
    ]);
    expect(ticket.source).toEqual({
      type: "github",
      repositoryOwner: "Acme",
      repositoryName: "Widgets",
      issueNumber: 42,
      issueUrl: "https://github.com/Acme/Widgets/issues/42",
      status: "open",
    });
  });
});
