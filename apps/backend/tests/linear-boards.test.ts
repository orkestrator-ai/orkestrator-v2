import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getLinearBoardOptions,
  getLinearTeam,
  issueIsOnBoard,
  listLinearTeams,
  linearIssueCreateId,
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

/**
 * Answers Linear GraphQL calls by operation name, recording each request. A
 * handler may answer later (a promise), and one that throws answers as a
 * GraphQL error, the way Linear refuses a request.
 */
function fakeLinear(handlers: Record<string, (variables: Record<string, unknown>) => unknown>) {
  const requests: GraphqlRequest[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as GraphqlRequest;
    requests.push(request);
    const name = /(?:query|mutation)\s+(\w+)/.exec(request.query)?.[1] ?? "";
    const handler = handlers[name];
    if (!handler) throw new Error(`Unexpected Linear operation ${name}`);
    let body: unknown;
    try {
      body = { data: await handler(request.variables) };
    } catch (error) {
      body = { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return requests;
}

const operations = (requests: GraphqlRequest[]) =>
  requests.map((request) => /(?:query|mutation)\s+(\w+)/.exec(request.query)?.[1]);

/**
 * A Linear that keeps the issues `issueCreate` made, by id, and refuses an
 * id it already has, as Linear's uniqueness check does.
 */
function linearWithIssueStore(options: { holdCreate?: Promise<void> } = {}) {
  const issues = new Map<string, Record<string, unknown>>();
  let creates = 0;
  const requests = fakeLinear({
    OrkestratorLinearIssueCreate: async (variables) => {
      creates += 1;
      const input = variables.input as { id?: string; title: string };
      if (!input.id) throw new Error("expected a client id");
      if (issues.has(input.id)) throw new Error("Entity already exists");
      const issue = issueNode({ id: input.id, title: input.title });
      issues.set(input.id, issue);
      await options.holdCreate;
      return { issueCreate: { success: true, issue } };
    },
    OrkestratorLinearIssueBoard: (variables) => {
      const issue = issues.get(String(variables.id));
      return { issue: issue ? { id: issue.id, team: { id: "team-1" } } : null };
    },
    OrkestratorLinearIssueWithIds: (variables) => ({
      issue: issues.get(String(variables.id)) ?? null,
    }),
  });
  return { issues, requests, creates: () => creates };
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

/** The most a single Linear query may score before Linear refuses it. */
const LINEAR_MAX_QUERY_COMPLEXITY = 10_000;

/**
 * Scores a query the way Linear documents
 * (https://linear.app/developers/rate-limiting): a field is 0.1 point, an
 * object 1 point, and a connection (a selection with `nodes`) multiplies its
 * children by its `first` argument, or 50 without one. It errs high:
 * `pageInfo` is charged once per node. Fragments and aliases are not handled;
 * these queries use neither.
 */
function linearQueryComplexity(query: string): number {
  const tokens = query.slice(query.indexOf("{")).match(/[{}()]|[^\s{}()]+/g) ?? [];
  let index = 0;
  const selection = (): { points: number; connection: boolean } => {
    let points = 0;
    let connection = false;
    index += 1; // "{"
    while (index < tokens.length && tokens[index] !== "}") {
      if (tokens[index] === "nodes") connection = true;
      index += 1; // the field name
      let args = "";
      if (tokens[index] === "(") {
        for (let depth = 0; index < tokens.length; index += 1) {
          if (tokens[index] === "(") depth += 1;
          else if (tokens[index] === ")" && --depth === 0) break;
          args += ` ${tokens[index]}`;
        }
        index += 1; // ")"
      }
      if (tokens[index] !== "{") {
        points += 0.1;
        continue;
      }
      const child = selection();
      const pageSize = Number(/first:\s*(\d+)/.exec(args)?.[1] ?? 50);
      points += child.connection ? pageSize * child.points : 1 + child.points;
    }
    index += 1; // "}"
    return { points, connection };
  };
  return Math.ceil(selection().points);
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

  test("scores queries the way Linear's documentation does", () => {
    const query = `query MyCreatedIssues {
      user(id: "me") {
        createdIssues(first: 10) { nodes { id title createdAt } }
      }
    }`;
    expect(linearQueryComplexity(query)).toBe(14);
    expect(linearQueryComplexity(query.replace("(first: 10)", ""))).toBe(66);
  });

  test("the board picker's queries stay within Linear's complexity limit", async () => {
    const requests = fakeLinear({
      OrkestratorLinearTeams: () => ({
        teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
      OrkestratorLinearTeam: () => ({ team: null }),
      OrkestratorLinearBoardOptions: () => ({ team: { id: "t1" } }),
    });
    await listLinearTeams("lin_api_secret");
    await getLinearTeam("lin_api_secret", "t1");
    await getLinearBoardOptions("lin_api_secret", "t1");
    expect(operations(requests)).toEqual([
      "OrkestratorLinearTeams",
      "OrkestratorLinearTeam",
      "OrkestratorLinearBoardOptions",
    ]);
    for (const request of requests) {
      expect(linearQueryComplexity(request.query)).toBeLessThanOrEqual(LINEAR_MAX_QUERY_COMPLEXITY);
    }
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
          id: linearIssueCreateId("repo:github.com/acme/web", "req-1"),
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

  test("the id an issue is created with is a stable UUID v4 per board link and request key", () => {
    const id = linearIssueCreateId("repo:github.com/acme/web", "req-1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(linearIssueCreateId("repo:github.com/acme/web", "req-1")).toBe(id);
    expect(linearIssueCreateId("repo:github.com/acme/web", "req-2")).not.toBe(id);
    expect(linearIssueCreateId("repo:github.com/acme/api", "req-1")).not.toBe(id);
  });

  test("a retry while the first create is in flight waits for it and returns the same issue", async () => {
    const { context, commands, real } = await boardContext();
    real.linear.saveLinearBoardLink(
      { key: "repo:github.com/acme/web", teamId: "team-1" },
      new Set(["repo:github.com/acme/web"]),
    );
    let release!: () => void;
    const holdCreate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const linear = linearWithIssueStore({ holdCreate });
    const args = { projectId: "p1", requestKey: "req-concurrent", title: "Once" };
    const first = Promise.resolve(commands.get("create_linear_issue")?.(args, context));
    const second = Promise.resolve(commands.get("create_linear_issue")?.(args, context));
    await Bun.sleep(10);
    // The second call has not reached Linear while the first is held.
    expect(linear.creates()).toBe(1);
    release();
    const [a, b] = (await Promise.all([first, second])) as [{ id: string }, { id: string }];
    expect(a.id).toBe(b.id);
    expect(linear.creates()).toBe(1);
    expect(linear.issues.size).toBe(1);
    expect(operations(linear.requests)).toEqual([
      "OrkestratorLinearIssueCreate",
      "OrkestratorLinearIssueWithIds",
    ]);
  });

  test("a retry after the create's record was lost finds the issue Linear already made", async () => {
    const { context, commands, real } = await boardContext();
    real.linear.saveLinearBoardLink(
      { key: "repo:github.com/acme/web", teamId: "team-1" },
      new Set(["repo:github.com/acme/web"]),
    );
    const linear = linearWithIssueStore();
    const record = real.linear.recordLinearIssueCreate.bind(real.linear);
    let failRecord = true;
    real.linear.recordLinearIssueCreate = (entry) => {
      if (failRecord) {
        failRecord = false;
        throw new Error("disk full");
      }
      record(entry);
    };
    const args = { projectId: "p1", requestKey: "req-lost", title: "Once" };
    await expect(
      Promise.resolve(commands.get("create_linear_issue")?.(args, context)),
    ).rejects.toThrow("disk full");
    expect(linear.issues.size).toBe(1);

    const retried = (await commands.get("create_linear_issue")?.(args, context)) as { id: string };
    expect(retried.id).toBe(linearIssueCreateId("repo:github.com/acme/web", "req-lost"));
    // Linear refused the second create; nothing new was made.
    expect(linear.issues.size).toBe(1);
    expect(linear.creates()).toBe(2);
    expect(await real.linear.findLinearIssueCreate("req-lost")).toMatchObject({
      issueId: retried.id,
    });
  });

  test("a failed create whose id names no issue reports Linear's error", async () => {
    const { context, commands, real } = await boardContext();
    real.linear.saveLinearBoardLink(
      { key: "repo:github.com/acme/web", teamId: "team-1" },
      new Set(["repo:github.com/acme/web"]),
    );
    fakeLinear({
      OrkestratorLinearIssueCreate: () => {
        throw new Error("Title is too long");
      },
      OrkestratorLinearIssueBoard: () => ({ issue: null }),
    });
    await expect(
      Promise.resolve(
        commands.get("create_linear_issue")?.(
          { projectId: "p1", requestKey: "req-bad", title: "x" },
          context,
        ),
      ),
    ).rejects.toThrow("Title is too long");
    expect(await real.linear.findLinearIssueCreate("req-bad")).toBeNull();
  });

  test("a request key used for one project's issue is refused for another project", async () => {
    const { context, commands, real } = await boardContext();
    real.linear.saveLinearBoardLink(
      { key: "repo:github.com/acme/web", teamId: "team-1" },
      new Set(["repo:github.com/acme/web", "repo:github.com/acme/api"]),
    );
    real.linear.saveLinearBoardLink(
      { key: "repo:github.com/acme/api", teamId: "team-2" },
      new Set(["repo:github.com/acme/web", "repo:github.com/acme/api"]),
    );
    const linear = linearWithIssueStore();
    await commands.get("create_linear_issue")?.(
      { projectId: "p1", requestKey: "req-shared", title: "Web issue" },
      context,
    );
    await expect(
      Promise.resolve(
        commands.get("create_linear_issue")?.(
          { projectId: "p2", requestKey: "req-shared", title: "Api issue" },
          context,
        ),
      ),
    ).rejects.toThrow("That requestKey was already used for another project's issue.");
    expect(linear.creates()).toBe(1);
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

describe("copy_linear_connection_from_node", () => {
  const LEAF_KEY = "lin_api_leaf_secret";

  /** A command node with one connected leaf whose export answers `exported`. */
  async function copyContext(
    options: { mode?: "command" | "leaf"; exported?: unknown; linked?: boolean } = {},
  ) {
    const { context, commands } = await boardContext();
    const exportCalls: Array<{ name: string; args: unknown }> = [];
    const saveLinearAuth = mock(async (apiKey: string, viewer?: unknown) => ({
      apiKey,
      viewer,
      connectedAt: "2026-11-11T12:00:00.000Z",
    }));
    Object.assign(context.storage.kanban, { saveLinearAuth });
    Object.assign(context, {
      nodes: {
        mode: () => options.mode ?? "command",
        selfIdentity: async () => "command-node",
        link: (nodeId: string) =>
          options.linked === false || nodeId !== "leaf-1"
            ? null
            : {
                invokeCommand: async (def: { name: string }, args: unknown) => {
                  exportCalls.push({ name: def.name, args });
                  return options.exported ?? { apiKey: LEAF_KEY };
                },
              },
      },
    });
    return { context, commands, exportCalls, saveLinearAuth };
  }

  const copy = (
    commands: Awaited<ReturnType<typeof boardContext>>["commands"],
    context: unknown,
    nodeId: string,
  ) =>
    Promise.resolve(
      commands.get("copy_linear_connection_from_node")?.({ nodeId }, context as never),
    );

  test("only a command node copies, and only from a connected node identity", async () => {
    const leaf = await copyContext({ mode: "leaf" });
    await expect(copy(leaf.commands, leaf.context, "leaf-1")).rejects.toThrow(
      "Only a command node can copy another machine's Linear connection.",
    );
    const command = await copyContext();
    await expect(copy(command.commands, command.context, "not a node!")).rejects.toThrow(
      "Expected nodeId to be a node identity.",
    );
    await expect(copy(command.commands, command.context, "leaf-2")).rejects.toThrow(
      "That machine is not connected.",
    );
    const unlinked = await copyContext({ linked: false });
    await expect(copy(unlinked.commands, unlinked.context, "leaf-1")).rejects.toThrow(
      "That machine is not connected.",
    );
    expect(command.saveLinearAuth).not.toHaveBeenCalled();
  });

  test("a machine with no key is reported, and nothing is saved", async () => {
    for (const exported of [{}, { apiKey: "   " }]) {
      const { context, commands, saveLinearAuth } = await copyContext({ exported });
      await expect(copy(commands, context, "leaf-1")).rejects.toThrow(
        "That machine is not connected to Linear.",
      );
      expect(saveLinearAuth).not.toHaveBeenCalled();
    }
  });

  test("verifies the copied key before saving it, and never returns it", async () => {
    const { context, commands, exportCalls, saveLinearAuth } = await copyContext();
    const requests = fakeLinear({
      OrkestratorLinearViewer: () => ({ viewer: { id: "viewer-1", name: "Ada", email: "a@x" } }),
    });
    const status = await copy(commands, context, "leaf-1");
    expect(exportCalls).toEqual([
      { name: "export_linear_connection", args: { controllerId: "command-node" } },
    ]);
    expect(operations(requests)).toEqual(["OrkestratorLinearViewer"]);
    expect(saveLinearAuth).toHaveBeenCalledTimes(1);
    expect(saveLinearAuth.mock.calls[0]?.[0]).toBe(LEAF_KEY);
    expect(status).toMatchObject({
      connected: true,
      hasToken: true,
      viewer: { name: "Ada" },
      keyFingerprint: linearKeyFingerprint(LEAF_KEY),
      connectedAt: "2026-11-11T12:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toContain(LEAF_KEY);
  });

  test("a copied key Linear rejects is not saved, and the error does not carry it", async () => {
    const { context, commands, saveLinearAuth } = await copyContext();
    fakeLinear({
      OrkestratorLinearViewer: () => {
        throw new Error(`Authentication failed for ${LEAF_KEY}`);
      },
    });
    const error = await copy(commands, context, "leaf-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(LEAF_KEY);
    expect(saveLinearAuth).not.toHaveBeenCalled();
  });
});
