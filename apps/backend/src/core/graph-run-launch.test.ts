import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentSettingsTiers } from "@orkestrator/protocol/agent-settings";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphLaunchRequest } from "@orkestrator/protocol/graphs/launch";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphLaunchError, GraphRunLaunchService, graphLaunchRunId } from "./graph-run-launch.js";
import type { GraphRunLaunch } from "./graph-run-service.js";
import { graphEnvironmentFixture, graphRunFixture } from "./graph-run-test-support.js";
import {
  createGraphTemplateFixture,
  sampleGraphTemplate,
  type GraphTemplateFixture,
} from "./graph-template-test-support.js";
import type { Environment } from "./models.js";

const HEAD = "b".repeat(40);

let fixture: GraphTemplateFixture;
let created: GraphRunLaunch[];
let linked: Array<[string, string]>;
let tiers: AgentSettingsTiers;
let environment: Environment;
let structured: (platform: string) => boolean;

function service(): GraphRunLaunchService {
  return new GraphRunLaunchService({
    storage: fixture.storage,
    templates: fixture.service,
    runs: {
      async create(launch) {
        created.push(structuredClone(launch));
        const run = graphRunFixture({
          id: launch.id ?? `run-${created.length}`,
          projectId: launch.projectId,
          environmentId: launch.environmentId,
          status: launch.environmentId ? "running" : "provisioning",
        });
        return { ...run, plan: launch.plan, template: launch.template, launch: launch.launch };
      },
      async get() {
        return null;
      },
    },
    settingsTiers: async () => tiers,
    structuredResults: (platform) => structured(platform),
    workspaceHead: async (target) => ({ branch: target.branch, headRef: HEAD }),
    linkTicket: async (taskId, environmentId) => {
      linked.push([taskId, environmentId]);
    },
    host: () => ({ claudeSandbox: true }),
    clock: () => new Date("2026-10-29T12:00:00.000Z"),
  });
}

async function rejection(promise: Promise<unknown>): Promise<GraphLaunchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GraphLaunchError);
    return error as GraphLaunchError;
  }
  throw new Error("Expected a GraphLaunchError");
}

function request(overrides: Partial<GraphLaunchRequest> = {}): GraphLaunchRequest {
  return {
    ref: { scope: "user", id: "sample-review" },
    projectId: fixture.projectId,
    environment: { kind: "existing", environmentId: environment.id },
    ...overrides,
  };
}

/** The §9.2 loop under a user id: a ticket input, and it creates a worktree. */
function ticketTemplate(): GraphTemplateV1 {
  return { ...graphTemplateExample("build-pipeline-loop"), id: "ticket-loop", revision: 0 };
}

beforeEach(async () => {
  fixture = await createGraphTemplateFixture({
    builtins: () => [{ ...sampleGraphTemplate("engine-review"), engine: "multi-review" }],
  });
  created = [];
  linked = [];
  structured = () => true;
  tiers = {
    global: {
      defaultAgent: "codex",
      actionDefaults: {
        review: { platform: "claude", model: "opus" },
        reviewPreparation: { platform: "codex" },
      },
      multiReview: {
        reviewerCount: 3,
        additionalReviewers: [null],
        reviewerLenses: [{ label: "Security", instruction: "Look for injection." }, null, null],
      },
    },
  };
  environment = graphEnvironmentFixture({
    id: "env-1",
    projectId: fixture.projectId,
    branch: "feature/csv",
  });
  await fixture.storage.addEnvironment(environment);
  const config = await fixture.storage.loadConfig();
  await fixture.storage.saveConfig({
    ...config,
    global: {
      ...config.global,
      enabledAgentPlatforms: ["claude", "codex", "opencode", "cursor", "grok", "pi"],
    },
  });
  await fixture.service.save(sampleGraphTemplate("sample-review"));
});

afterEach(async () => {
  await fixture.close();
});

describe("refusals before anything runs", () => {
  test("an untrusted project template is refused", async () => {
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("repo-review"));
    const error = await rejection(
      service().launch(
        request({
          ref: {
            scope: "project",
            projectId: fixture.projectId,
            path: ".orkestrator/graphs/review.graph.json",
          },
        }),
        { requestedBy: "user" },
      ),
    );
    expect(error.code).toBe("untrusted");
    expect(created).toEqual([]);
  });

  test("a built-in that runs on its own engine is refused", async () => {
    const error = await rejection(
      service().launch(request({ ref: { scope: "builtin", id: "engine-review" } }), {
        requestedBy: "coordinator",
      }),
    );
    expect(error.code).toBe("engine-template");
  });

  test("a missing template, environment or ticket is not-found", async () => {
    expect(
      (
        await rejection(
          service().launch(request({ ref: { scope: "user", id: "nope" } }), { requestedBy: "cli" }),
        )
      ).code,
    ).toBe("not-found");
    expect(
      (
        await rejection(
          service().launch(
            request({ environment: { kind: "existing", environmentId: "missing" } }),
            { requestedBy: "cli" },
          ),
        )
      ).code,
    ).toBe("not-found");
  });
});

describe("role bindings", () => {
  test("defaults follow item 108's reading, with the saved reviewer lenses on the panel", async () => {
    const result = await service().launch(request(), { requestedBy: "user" });
    expect(result).toMatchObject({ environmentId: "env-1", repeated: false, status: "running" });
    const roles = created[0]!.roles;
    expect(roles.preparer).toEqual({ platform: "codex" });
    // review → claude/opus; review2 unset → the first key's; additionalReviewers[0] null → the first key's.
    expect(roles.reviewer).toEqual([
      {
        platform: "claude",
        model: "opus",
        lens: { label: "Security", instruction: "Look for injection." },
      },
      { platform: "claude", model: "opus" },
      { platform: "claude", model: "opus" },
    ]);
    // fixReviewIssues and pr unset → the app's default agent.
    expect(roles.fixer).toEqual({ platform: "codex" });
    expect(roles.describer).toEqual({ platform: "codex" });
    expect(created[0]!.launch).toEqual({ requestedBy: "user" });
    expect(created[0]!.template).toMatchObject({ id: "sample-review", scope: "user" });
  });

  test("a provider below a node's floor is refused, and options say why it is not offered", async () => {
    const options = await service().options({
      ref: { scope: "user", id: "sample-review" },
      projectId: fixture.projectId,
      environmentId: environment.id,
    });
    const reviewer = options.roles.find((role) => role.role.key === "reviewer")!;
    expect(reviewer.panel).toBe(true);
    const grok = reviewer.providers.find((provider) => provider.platform === "grok")!;
    expect(grok.available).toBe(false);
    expect(grok.unavailableReason).toContain("below its floor (provider-configured)");
    expect(reviewer.providers.find((provider) => provider.platform === "claude")!.available).toBe(
      true,
    );
    const error = await rejection(
      service().launch(request({ roles: { reviewer: [{ platform: "grok" }] } }), {
        requestedBy: "user",
      }),
    );
    expect(error.code).toBe("invalid-binding");
    expect(error.message).toContain("grok");
  });

  test("a provider that cannot return typed results is neither offered nor accepted", async () => {
    structured = (platform) => platform !== "pi";
    const options = await service().options({
      ref: { scope: "user", id: "sample-review" },
      projectId: fixture.projectId,
    });
    const preparer = options.roles.find((role) => role.role.key === "preparer")!;
    expect(preparer.providers.find((provider) => provider.platform === "pi")).toMatchObject({
      structuredResults: false,
      available: false,
    });
    const error = await rejection(
      service().launch(request({ roles: { preparer: { platform: "pi" } } }), {
        requestedBy: "user",
      }),
    );
    expect(error.code).toBe("invalid-binding");
  });

  test("panel sizes, list shapes and unknown roles are checked", async () => {
    const codes = await Promise.all([
      rejection(
        service().launch(request({ roles: { preparer: [{ platform: "claude" }] } }), {
          requestedBy: "user",
        }),
      ),
      rejection(
        service().launch(
          request({
            roles: {
              reviewer: Array.from({ length: 33 }, () => ({ platform: "claude" as const })),
            },
          }),
          { requestedBy: "user" },
        ),
      ),
      rejection(
        service().launch(request({ roles: { ghost: { platform: "claude" } } }), {
          requestedBy: "user",
        }),
      ),
    ]);
    expect(codes.map((error) => error.code)).toEqual([
      "invalid-binding",
      "invalid-binding",
      "invalid-binding",
    ]);
  });

  test("a disabled provider is refused", async () => {
    const config = await fixture.storage.loadConfig();
    await fixture.storage.saveConfig({
      ...config,
      global: { ...config.global, enabledAgentPlatforms: ["claude", "codex"] },
    });
    const error = await rejection(
      service().launch(request({ roles: { fixer: { platform: "opencode" } } }), {
        requestedBy: "user",
      }),
    );
    expect(error.code).toBe("invalid-binding");
  });
});

describe("parameters, inputs and defaults", () => {
  test("parameters are checked against their declarations", async () => {
    const error = await rejection(
      service().launch(request({ params: { autoFix: "yes" } }), { requestedBy: "user" }),
    );
    expect(error.code).toBe("invalid-launch");
    await service().launch(request({ params: { autoPr: true } }), { requestedBy: "user" });
    expect(created[0]!.params).toEqual({ autoFix: true, autoPr: true });
  });

  test("the workspace input is filled from the existing environment's HEAD", async () => {
    await service().launch(request(), { requestedBy: "user" });
    expect(created[0]!.inputs).toEqual({
      target: { branch: "feature/csv", headRef: HEAD, baseRef: null },
    });
  });

  test("defaults are saved per template per project and restored", async () => {
    await service().launch(
      request({
        roles: { reviewer: [{ platform: "codex" }, { platform: "opencode", model: "big" }] },
        params: { autoFix: false },
        saveDefaults: true,
      }),
      { requestedBy: "user" },
    );
    const options = await service().options({
      ref: { scope: "user", id: "sample-review" },
      projectId: fixture.projectId,
    });
    expect(options.saved?.environment).toBe("existing");
    expect(options.roles.find((role) => role.role.key === "reviewer")!.default).toEqual([
      { platform: "codex" },
      { platform: "opencode", model: "big" },
    ]);
    expect(options.params).toEqual({ autoFix: false, autoPr: false });
    expect(options.environment.default).toBe("existing");
    // A later launch without bindings starts from them.
    await service().launch(request(), { requestedBy: "cli" });
    expect(created[1]!.roles.reviewer).toEqual([
      { platform: "codex" },
      { platform: "opencode", model: "big" },
    ]);
    expect(created[1]!.params?.autoFix).toBe(false);
  });
});

describe("tickets and environments", () => {
  test("a Kanban ticket becomes the ticket@1 input and is linked to the existing environment", async () => {
    await fixture.service.save(ticketTemplate());
    const task = await fixture.storage.kanban.addKanbanTask(
      fixture.projectId,
      "Add CSV export",
      "Users want CSV.",
      { acceptanceCriteria: "- Exports every row\n- Has a header" },
    );
    await service().launch(
      request({ ref: { scope: "user", id: "ticket-loop" }, ticket: { taskId: task.id } }),
      { requestedBy: "user" },
    );
    const ticket = created[0]!.inputs!.ticket as {
      title: string;
      criteria: Array<{ id: string; text: string }>;
    };
    expect(ticket.title).toBe("Add CSV export");
    expect(ticket.criteria.map((criterion) => criterion.text)).toEqual([
      "Exports every row",
      "Has a header",
    ]);
    expect(created[0]!.launch).toEqual({ requestedBy: "user", ticket: { taskId: task.id } });
    expect(linked).toEqual([[task.id, "env-1"]]);
  });

  test("a new environment leaves the run to the provisioner: no environment id, the kind on the run", async () => {
    await fixture.service.save(ticketTemplate());
    const task = await fixture.storage.kanban.addKanbanTask(fixture.projectId, "T", "D");
    const result = await service().launch(
      request({
        ref: { scope: "user", id: "ticket-loop" },
        environment: { kind: "new", create: "container" },
        ticket: { taskId: task.id },
      }),
      { requestedBy: "coordinator" },
    );
    expect(result.status).toBe("provisioning");
    expect(created[0]!.environmentId).toBeUndefined();
    expect(created[0]!.launch).toEqual({
      requestedBy: "coordinator",
      create: "container",
      ticket: { taskId: task.id },
    });
    // The workspace input waits for the new environment's HEAD; the ticket link too.
    expect(created[0]!.inputs!.target).toBeUndefined();
    expect(linked).toEqual([]);
    // Compiled for a restricted container, not the design-time default.
    expect(created[0]!.plan.context.environment.networkAccess).not.toBe("full");
  });

  test("a ticket from another project is not-found", async () => {
    await fixture.service.save(ticketTemplate());
    const error = await rejection(
      service().launch(
        request({ ref: { scope: "user", id: "ticket-loop" }, ticket: { taskId: "nope" } }),
        { requestedBy: "user" },
      ),
    );
    expect(error.code).toBe("not-found");
  });
});

describe("idempotency", () => {
  test("a repeated requestId returns the run it launched; a different intent conflicts", async () => {
    const runs = new Map<string, GraphRun>();
    const launches = new GraphRunLaunchService({
      storage: {
        ...fixture.storage,
        getProject: (id) => fixture.storage.getProject(id),
        getEnvironment: (id) => fixture.storage.getEnvironment(id),
        loadConfig: () => fixture.storage.loadConfig(),
        kanban: fixture.storage.kanban,
        graphTemplates: fixture.storage.graphTemplates,
        graphRuns: {
          getGraphRun: async (id) => runs.get(id) ?? null,
          listAllGraphRuns: async () => [...runs.values()],
          deleteEnvironmentlessGraphRuns: async () => [],
        },
      },
      templates: fixture.service,
      runs: {
        async create(launch) {
          const run = {
            ...graphRunFixture({ id: launch.id!, projectId: launch.projectId }),
            environmentId: launch.environmentId,
            plan: launch.plan,
            template: launch.template,
          };
          runs.set(run.id, run);
          return run;
        },
        async get(id) {
          return runs.get(id) ?? null;
        },
      },
      settingsTiers: async () => tiers,
      workspaceHead: async () => ({ branch: "main", headRef: HEAD }),
      linkTicket: async () => undefined,
    });
    const first = await launches.launch(request({ requestId: "key-1" }), { requestedBy: "cli" });
    expect(first.runId).toBe(graphLaunchRunId(fixture.projectId, "key-1"));
    const again = await launches.launch(request({ requestId: "key-1" }), { requestedBy: "cli" });
    expect(again).toMatchObject({ runId: first.runId, repeated: true });
    expect(runs.size).toBe(1);
    const other = await rejection(
      launches.launch(
        request({ requestId: "key-1", environment: { kind: "new", create: "worktree" } }),
        { requestedBy: "cli" },
      ),
    );
    expect(other.code).toBe("conflict");
  });
});

describe("runs that ended without an environment", () => {
  test("the sweep keeps 20 per project and none older than 7 days, and never touches others", async () => {
    const at = (days: number) =>
      new Date(Date.parse("2026-10-29T12:00:00.000Z") - days * 86_400_000).toISOString();
    const make = (id: string, days: number, overrides: Partial<GraphRun> = {}) =>
      graphRunFixture({
        id,
        environmentId: undefined,
        status: "failed",
        error: "Environment provisioning failed",
        errorCause: "system-error",
        createdAt: at(days),
        updatedAt: at(days),
        finishedAt: at(days),
        ...overrides,
      });
    const old = make("old", 8);
    const recent = Array.from({ length: 21 }, (_, index) => make(`recent-${index}`, index * 0.01));
    const running = make("still-provisioning", 9, {
      status: "provisioning",
      finishedAt: undefined,
    });
    const withEnvironment = make("with-env", 30, { environmentId: "env-1" });
    for (const run of [old, ...recent, running, withEnvironment]) {
      await fixture.storage.graphRuns.createGraphRun(run);
    }
    const removed = await service().sweep();
    expect(removed).toBe(2);
    const left = (await fixture.storage.graphRuns.listAllGraphRuns()).map((run) => run.id);
    expect(left).not.toContain("old");
    expect(left).not.toContain("recent-20");
    expect(left).toContain("recent-19");
    expect(left).toContain("still-provisioning");
    expect(left).toContain("with-env");
  });
});
