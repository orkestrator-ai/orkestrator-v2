import { ensureProjectExpanded } from "./sidebar-project";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { enableExperimentalGraphs } from "./experimental-graphs";

/**
 * The editable Graphs designer against the real backend (item 212): build
 * the report's design bake-off (§9.3, with Build feeding the pull request
 * instead of the Multi Review sub-graph) from a blank canvas, using the
 * palette, drag connections (only compatible handles light up), the
 * keyboard "Connect to…" dialog, the forms (custom type from an example,
 * lenses, capabilities, prompts), undo and redo, acknowledge the taint
 * warnings, compile clean, save, reload and see it rehydrate.
 * Credential-free: no agent runs.
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

const DESIGN_BRIEF_EXAMPLE = {
  summary: "Stream the export as CSV from the reports endpoint.",
  approach: "Add an export route that streams rows; add an Export CSV button.",
  risks: ["Large reports may time out."],
  filesTouched: ["src/reports/export.ts"],
};

test("Graphs designer builds the design bake-off on the canvas, compiles it clean and saves it", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
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
  // Templates left by an earlier run on this profile would collide.
  await invoke("graph_template_delete", { id: "qa-bake-off" }).catch(() => undefined);
  await invoke("graph_template_delete", { id: "qa-bake-off-copy" }).catch(() => undefined);

  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graphs-editor-smoke",
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

    const canvas = designer.locator("[data-graph-canvas]");
    const inspector = designer.locator("[data-graph-inspector]");
    const palette = designer.locator("[data-graph-palette]");
    const node = (id: string) => designer.locator(`.react-flow__node[data-id="${id}"]`);
    const handle = (id: string, port: string) =>
      node(id).locator(`[data-graph-port="${port}"] .react-flow__handle`);
    const draftEdgeCount = async () => designer.locator(".react-flow__edge").count();

    /** Commits a field that validates on Enter (ids, keys, numbers). */
    const commit = async (field: Locator, value: string) => {
      await field.fill(value);
      await field.press("Enter");
    };
    const portCard = (port: string) =>
      inspector.locator(`[data-graph-port-editor="${port}"]`).locator("..");
    const tab = (name: string) => inspector.getByRole("tab", { name }).click();
    /** Adds a node from the palette and gives it its id (it opens selected). */
    const add = async (button: RegExp, id: string, label: string) => {
      await palette.getByRole("button", { name: button }).click();
      const idField = inspector.getByLabel("Id", { exact: true });
      await commit(idField, id);
      await expect(inspector.locator(`[data-graph-node-editor="${id}"]`)).toBeVisible();
      await inspector.getByLabel("Label", { exact: true }).first().fill(label);
    };
    /** A bounding box that has stopped moving (the canvas animates into view). */
    const stableBox = async (locator: Locator) => {
      let previous = "";
      let box = (await locator.boundingBox())!;
      await expect
        .poll(
          async () => {
            box = (await locator.boundingBox())!;
            const key = JSON.stringify(box);
            const stable = key === previous;
            previous = key;
            return stable;
          },
          { intervals: [100, 100, 100, 200, 200, 500] },
        )
        .toBe(true);
      return box;
    };
    const dragNodeBy = async (id: string, dx: number, dy: number) => {
      const box = await stableBox(node(id).locator("[data-graph-node-title]"));
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
      await page.mouse.up();
    };
    /** The keyboard path: "Connect to…" on the selected node, then From and To. */
    const connect = async (from: string, to: string) => {
      await inspector.getByRole("button", { name: /Connect to/ }).click();
      const dialog = page.getByRole("dialog", { name: "Connect" });
      await dialog.getByLabel("From").selectOption(from);
      await dialog.getByLabel("To").selectOption(to);
      await dialog.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(dialog).toBeHidden();
    };

    // ---- A new graph: template, run inputs and the custom type.
    await designer.getByRole("button", { name: /New graph/ }).click();
    await expect(palette).toBeVisible();
    await commit(inspector.getByLabel("Template id"), "qa-bake-off");
    await inspector.getByLabel("Template name").fill("QA design bake-off");
    await inspector.getByRole("button", { name: /Add run input/ }).click();
    await inspector.getByRole("button", { name: /Add run input/ }).click();
    await commit(inspector.locator('[data-graph-run-input="input"]').getByLabel("Name"), "target");
    await inspector.getByRole("button", { name: /Add type/ }).click();
    const typeForm = inspector.locator("[data-graph-type-form]");
    await commit(typeForm.getByLabel("Name", { exact: true }), "design-brief");
    await typeForm
      .getByLabel("Example payload")
      .fill(JSON.stringify(DESIGN_BRIEF_EXAMPLE, null, 2));
    await typeForm.getByRole("button", { name: /Schema from example/ }).click();
    await expect(inspector.locator('[data-graph-type-row="design-brief@1"]')).toBeVisible();
    await expect(typeForm.locator("[data-graph-type-valid]")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("01-type-from-example.png") });

    // ---- Design: one agent replicated over three lenses, researcher profile.
    await add(/Agent/, "design", "Design");
    // Drag from a run input onto "+ input": while dragging, only compatible handles light up.
    {
      // The canvas brings a new node into view with a short animation: wait for it to settle.
      const target = await stableBox(handle("design", "in:+"));
      const source = await stableBox(handle("$inputs", "out:ticket"));
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(source.x + 40, source.y + 20, { steps: 4 });
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
        steps: 12,
      });
      await expect(
        node("design").locator('[data-graph-port="in:+"][data-graph-connect="compatible"]'),
      ).toBeVisible();
      await expect(
        node("$outputs").locator('[data-graph-port="in:+"][data-graph-connect="incompatible"]'),
      ).toBeVisible();
      await expect(designer.locator('[data-graph-connection-hint="ok"]')).toContainText(
        "New input design.ticket",
      );
      await page.screenshot({ path: testInfo.outputPath("02-drag-compatible.png") });
      await page.mouse.up();
    }
    await expect(node("design").locator('[data-graph-port="in:ticket"]')).toBeVisible();
    await connect("$inputs|out:target", "design|in:+");
    await tab("Inputs/Outputs");
    await commit(portCard("out:result").getByLabel("Name"), "brief");
    await portCard("out:brief").getByLabel("Type", { exact: true }).selectOption("design-brief@1");
    await portCard("in:ticket").getByLabel("Render as").selectOption("markdown");
    await tab("Capabilities");
    await inspector.getByLabel("Capability profile").selectOption("researcher");
    await tab("Execution");
    await inspector.getByLabel("Run as").selectOption("lenses");
    const lenses = inspector.locator("[data-graph-lens-editor]");
    await commit(lenses.getByLabel("Key").first(), "simplicity");
    await lenses.getByLabel("Label").first().fill("Simplicity");
    await lenses
      .getByLabel("Instruction")
      .first()
      .fill("Prefer the smallest change that fully solves the ticket.");
    await lenses.getByLabel("Add a preset lens").selectOption({ label: "Performance" });
    await lenses.getByLabel("Add a preset lens").selectOption({ label: "Security" });
    await expect(lenses.getByLabel("Key")).toHaveCount(3);
    await expect(node("design").locator('[data-graph-badge="replication"]')).toHaveText("×3");
    await expect(node("design").locator("[data-graph-stack]")).toBeVisible();
    await tab("Prompt");
    await inspector
      .getByRole("combobox", { name: /^Template/ })
      .fill(
        "Propose a design for the ticket below.\n\n{{> input.ticket}}\n\nFocus: {{lens.label}}. {{lens.instruction}}\n",
      );
    await expect(inspector.locator("[data-graph-prompt-contract]")).toContainText("submit_brief");

    // ---- Judge: fans the briefs in (a list), picks one lens key.
    await add(/Agent/, "judge", "Judge");
    // Moving a node writes every position to the template's layout.
    await dragNodeBy("judge", 320, 40);
    // Undo and redo the next connection with the keyboard.
    await connect("design|out:brief", "judge|in:+");
    const withBriefs = await draftEdgeCount();
    await page.keyboard.press("Control+z");
    await expect.poll(draftEdgeCount).toBe(withBriefs - 1);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(draftEdgeCount).toBe(withBriefs);
    await connect("$inputs|out:ticket", "judge|in:+");
    await tab("Inputs/Outputs");
    await expect(portCard("in:brief").getByLabel("Shape")).toHaveValue("1");
    await commit(portCard("out:result").getByLabel("Name"), "decision");
    await portCard("out:decision").getByLabel("Type", { exact: true }).selectOption("decision@1");
    await commit(
      portCard("out:decision").getByLabel("Choices"),
      "simplicity, performance, security",
    );
    await inspector.getByRole("button", { name: /Add output/ }).click();
    await commit(portCard("out:output").getByLabel("Name"), "brief");
    await portCard("out:brief").getByLabel("Type", { exact: true }).selectOption("design-brief@1");
    await portCard("out:brief").getByLabel("Provenance").selectOption("cite");
    await tab("Capabilities");
    await inspector.getByLabel("Capability profile").selectOption("observer");
    await inspector.getByLabel("Workspace access").selectOption("none");
    await tab("Prompt");
    await inspector
      .getByRole("combobox", { name: /^Template/ })
      .fill(
        "Choose the best design brief for the ticket. Your choice must be one of the lens keys.\n\n{{> input.ticket}}\n\n{{> input.brief}}\n",
      );

    // ---- A person approves (and may edit) the chosen brief.
    await add(/Human/, "approve", "Approve brief");
    await connect("judge|out:brief", "approve|in:+");
    await connect("judge|out:decision", "approve|in:+");
    await inspector.getByLabel("Form").selectOption("edit");
    await inspector.getByLabel(/^Input the person may edit/).selectOption("brief");

    // ---- Build, the PR description and the pull request (a system node).
    await add(/Agent/, "build", "Build");
    await tab("Inputs/Outputs");
    await inspector.getByRole("button", { name: /Add input/ }).click();
    await commit(portCard("in:input").getByLabel("Name"), "brief");
    await portCard("in:brief").getByLabel("Type", { exact: true }).selectOption("design-brief@1");
    await commit(portCard("out:result").getByLabel("Name"), "code");
    await portCard("out:code").getByLabel("Type", { exact: true }).selectOption("workspace@1");
    await connect("approve|outlet:approved", "build|in:brief");
    await connect("$inputs|out:ticket", "build|in:+");
    await connect("$inputs|out:target", "build|in:+");
    await tab("Capabilities");
    await inspector.getByLabel("Capability profile").selectOption("builder");
    await inspector.getByLabel("Workspace access").selectOption("write");
    await tab("Prompt");
    await inspector.getByLabel("Prompt source").selectOption("builtin:build");

    await add(/Agent/, "describe-pr", "Describe PR");
    await tab("Inputs/Outputs");
    await inspector.getByRole("button", { name: /Add input/ }).click();
    await commit(portCard("in:input").getByLabel("Name"), "brief");
    await portCard("in:brief").getByLabel("Type", { exact: true }).selectOption("design-brief@1");
    await portCard("in:brief").getByLabel("Render as").selectOption("markdown");
    await commit(portCard("out:result").getByLabel("Name"), "description");
    await portCard("out:description")
      .getByLabel("Type", { exact: true })
      .selectOption("pr-description@1");
    await connect("build|out:code", "describe-pr|in:+");
    await connect("approve|outlet:approved", "describe-pr|in:brief");
    await tab("Prompt");
    await inspector.getByLabel("Prompt source").selectOption("builtin:pull-request-description");

    await palette.getByRole("button", { name: "System node" }).click();
    await page.getByRole("menuitem", { name: /Open pull request/ }).click();
    await commit(inspector.getByLabel("Id", { exact: true }), "pr");
    await connect("build|out:code", "pr|in:code");
    await connect("describe-pr|out:description", "pr|in:description");
    await connect("pr|out:pr", "$outputs|in:+");
    await designer.getByRole("button", { name: /Arrange/ }).click();
    await canvas.locator(".react-flow__controls-fitview").click();
    await page.screenshot({ path: testInfo.outputPath("03-built.png") });

    // ---- Compile: taint from the web-searching designers reaches Build and the PR.
    const compilePanel = designer.locator("[data-graph-compile-panel]");
    const pending = compilePanel.locator("[data-graph-pending-acknowledgements]");
    await expect(pending).toBeVisible();
    await expect(pending).toContainText("taint-reaches-side-effect");
    await page.screenshot({ path: testInfo.outputPath("04-taint-pending.png") });
    const acknowledgeButtons = await pending
      .getByRole("button", { name: /^Acknowledge/ })
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")!));
    expect(acknowledgeButtons).toEqual([
      "Acknowledge taint-reaches-side-effect on build",
      "Acknowledge taint-reaches-side-effect on pr",
    ]);
    for (const label of acknowledgeButtons) {
      await pending.getByRole("button", { name: label }).click();
    }
    await expect(pending).toBeHidden();
    await expect(compilePanel.locator("[data-graph-compile-counts]")).toContainText("0 errors");
    await expect(compilePanel).not.toContainText("needs acknowledgements");
    await expect(compilePanel.locator("[data-graph-cost]")).toContainText("Sessions");

    // ---- Save, then reload: the template comes back from the backend.
    await designer.getByRole("button", { name: /^Save$/ }).click();
    await expect(designer.locator('[data-graph-draft-state="saved"]')).toBeVisible();
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText("QA design bake-off");
    await page.screenshot({ path: testInfo.outputPath("05-saved.png") });
    const stored = await invoke<{
      template: {
        nodes: Array<{ id: string }>;
        roles: Array<{ key: string }>;
        acknowledgements?: unknown[];
        layout?: Record<string, unknown>;
      };
    }>("graph_template_get", { ref: { scope: "user", id: "qa-bake-off" } });
    expect(stored.template.nodes.map((entry) => entry.id).sort()).toEqual([
      "approve",
      "build",
      "describe-pr",
      "design",
      "judge",
      "pr",
    ]);
    expect(stored.template.acknowledgements).toHaveLength(2);
    // Each agent kept the role it was created with, renamed with it.
    expect(stored.template.roles.map((role) => role.key).sort()).toEqual([
      "build",
      "describe-pr",
      "design",
      "judge",
    ]);
    expect(Object.keys(stored.template.layout ?? {}).sort()).toEqual([
      "approve",
      "build",
      "describe-pr",
      "design",
      "judge",
      "pr",
    ]);

    await page.reload();
    await openEnvironment(page, project.name, env.name);
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText("QA design bake-off");
    await expect(node("judge")).toBeVisible();
    await expect(node("design").locator('[data-graph-badge="replication"]')).toHaveText("×3");
    const backendCompile = designer.locator(
      '[data-graph-compile-panel][data-graph-compile-source="backend"]',
    );
    await expect(backendCompile.locator("[data-graph-compile-counts]")).toContainText("0 errors");
    await expect(backendCompile).not.toContainText("needs acknowledgements");
    await page.screenshot({ path: testInfo.outputPath("06-rehydrated.png") });

    // ---- A save that lost the race keeps the draft and offers a copy.
    await designer.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(designer.locator("[data-graph-editor-toolbar]")).toBeVisible();
    await inspector.getByLabel("Template name").fill("QA design bake-off, edited");
    // The draft compiles in the browser as it changes.
    await expect(
      designer.locator('[data-graph-compile-panel][data-graph-compile-source="browser"]'),
    ).toBeVisible();
    const latest = await invoke<{ template: Record<string, unknown> & { revision: number } }>(
      "graph_template_get",
      { ref: { scope: "user", id: "qa-bake-off" } },
    );
    await invoke("graph_template_save", {
      template: { ...latest.template, description: "Saved elsewhere" },
      expectedRevision: latest.template.revision,
    });
    // The backend announces the change: the bar says the stored template moved on.
    await expect(designer.locator("[data-graph-draft-behind]")).toBeVisible();
    await designer.getByRole("button", { name: /^Save$/ }).click();
    await expect(designer.locator("[data-graph-save-conflict]")).toContainText(
      "based on revision 1",
    );
    await expect(designer.getByRole("button", { name: /Reload latest/ })).toBeVisible();
    // A refresh from the backend never replaces the draft's own compile.
    await expect(
      designer.locator('[data-graph-compile-panel][data-graph-compile-source="browser"]'),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("07-conflict.png") });
    await designer.getByRole("button", { name: /Save as copy/ }).click();
    await expect(designer.locator("[data-graph-designer-title]")).toHaveText(
      "QA design bake-off, edited (copy)",
    );
    await expect(designer.locator('[data-graph-draft-state="saved"]')).toBeVisible();
    const copy = await invoke<{ summary: { id: string; revision: number } }>("graph_template_get", {
      ref: { scope: "user", id: "qa-bake-off-copy" },
    });
    expect(copy.summary.revision).toBe(1);
  } finally {
    await invoke("graph_template_delete", { id: "qa-bake-off" }).catch(() => undefined);
    await invoke("graph_template_delete", { id: "qa-bake-off-copy" }).catch(() => undefined);
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
  }
});
