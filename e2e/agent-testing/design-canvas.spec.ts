import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import type { DesignCanvas, DesignFrame } from "@orkestrator/protocol/design-canvas";

test.use({ actionTimeout: 15_000 });

test("real gateway saves a design and rehydrates another client's edits", async ({
  page,
}, testInfo) => {
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  const status = JSON.parse(
    spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
  expect(status.status).toBe("ready");
  const login = JSON.parse(
    spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
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
  const project = projects.find((project) => project.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "design-canvas-smoke",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: env.id });
    const action = <T>(action: string, input: Record<string, unknown>) =>
      invoke<T>("design_action", { environmentId: env.id, action, input });
    const canvas = await action<DesignCanvas>("create_canvas", { name: "Gateway design" });
    const { frame } = await action<{ frame: DesignFrame }>("create_frame", {
      canvasId: canvas.id,
      expectedRevision: 1,
      name: "Screen",
      x: 0,
      y: 0,
      width: 480,
      height: 320,
      html: "<h1 id='title'>Shared design</h1>",
    });
    await page.reload();
    await page.getByRole("button", { name: `Expand project ${project.name}`, exact: true }).click();
    await page.getByText(env.name, { exact: true }).first().click();
    await page.getByRole("button", { name: "New design workspace" }).click();
    await page.getByRole("combobox", { name: "Open a saved canvas" }).click();
    await page.getByRole("option", { name: "Gateway design", exact: true }).click();

    const embedded = page.frameLocator('iframe[title="Screen"]');
    await expect(embedded.getByRole("heading")).toHaveText("Shared design");
    await page.getByRole("button", { name: "Save design to repository" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved Gateway-design.orkdes" }),
    ).toBeVisible();
    const environment = await invoke<{ worktreePath: string }>("get_environment", {
      environmentId: env.id,
    });
    const saved = await invoke<{ content: string }>("read_local_file", {
      worktreePath: environment.worktreePath,
      filePath: "Gateway-design.orkdes",
    });
    expect(JSON.parse(saved.content)).toMatchObject({
      id: canvas.id,
      format: "orkdes",
      revision: 2,
    });
    await action("replace_frame_html", {
      canvasId: canvas.id,
      frameId: frame.id,
      expectedRevision: 1,
      html: "<h1 id='title'>Updated by another client</h1>",
    });
    await expect(embedded.getByRole("heading")).toHaveText("Updated by another client");
    await page.reload();
    await page.getByRole("button", { name: `Expand project ${project.name}`, exact: true }).click();
    await page.getByText(env.name, { exact: true }).first().click();
    await expect(embedded.getByRole("heading")).toHaveText("Updated by another client");
    const layout = await invoke<{ root: unknown }>("get_pane_layout", { environmentId: env.id });
    const serialized = JSON.stringify(layout.root);
    expect(serialized).toContain(canvas.id);
    expect(serialized).not.toContain("<h1");
    await page.getByRole("button", { name: "New design workspace" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Guided design");
    await page.getByRole("combobox", { name: "Design agent", exact: true }).click();
    await page.getByRole("option", { name: "Codex", exact: true }).click();
    await page.getByRole("button", { name: "Create design workspace", exact: true }).click();
    await expect(page.getByText("Guided design", { exact: true })).toBeVisible();
    await expect(
      page.getByText("A blank canvas for your next idea", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("design-workspace.png") });
  } finally {
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
  }
});
