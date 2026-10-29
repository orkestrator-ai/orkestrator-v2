import { ensureProjectExpanded } from "./sidebar-project";
import { dismissSidebarTooltip } from "./sidebar-tooltip";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The read-only Graphs designer against the real backend (item 110): open
 * it from the action bar, view a built-in on the canvas, inspect a node,
 * import JSON (refused, then accepted with compile errors pinned to the
 * canvas), approve a project template, duplicate a built-in, and rehydrate
 * after a reload. Credential-free: no agent runs.
 */

test.use({ actionTimeout: 15_000 });

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

test("Graphs designer shows built-ins, imports JSON and pins diagnostics", async ({
  page,
}, testInfo) => {
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  const status = devJson("dev:status", profile);
  expect(status.status).toBe("ready");
  const login = devJson("dev:login", profile);
  await page.route("**/__orkestrator/invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request?.command === "check_claude_cli") await route.fulfill({ json: { result: false } });
    else await route.continue();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(login.loginUrl);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    expect(response.ok(), command).toBe(true);
    return (await response.json()).result;
  };

  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject)!;
  expect(project).toBeTruthy();

  // A project template in the fixture checkout (never this repository).
  const exported = await invoke<{ text: string }>("graph_template_export", {
    ref: { scope: "builtin", id: "multi-review" },
  });
  const projectTemplate = JSON.parse(exported.text);
  delete projectTemplate.engine;
  projectTemplate.id = "qa-project-review";
  projectTemplate.name = "QA project review";
  const graphsDirectory = join(status.testProject, ".orkestrator", "graphs");
  await mkdir(graphsDirectory, { recursive: true });
  await writeFile(
    join(graphsDirectory, "qa-project-review.graph.json"),
    JSON.stringify(projectTemplate, null, 2),
  );

  const projectPath = ".orkestrator/graphs/qa-project-review.graph.json";
  const revokeProjectTrust = () =>
    invoke("graph_template_trust", {
      projectId: project.id,
      path: projectPath,
      action: "revoke",
    }).catch(() => undefined);
  // An approval left by an earlier run on this profile would start it trusted.
  await revokeProjectTrust();

  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graphs-designer-smoke",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  const other = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graphs-designer-other",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  const created: string[] = [];
  try {
    await invoke("start_environment", { environmentId: env.id });
    await page.reload();
    await openEnvironment(page, project.name, env.name);

    // Open the designer from the action bar.
    await page.getByRole("button", { name: "Graphs", exact: true }).click();
    const designer = page.locator("[data-graph-designer]");
    await expect(designer).toBeVisible();
    await expect(page.getByText(/^Graphs \d$/)).toBeVisible();
    const library = designer.getByRole("navigation", { name: "Graph templates" });
    const builtIns = library.getByRole("region", { name: "Built-in templates" });
    await expect(builtIns.getByText("Build Pipeline", { exact: true })).toBeVisible();
    await expect(library.locator('[data-graph-engine-status="retired"]')).toHaveText(
      "Retired engine",
    );

    // View a built-in: the canvas draws its nodes and loop, and it compiles cleanly.
    await builtIns.getByText("Build Pipeline", { exact: true }).click();
    await expect(designer.locator('[data-graph-node-id="review"]')).toBeVisible();
    await expect(designer.locator("[data-graph-loop]")).toBeVisible();
    await expect(designer.locator(".react-flow__edge").first()).toBeAttached();
    await expect(designer.locator("[data-graph-compile-clean]")).toBeVisible();
    await expect(designer.locator("[data-graph-cost]")).toContainText("Sessions");
    await expect(designer.getByRole("button", { name: "Edit as JSON" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("01-built-in.png") });

    // Inspect a node by click, then move with the keyboard in topological order.
    await designer.locator('.react-flow__node[data-id="review"]').click();
    const inspector = designer.locator("[data-graph-inspector]");
    await expect(inspector.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(inspector.locator("[data-graph-enforcement-matrix]")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(inspector.getByRole("heading", { name: "Consolidate" })).toBeVisible();
    await expect(designer.locator('.react-flow__node[data-id="consolidate"]')).toBeFocused();

    // Import JSON: refused text shows the guard's errors.
    await designer.getByRole("button", { name: /Import JSON/ }).click();
    const dialog = page.getByRole("dialog", { name: "Import a graph template" });
    await dialog.getByLabel("Template JSON").fill('{"format": "orkestrator.graph"');
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("not imported");

    // Valid JSON that does not compile: diagnostics pinned to the loop.
    const pipeline = JSON.parse(
      (
        await invoke<{ text: string }>("graph_template_export", {
          ref: { scope: "builtin", id: "build-pipeline" },
        })
      ).text,
    );
    delete pipeline.engine;
    pipeline.id = "qa-too-many-rounds";
    pipeline.name = "QA too many rounds";
    // Passes the schema guard, fails the compiler: Prepare now wants a decision.
    pipeline.nodes.find((node: { id: string }) => node.id === "prepare").inputs[0].type =
      "decision@1";
    await dialog.getByLabel("Template JSON").fill(JSON.stringify(pipeline));
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toBeHidden();
    created.push("qa-too-many-rounds");
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText("QA too many rounds");
    const diagnostic = designer
      .locator('[data-graph-diagnostic="edge-type-mismatch"] button')
      .first();
    await expect(diagnostic).toBeVisible();
    await expect(designer.locator(".react-flow__edge.graph-edge-error").first()).toBeAttached();
    await expect(
      designer.locator('[data-graph-node-id="prepare"][data-graph-diagnostics]'),
    ).toBeVisible();
    await diagnostic.click();
    await expect(inspector.getByRole("heading", { name: "Edge build-prepare" })).toBeVisible();
    // Selecting the diagnostic brings both ends of the edge into view.
    const canvasBox = (await designer.locator("[data-graph-canvas]").boundingBox())!;
    for (const end of ["build", "prepare"]) {
      await expect
        .poll(async () => {
          const box = await designer.locator(`.react-flow__node[data-id="${end}"]`).boundingBox();
          return (
            box !== null &&
            box.x >= canvasBox.x &&
            box.y >= canvasBox.y &&
            box.x + box.width <= canvasBox.x + canvasBox.width &&
            box.y + box.height <= canvasBox.y + canvasBox.height
          );
        })
        .toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath("02-imported-diagnostics.png") });

    // The tab and its template come back after a reload (backend snapshots).
    await page.reload();
    await openEnvironment(page, project.name, env.name);
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText("QA too many rounds");
    await expect(
      designer.locator('[data-graph-diagnostic="edge-type-mismatch"]').first(),
    ).toBeVisible();

    // Switching to another environment and back keeps the tab and its template.
    await dismissSidebarTooltip(page, project.name);
    await page.getByRole("button", { name: other.name, exact: true }).click();
    await expect(designer).toBeHidden();
    await dismissSidebarTooltip(page, project.name);
    await page.getByRole("button", { name: env.name, exact: true }).click();
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText("QA too many rounds");

    // Project templates show trust; approving pins the digest shown.
    const projectRows = library.getByRole("region", { name: "Project templates" });
    await expect(projectRows.locator('[data-graph-trust="untrusted"]')).toBeVisible();
    await projectRows.getByRole("button", { name: "Approve" }).click();
    await expect(projectRows.locator('[data-graph-trust="trusted"]')).toBeVisible();

    // Duplicate a built-in into an editable user template.
    await builtIns.getByText("Multi Review", { exact: true }).click();
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText("Multi Review");
    await designer.getByRole("button", { name: /Duplicate/ }).click();
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText("Multi Review (copy)");
    created.push("multi-review-copy");
    await designer.getByRole("button", { name: "Edit as JSON" }).click();
    await expect(designer.locator("[data-graph-json-editor] textarea")).toHaveValue(
      /"format": "orkestrator.graph"/,
    );

    // A narrow viewport stacks the panes and keeps them reachable.
    await page.setViewportSize({ width: 820, height: 1000 });
    await expect(designer.locator("[data-graph-canvas]")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("03-narrow.png") });
  } finally {
    for (const id of created) {
      await invoke("graph_template_delete", { id }).catch(() => undefined);
    }
    await revokeProjectTrust();
    await rm(join(status.testProject, ".orkestrator", "graphs"), { recursive: true, force: true });
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: other.id }).catch(() => undefined);
  }
});
