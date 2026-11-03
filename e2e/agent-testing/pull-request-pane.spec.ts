import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
function profileCommand(command: string) {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${command} failed`);
  return JSON.parse(result.stdout);
}

for (const width of [1440, 820]) {
  test(`ticket PR links preserve the board at ${width}px`, async ({ page }) => {
    const status = profileCommand("dev:status");
    expect(status.flavor).toBe("agent-test");
    expect(status.status).toBe("ready");
    await page.setViewportSize({ width, height: 900 });
    await page.goto(profileCommand("dev:login").loginUrl);
    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
      const response = await page.request.post(
        new URL("/__orkestrator/invoke", status.browserUrl).href,
        { data: { command, args } },
      );
      expect(response.ok()).toBe(true);
      return (await response.json()).result;
    };
    const projects = await invoke("get_projects");
    const project = projects.find((p: { localPath: string }) => p.localPath === status.testProject);
    expect(project).toBeTruthy();
    const title = `PR pane regression ${width}`;
    const task = await invoke("add_kanban_task", {
      projectId: project.id,
      title,
      description: "[Review PR](https://github.com/acme/widget/pull/42)",
    });
    await invoke("add_kanban_comment", {
      taskId: task.id,
      text: "https://github.com/acme/widget/pull/42",
    });
    const nativeOpen = await page.evaluateHandle(() => window.open);
    await page.route("**/__orkestrator/invoke", async (route) => {
      if (route.request().postDataJSON()?.command !== "get_github_pull_request")
        return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture repository unavailable" }),
      });
    });
    await page.evaluate(() => {
      window.open = ((url: string) => {
        document.documentElement.dataset.externalPr = url;
        return null;
      }) as typeof window.open;
    });
    try {
      await page
        .getByRole("button", { name: new RegExp(`^${project.name}`) })
        .first()
        .click();
      await page.getByRole("tab", { name: "Kanban", exact: true }).click();
      const closePanel = page.getByRole("button", { name: "Close panel", exact: true });
      if (await closePanel.isVisible()) await closePanel.click();
      const card = page.getByText(title, { exact: true }).first();
      await card.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const previewDir = path.join(root, "output/visual-previews");
      await page.screenshot({ path: path.join(previewDir, `ticket-pr-before-${width}.png`) });
      // The board stays mounted; remember every scroll container so a pane open
      // cannot silently move the user to another part of a long board.
      const scrollPositions = () =>
        page
          .locator("#project-panel-kanban")
          .evaluate((el) =>
            [el, ...el.querySelectorAll("*")]
              .filter((node) => node.scrollHeight > node.clientHeight)
              .map((node) => node.scrollTop),
          );
      const scroll = await scrollPositions();
      await dialog.getByRole("link", { name: "Review PR" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(closePanel).toBeVisible();
      await expect(page.getByRole("tab", { name: "Kanban", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect.poll(scrollPositions).toEqual(scroll);
      await page.screenshot({ path: path.join(previewDir, `ticket-pr-after-${width}.png`) });
      const fallback = page.getByRole("button", { name: "Open on GitHub", exact: true });
      await expect(fallback).toBeVisible({ timeout: 15000 });
      await page.evaluate((original) => {
        window.open = original;
      }, nativeOpen);
      const popup = page.waitForEvent("popup");
      await fallback.click();
      await (await popup).close();
      // Editing fallback below records the URL without opening another browser.
      await page.evaluate(() => {
        window.open = ((url: string) => {
          document.documentElement.dataset.externalPr = url;
          return null;
        }) as typeof window.open;
      });
      await closePanel.click();
      await expect.poll(scrollPositions).toEqual(scroll);
      await page.getByRole("tab", { name: "Kanban", exact: true }).focus();
      await expect(page.getByRole("tab", { name: "Kanban", exact: true })).toBeFocused();
      // The original card remains interactive after the modal focus trap closes.
      await card.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Edit", exact: true }).click();
      await dialog.getByLabel("Ticket text").fill("Unsaved review draft");
      await dialog
        .getByRole("button", { name: "https://github.com/acme/widget/pull/42", exact: true })
        .click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-external-pr",
        "https://github.com/acme/widget/pull/42",
      );
      await expect(dialog.getByLabel("Ticket text")).toHaveValue("Unsaved review draft");
      await expect(closePanel).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.reload();
      // Window and board selection are transient on a fresh browser mount.
      // Return to the board and verify the backend-owned ticket rehydrates.
      await page
        .getByRole("button", { name: new RegExp(`^${project.name}`) })
        .first()
        .click();
      await page.getByRole("tab", { name: "Kanban", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Kanban", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(card).toBeVisible();
    } finally {
      await invoke("delete_kanban_task", { taskId: task.id });
    }
  });
}
