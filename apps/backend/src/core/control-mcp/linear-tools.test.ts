import { describe, expect, test } from "bun:test";
import { rpc, useControlMcpServerHarness } from "./server-test-support.js";

/** A coordinator's Linear tools (`linear-tools.ts`) over the real Control MCP server. */
describe("Control MCP Linear tools", () => {
  const harness = useControlMcpServerHarness();
  const { invocations, overrides, coordinatorCredential } = harness;

  const LINK = {
    link: {
      key: "repo:github.com/acme/web",
      teamId: "team-1",
      teamKey: "ENG",
      teamName: "Engineering",
      linearProjectId: "lp-1",
      linearProjectName: "Website",
      updatedAt: "2026-11-11T00:00:00.000Z",
    },
  };

  async function call(name: string, args: Record<string, unknown>) {
    const descriptor = coordinatorCredential(["discovery", "tickets"]);
    const answer = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name,
      arguments: args,
    });
    return answer.body.result as
      | { isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown }
      | undefined;
  }

  test("a coordinator is offered the Linear tools, and an operator is not", async () => {
    const descriptor = coordinatorCredential(["discovery", "tickets"]);
    const listed = await rpc(descriptor.url, descriptor.token, "tools/list");
    const names = listed.body.result?.tools?.map(({ name }) => name) ?? [];
    for (const tool of [
      "list_linear_issues",
      "get_linear_issue",
      "create_linear_issue",
      "update_linear_issue",
      "add_linear_comment",
      "list_linear_board_options",
    ]) {
      expect(names).toContain(tool);
    }
    const tool = listed.body.result?.tools?.find(({ name }) => name === "list_linear_issues") as
      { description?: string } | undefined;
    // Kanban stays the default board.
    expect(tool?.description).toContain("Kanban (list_tickets) stays the default board");
  });

  test("lists the project board's issues with filters, tagged with the board", async () => {
    overrides.set("get_linear_board_link", () => LINK);
    overrides.set("get_linear_issues", () => [
      { id: "1", identifier: "ENG-1", title: "Header", status: "Todo", statusType: "unstarted" },
      {
        id: "2",
        identifier: "ENG-2",
        title: "Footer",
        status: "Done",
        statusType: "completed",
        assigneeName: "Ada",
      },
      {
        id: "3",
        identifier: "ENG-3",
        title: "Header copy",
        status: "In Progress",
        statusType: "started",
      },
    ]);
    const result = await call("list_linear_issues", {
      projectId: "project-1",
      text: "header",
      status: "unstarted",
    });
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent).toMatchObject({
      board: { teamKey: "ENG", linearProjectName: "Website" },
      total: 1,
      issues: [{ identifier: "ENG-1" }],
    });
    expect(invocations.find(({ command }) => command === "get_linear_issues")?.args).toEqual({
      projectId: "project-1",
    });
  });

  test("creates an issue with the request id as its request key", async () => {
    overrides.set("create_linear_issue", (args) => ({
      id: "issue-new",
      identifier: "ENG-9",
      title: args.title,
      description: "",
      comments: [],
      labels: [],
    }));
    const result = await call("create_linear_issue", {
      requestId: "req-1",
      projectId: "project-1",
      title: "New thing",
      priority: 2,
      labelIds: ["label-1"],
    });
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent).toMatchObject({ issue: { identifier: "ENG-9" } });
    expect(invocations.find(({ command }) => command === "create_linear_issue")?.args).toEqual({
      projectId: "project-1",
      requestKey: "req-1",
      title: "New thing",
      priority: 2,
      labelIds: ["label-1"],
    });
  });

  test("updates only the named fields, and passes null to unassign", async () => {
    overrides.set("update_linear_issue", () => ({
      id: "issue-1",
      identifier: "ENG-1",
      title: "x",
    }));
    const result = await call("update_linear_issue", {
      requestId: "req-2",
      projectId: "project-1",
      issueId: "ENG-1",
      stateId: "state-2",
      assigneeId: null,
    });
    expect(result?.isError).not.toBe(true);
    expect(invocations.find(({ command }) => command === "update_linear_issue")?.args).toEqual({
      projectId: "project-1",
      issueId: "ENG-1",
      stateId: "state-2",
      assigneeId: null,
    });
  });

  test("reads an issue and comments on it, scoped to the project", async () => {
    overrides.set("get_linear_issue", () => ({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Header",
      description: "Body",
      labels: ["bug"],
      comments: Array.from({ length: 60 }, (_, index) => ({ id: `c${index}` })),
    }));
    overrides.set("post_linear_issue_comment", (args) => ({ id: "c-new", body: args.body }));
    const read = await call("get_linear_issue", { projectId: "project-1", issueId: "ENG-1" });
    expect(read?.structuredContent).toMatchObject({
      issue: { identifier: "ENG-1", olderComments: 10 },
    });
    const issue = read?.structuredContent?.issue as { comments?: unknown[] } | undefined;
    expect(issue?.comments).toHaveLength(50);
    expect(invocations.find(({ command }) => command === "get_linear_issue")?.args).toEqual({
      projectId: "project-1",
      issueId: "ENG-1",
    });

    const commented = await call("add_linear_comment", {
      requestId: "req-3",
      projectId: "project-1",
      issueId: "ENG-1",
      text: "Done in #12",
    });
    expect(commented?.structuredContent).toMatchObject({ comment: { id: "c-new" } });
    expect(
      invocations.find(({ command }) => command === "post_linear_issue_comment")?.args,
    ).toEqual({ projectId: "project-1", issueId: "ENG-1", body: "Done in #12" });
  });

  test("lists the board's states, labels and members", async () => {
    overrides.set("get_linear_board_link", () => LINK);
    overrides.set("get_linear_board_options", () => ({
      teamId: "team-1",
      states: [{ id: "s1", name: "Todo" }],
      labels: [{ id: "l1", name: "bug" }],
      members: [{ id: "m1", name: "Ada" }],
    }));
    const result = await call("list_linear_board_options", { projectId: "project-1" });
    expect(result?.structuredContent).toMatchObject({
      board: { teamId: "team-1" },
      states: [{ id: "s1" }],
      labels: [{ id: "l1" }],
      members: [{ id: "m1" }],
    });
  });

  test("a backend refusal reaches the coordinator as a tool error", async () => {
    overrides.set("get_linear_board_link", () => ({}));
    overrides.set("get_linear_issues", () => {
      throw new Error('Project "Orkestrator" has no Linear board linked.');
    });
    const result = await call("list_linear_issues", { projectId: "project-1" });
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toContain("no Linear board linked");
  });
});
