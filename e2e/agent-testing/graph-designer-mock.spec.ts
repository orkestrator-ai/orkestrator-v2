import { ensureProjectExpanded } from "./sidebar-project";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { enableExperimentalGraphs } from "./experimental-graphs";

/**
 * Mock runs from the Graphs designer against the real backend (item 213):
 * open a saved graph (report §9.3 with Build feeding the pull request instead
 * of the Multi Review sub-graph), pin the human approval in the inspector's
 * Mock run section, press "Mock run" (the draft is saved first), and read
 * back what the run did: the PR node recorded "would have run" and nothing
 * was opened. Credential-free: no agent runs, no provider session starts.
 */

test.use({ actionTimeout: 15_000 });

const TEMPLATE_ID = "qa-mock-bake-off";

function devJson(command: string, profile: string) {
  return JSON.parse(
    spawnSync("mise", ["run", command, "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
}

async function openEnvironment(page: Page, projectName: string, environmentName: string) {
  await ensureProjectExpanded(page, projectName);
  await page.getByText(environmentName, { exact: true }).first().click();
}

/** §9.3 without its sub-graph (Phase 4), as the Phase 2 exit criteria run it. */
function bakeOff(): GraphTemplateV1 {
  const template = graphTemplateExample("design-bake-off");
  template.id = TEMPLATE_ID;
  template.name = "QA mock bake-off";
  template.revision = 0;
  template.nodes = template.nodes.filter((node) => node.id !== "review");
  template.edges = template.edges.filter(
    (edge) => !["build-review", "review-describe", "review-pr"].includes(edge.id),
  );
  template.edges.push(
    {
      id: "build-describe",
      from: { node: "build", port: "code" },
      to: { node: "describe-pr", port: "code" },
    },
    { id: "build-pr", from: { node: "build", port: "code" }, to: { node: "pr", port: "code" } },
  );
  template.roles = template.roles.filter(
    (role) => !["preparer", "reviewer", "consolidator"].includes(role.key),
  );
  delete template.layout;
  return template;
}

test("Graphs designer starts a mock run: no provider, no pull request, would-have-run records", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  const status = devJson("dev:status", profile);
  expect(status.status).toBe("ready");
  const login = devJson("dev:login", profile);
  await page.route("**/__orkestrator/invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request?.command === "check_claude_cli") await route.fulfill({ json: { result: false } });
    else await route.continue();
  });
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.goto(login.loginUrl);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    expect(response.ok(), command).toBe(true);
    return (await response.json()).result;
  };
  await enableExperimentalGraphs(invoke);
  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  await invoke("graph_template_delete", { id: TEMPLATE_ID }).catch(() => undefined);
  await invoke("graph_template_save", { template: bakeOff(), projectId: project.id });

  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graphs-mock-smoke",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: env.id });
    await page.reload();
    await openEnvironment(page, project.name, env.name);
    await page.getByRole("button", { name: "Graphs", exact: true }).click();
    const designer = page.locator("[data-graph-designer]");
    await expect(designer).toBeVisible();
    await designer.getByText("QA mock bake-off", { exact: true }).click();
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText("QA mock bake-off");

    // ---- Pin the approval: approve (by itself) on the first run.
    await designer.getByRole("button", { name: "Edit", exact: true }).click();
    await designer.locator('.react-flow__node[data-id="approve"]').click();
    const inspector = designer.locator("[data-graph-inspector]");
    const section = inspector.getByRole("region", { name: "Mock run" });
    await section.getByRole("button", { name: /Add run/ }).click();
    await section.getByLabel("Run 1", { exact: true }).selectOption("outlet");
    await section.getByLabel("Outlet", { exact: true }).selectOption("approved");
    await expect(designer.locator('[data-graph-draft-state="dirty"]')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("01-mock-pins.png") });

    // ---- Mock run: the draft is saved first, then the run starts.
    const launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/__orkestrator/invoke") &&
        response.request().postDataJSON()?.command === "graph_run_mock",
    );
    await designer.getByRole("button", { name: /Mock run/ }).click();
    const response = await launched;
    expect(response.ok()).toBe(true);
    const result = (await response.json()).result as {
      run: { id: string; mock: boolean; environmentId?: string };
      pins: Record<string, unknown> | null;
      placeholderRoles: string[];
    };
    expect(result.run.mock).toBe(true);
    expect(result.run.environmentId).toBeUndefined();
    expect(result.pins).toEqual({ approve: [{ outlet: "approved" }] });
    await expect(page.getByText("Mock run started")).toBeVisible();
    await expect(designer.locator('[data-graph-draft-state="saved"]')).toBeVisible();
    const stored = await invoke<{ template: GraphTemplateV1 }>("graph_template_get", {
      ref: { scope: "user", id: TEMPLATE_ID },
    });
    expect(stored.template.mockPins).toEqual({ approve: [{ outlet: "approved" }] });
    await page.screenshot({ path: testInfo.outputPath("02-mock-started.png") });

    // ---- The run reached the PR node, which recorded what it would have done.
    type Effect = { nodeId: string; state: string; data?: { wouldRun?: { action: string } } };
    await expect
      .poll(
        async () =>
          (
            await invoke<{ effects: Effect[] }>("graph_run_effects", { runId: result.run.id })
          ).effects.map(
            (effect) => `${effect.nodeId}:${effect.state}:${effect.data?.wouldRun?.action}`,
          ),
        { timeout: 120_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toContain("pr:simulated:open-pull-request");
    // Nothing was opened on the environment.
    const environment = (
      await invoke<Array<{ id: string; prUrl: string | null }>>("get_environments", {
        projectId: project.id,
      })
    ).find((candidate) => candidate.id === env.id);
    expect(environment?.prUrl ?? null).toBeNull();
  } finally {
    await invoke("graph_template_delete", { id: TEMPLATE_ID }).catch(() => undefined);
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
  }
});
