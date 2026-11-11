import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  issueIsOnBoard,
  linearIssueUpdateFields,
  linearKeyFingerprint,
} from "../src/core/linear-boards";
import { linearBoardIssueFilter } from "../src/core/linear";
import { StorageService } from "../src/core/storage";
import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry, createContext, createEnvironment } = await createCommandFixtures();

const originalFetch = globalThis.fetch;
const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

type GraphqlRequest = { query: string; variables: Record<string, unknown> };

/** Answers Linear GraphQL calls by operation name, recording each request. */
function fakeLinear(handlers: Record<string, (variables: Record<string, unknown>) => unknown>) {
  const requests: GraphqlRequest[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as GraphqlRequest;
    requests.push(request);
    const name = /(?:query|mutation)\s+(\w+)/.exec(request.query)?.[1] ?? "";
    const handler = handlers[name];
    if (!handler) throw new Error(`Unexpected Linear operation ${name}`);
    return new Response(JSON.stringify({ data: handler(request.variables) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return requests;
}

const TEAM = {
  id: "team-1",
  key: "ENG",
  name: "Engineering",
  projects: { nodes: [{ id: "lp-1", name: "Website", state: "started" }] },
};

function issueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Fix the header",
    description: "Steps",
    updatedAt: "2026-11-11T10:00:00.000Z",
    state: { id: "state-1", name: "Todo", type: "unstarted", position: 1 },
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    project: { id: "lp-1", name: "Website" },
    labels: { nodes: [{ id: "label-1", name: "bug" }] },
    ...overrides,
  };
}

async function boardContext() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-linear-boards-"));
  directories.push(dataDir);
  const real = new StorageService(dataDir);
  services.push(real);
  await real.init();
  const { context } = createContext(createEnvironment());
  const projects = [
    { id: "p1", name: "Web", gitUrl: "https://github.com/acme/web.git" },
    { id: "p2", name: "Api", gitUrl: "git@github.com:acme/api.git" },
  ];
  Object.assign(context.storage, {
    linear: real.linear,
    getProject: mock(async (id: string) => projects.find((project) => project.id === id) ?? null),
    loadProjects: mock(async () => projects),
  });
  Object.assign(context.storage.kanban, {
    getLinearAuth: mock(async () => ({
      apiKey: "lin_api_secret",
      connectedAt: "2026-11-11T00:00:00Z",
    })),
  });
  return { context, commands: createCommandRegistry(), real };
}

describe("Linear board helpers", () => {
  test("a key's fingerprint is short, stable and not the key", () => {
    const fingerprint = linearKeyFingerprint(" lin_api_secret ");
    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(fingerprint).toBe(linearKeyFingerprint("lin_api_secret"));
    expect(fingerprint).not.toBe(linearKeyFingerprint("lin_api_other"));
  });

  test("a board filters by team, and by project when it names one", () => {
    expect(linearBoardIssueFilter(undefined)).toBeUndefined();
    expect(linearBoardIssueFilter({ teamId: "t1" })).toEqual({ team: { id: { eq: "t1" } } });
    expect(linearBoardIssueFilter({ teamId: "t1", linearProjectId: "lp" })).toEqual({
      team: { id: { eq: "t1" } },
      project: { id: { eq: "lp" } },
    });
    expect(issueIsOnBoard({ id: "i", teamId: "t1" }, { teamId: "t1" })).toBe(true);
    expect(issueIsOnBoard({ id: "i", teamId: "t1" }, { teamId: "t1", linearProjectId: "lp" })).toBe(
      false,
    );
    expect(issueIsOnBoard({ id: "i", teamId: "t2", projectId: "lp" }, { teamId: "t1" })).toBe(
      false,
    );
  });

  test("an update sends only the fields given, and null clears", () => {
    expect(linearIssueUpdateFields({})).toEqual({});
    expect(
      linearIssueUpdateFields({
        title: " New ",
        assigneeId: null,
        estimate: null,
        addedLabelIds: [],
      }),
    ).toEqual({ title: "New", assigneeId: null, estimate: null });
  });
});

describe("Linear board commands", () => {
  test("links a project to a team and project by repository, then lists only that board", async () => {
    const { context, commands } = await boardContext();
    const requests = fakeLinear({
      OrkestratorLinearTeam: () => ({ team: TEAM }),
      OrkestratorLinearIssues: () => ({
        issues: { nodes: [issueNode()], pageInfo: { hasNextPage: false } },
      }),
    });

    await expect(commands.get("get_linear_issues")?.({ projectId: "p1" }, context)).rejects.toThrow(
      'Project "Web" has no Linear board linked',
    );

    const link = await commands.get("set_linear_board_link")?.(
      { projectId: "p1", teamId: "team-1", linearProjectId: "lp-1" },
      context,
    );
    expect(link).toMatchObject({
      key: "repo:github.com/acme/web",
      repositoryHint: "github.com/acme/web",
      teamId: "team-1",
      teamKey: "ENG",
      linearProjectId: "lp-1",
      linearProjectName: "Website",
    });
    await expect(
      commands.get("get_linear_board_link")?.({ projectId: "p1" }, context),
    ).resolves.toMatchObject({ link: { teamId: "team-1" } });

    await expect(
      commands.get("get_linear_issues")?.({ projectId: "p1" }, context),
    ).resolves.toMatchObject([{ identifier: "ENG-1" }]);
    expect(requests.at(-1)?.variables.filter).toEqual({
      team: { id: { eq: "team-1" } },
      project: { id: { eq: "lp-1" } },
    });

    // A second project of this machine cannot take the same board.
    await expect(
      commands.get("set_linear_board_link")?.({ projectId: "p2", teamId: "team-1" }, context),
    ).rejects.toThrow('already linked to project "Web"');

    await expect(
      commands.get("clear_linear_board_link")?.({ projectId: "p1" }, context),
    ).resolves.toEqual({ cleared: true });
    await expect(
      commands.get("get_linear_board_link")?.({ projectId: "p1" }, context),
    ).resolves.toEqual({});
  });

  test("refuses a project in another team", async () => {
    const { context, commands } = await boardContext();
    fakeLinear({ OrkestratorLinearTeam: () => ({ team: TEAM }) });
    await expect(
      commands.get("set_linear_board_link")?.(
        { projectId: "p1", teamId: "team-1", linearProjectId: "lp-elsewhere" },
        context,
      ),
    ).rejects.toThrow("That Linear project is not in the Engineering team.");
  });

  test("refuses reads and writes of an issue on another board", async () => {
    const { context, commands, real } = await boardContext();
    real.linear.saveLinearBoardLink(
      { key: "repo:github.com/acme/web", teamId: "team-1", teamKey: "ENG" },
      new Set(["repo:github.com/acme/web"]),
    );
    const requests = fakeLinear({
      OrkestratorLinearIssueBoard: () => ({
        issue: { id: "issue-9", identifier: "OPS-9", team: { id: "team-ops" } },
      }),
    });
    const refusal = "Linear issue OPS-9 is not on this project's Linear board (ENG).";
    await expect(
      commands.get("get_linear_issue")?.({ issueId: "OPS-9", projectId: "p1" }, context),
    ).rejects.toThrow(refusal);
    await expect(
      commands.get("update_linear_issue")?.(
        { projectId: "p1", issueId: "OPS-9", title: "Changed" },
        context,
      ),
    ).rejects.toThrow(refusal);
    await expect(
      commands.get("post_linear_issue_comment")?.(
        { projectId: "p1", issueId: "OPS-9", body: "hi" },
        context,
      ),
    ).rejects.toThrow(refusal);
    // Nothing was written to Linear.
    expect(requests.every((request) => !request.query.includes("mutation"))).toBe(true);
  });

  test("creates an issue on the board once per request key", async () => {
    const { context, commands, real } = await boardContext();
    real.linear.saveLinearBoardLink(
      { key: "repo:github.com/acme/web", teamId: "team-1", linearProjectId: "lp-1" },
      new Set(["repo:github.com/acme/web"]),
    );
    let creates = 0;
    const requests = fakeLinear({
      OrkestratorLinearIssueCreate: (variables) => {
        creates += 1;
        expect(variables.input).toEqual({
          teamId: "team-1",
          projectId: "lp-1",
          title: "New issue",
          priority: 2,
          labelIds: ["label-1"],
        });
        return { issueCreate: { success: true, issue: issueNode({ id: "issue-new" }) } };
      },
      OrkestratorLinearIssueWithIds: () => ({ issue: issueNode({ id: "issue-new" }) }),
    });
    const args = {
      projectId: "p1",
      requestKey: "req-1",
      title: " New issue ",
      priority: 2,
      labelIds: ["label-1"],
    };
    const first = await commands.get("create_linear_issue")?.(args, context);
    expect(first).toMatchObject({
      id: "issue-new",
      teamId: "team-1",
      stateId: "state-1",
      labelIds: ["label-1"],
    });
    await expect(commands.get("create_linear_issue")?.(args, context)).resolves.toMatchObject({
      id: "issue-new",
    });
    expect(creates).toBe(1);
    expect(
      requests.map((request) => /(?:query|mutation)\s+(\w+)/.exec(request.query)?.[1]),
    ).toEqual(["OrkestratorLinearIssueCreate", "OrkestratorLinearIssueWithIds"]);
  });

  test("updates an issue on the board with only the fields given", async () => {
    const { context, commands, real } = await boardContext();
    real.linear.saveLinearBoardLink(
      { key: "repo:github.com/acme/web", teamId: "team-1" },
      new Set(["repo:github.com/acme/web"]),
    );
    fakeLinear({
      OrkestratorLinearIssueBoard: () => ({
        issue: { id: "issue-1", identifier: "ENG-1", team: { id: "team-1" } },
      }),
      OrkestratorLinearIssueUpdate: (variables) => {
        expect(variables).toEqual({
          id: "ENG-1",
          input: { stateId: "state-2", assigneeId: null, removedLabelIds: ["label-1"] },
        });
        return {
          issueUpdate: {
            success: true,
            issue: issueNode({ state: { id: "state-2", name: "Done", type: "completed" } }),
          },
        };
      },
    });
    await expect(
      commands.get("update_linear_issue")?.(
        {
          projectId: "p1",
          issueId: "ENG-1",
          stateId: "state-2",
          assigneeId: null,
          removedLabelIds: ["label-1"],
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "Done", stateId: "state-2" });
  });

  test("Linear errors never carry the key", async () => {
    const { context, commands } = await boardContext();
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "bad token lin_api_secret" }] }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const error = await Promise.resolve(commands.get("get_linear_teams")?.({}, context)).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).not.toContain("lin_api_secret");
  });
});

describe("Linear sync link commands", () => {
  test("refuse a caller that is not an attached command node, so the key is never handed out", async () => {
    const { context, commands } = await boardContext();
    const controllerId = "0123456789abcdef0123456789abcdef";
    Object.assign(context, {
      nodes: { listControllers: () => [{ controllerId: "fedcba9876543210fedcba9876543210" }] },
    });
    for (const name of [
      "export_linear_connection",
      "get_linear_sync_state",
      "apply_linear_sync_state",
    ]) {
      await expect(
        Promise.resolve(commands.get(name)?.({ controllerId }, context)),
      ).rejects.toThrow();
    }
  });

  test("hand the key only to the attached command node that asks", async () => {
    const { context, commands } = await boardContext();
    const controllerId = "0123456789abcdef0123456789abcdef";
    Object.assign(context, { nodes: { listControllers: () => [{ controllerId }] } });
    await expect(
      commands.get("export_linear_connection")?.({ controllerId }, context),
    ).resolves.toEqual({ apiKey: "lin_api_secret" });
    const state = await commands.get("get_linear_sync_state")?.({ controllerId }, context);
    expect(state).toMatchObject({ connection: { connected: true } });
    expect(JSON.stringify(state)).not.toContain("lin_api_secret");
  });
});
