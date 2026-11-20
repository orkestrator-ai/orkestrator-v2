import path from "node:path";
import { expect, test } from "@playwright/test";

test("each waiting or unread row says what it needs, and only those rows", async ({ page }) => {
  await page.goto("/environment-attention");
  const lines = page.getByTestId("environment-attention-line");
  // Working and idle-seen rows have no line, nor does a plain unread finish:
  // its bell beside the name says so on its own.
  await expect(lines).toHaveCount(5);
  await expect(lines.nth(0)).toHaveText(
    /^Needs approval: Claude wants to run bun install · \d+ min$/,
  );
  await expect(lines.nth(1)).toHaveText(
    /^Question: Which API should this use: REST or GraphQL\? · \d+ min · 2 waiting$/,
  );
  // A form that may hold sensitive input keeps its label alone.
  await expect(lines.nth(2)).toHaveText(/^Needs input · \d+ min$/);
  await expect(lines.nth(3)).toHaveText("Failed · error unread");
  await expect(lines.nth(4)).toHaveText("Setup needs your approval");
  await expect(page.getByText("Finished · result unread")).toHaveCount(0);
});

for (const kind of ["agent", "terminal-keyed"] as const) {
  test(`a finished ${kind} tab opens from its unread row and clears after render`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/sidebar-drag?unread-result=${kind}`);
    const tab = page.getByRole("region", { name: "Selected tab" });
    const row = page.getByRole("button", { name: /^p-env-1,/ });
    const bell = row.getByLabel("New completed activity");
    await expect(tab).toHaveText("Sibling tab");
    await expect(bell).toBeVisible();
    await expect(page.getByText("Finished · result unread")).toHaveCount(0);
    if (kind === "agent") {
      await page.locator("main").screenshot({
        path: path.resolve(
          "output/visual-previews",
          `sidebar-before-opening-unread-result-${testInfo.project.name}.png`,
        ),
      });
    }

    await page.getByRole("button", { name: /^p-env-2,/ }).click();
    await expect(tab).toHaveText("Another environment");
    if (kind === "agent") await bell.click();
    else await row.press("Enter");
    const render = tab.getByRole("button", { name: "Render finished result" });
    await expect(render).toBeVisible();
    await expect(bell).toBeVisible();
    await expect(page.getByTestId("sidebar-writes")).not.toContainText("set_environment_unread");
    if (kind === "agent") {
      await page.locator("main").screenshot({
        path: path.resolve(
          "output/visual-previews",
          `sidebar-awaiting-result-render-${testInfo.project.name}.png`,
        ),
      });
    }
    await render.click();
    await expect(tab).toHaveText("Completed result");
    await expect(bell).toHaveCount(0);
    await expect(page.getByTestId("sidebar-writes")).toContainText(
      '"sessionKeys":["env-p-env-1:finished-result"]',
    );
    if (kind === "agent") {
      await page.locator("main").screenshot({
        path: path.resolve(
          "output/visual-previews",
          `sidebar-after-rendering-unread-result-${testInfo.project.name}.png`,
        ),
      });
    }

    await page.reload();
    await expect(tab).toHaveText("Sibling tab");
    await expect(row).toBeVisible();
    await expect(bell).toHaveCount(0);
  });
}

test("an environment-wide terminal finish opens the restored sibling tab", async ({ page }) => {
  await page.goto("/sidebar-drag?unread-result=terminal");
  const row = page.getByRole("button", { name: /^p-env-1,/ });
  const bell = row.getByLabel("New completed activity");
  await expect(bell).toBeVisible();
  await expect(page.getByText("Finished · result unread")).toHaveCount(0);
  await row.click();
  await expect(page.getByRole("region", { name: "Selected tab" })).toHaveText("Sibling tab");
  await expect(bell).toHaveCount(0);
});

test("clicking a line opens the tab holding the request, not just the row", async ({ page }) => {
  await page.goto("/environment-attention");
  await page.getByRole("button", { name: /^Question: Which API/ }).click();
  await expect(page.getByTestId("attention-opened")).toHaveText("api-client: api-client-agent");
  await page.getByRole("button", { name: "Failed · error unread" }).click();
  await expect(page.getByTestId("attention-opened")).toHaveText("flaky-ci: environment");
});

test("the sidebar opens the named question after the layout hydrates", async ({
  page,
}, testInfo) => {
  await page.goto("/sidebar-drag?attention-target");
  const line = page.getByRole("button", { name: /^Question: Choose a deployment window/ });
  await expect(line).toBeVisible();
  await page.screenshot({
    path: path.resolve(
      "output/visual-previews",
      `waiting-sibling-after-${testInfo.project.name}.png`,
    ),
  });
  await line.focus();
  await line.press("Enter");
  await page.getByRole("button", { name: "Finish layout hydration" }).click();
  const question = page.locator('[data-interaction-id="question-target"]');
  await expect(question).toBeFocused();
  await expect(question).toBeInViewport();
  await expect(question).toHaveCSS("outline-style", "solid");
  await expect(page.locator('[data-interaction-id="other-question"]')).not.toBeFocused();
  await page.screenshot({
    path: path.resolve(
      "output/visual-previews",
      `waiting-question-focused-${testInfo.project.name}.png`,
    ),
  });
});

test("the compact project-home button names and opens the waiting request", async ({ page }) => {
  await page.goto("/sidebar-drag?attention-target");
  const home = page.getByRole("button", {
    name: /home needs attention, Question: Choose the project review window/,
  });
  await expect(home).toHaveAttribute("title", /Choose the project review window/);
  // The header's hover card must leave its sibling attention button clickable.
  await page.getByRole("button", { name: /^p 2$/ }).hover();
  await expect(page.getByText("Click to open board", { exact: true })).toBeVisible();
  await home.click();
  await page.getByRole("button", { name: "Finish layout hydration" }).click();
  const question = page.locator('[data-interaction-id="question-target"]');
  await expect(question).toBeFocused();
  await expect(question).toHaveText("Choose the project review window");
});

test("a settled request leaves the selected tab open and does not focus a sibling card", async ({
  page,
}) => {
  await page.goto("/sidebar-drag?attention-target&settled");
  await page.getByRole("button", { name: /^Question: Choose a deployment window/ }).click();
  await page.getByRole("button", { name: "Finish layout hydration" }).click();
  await expect(page.getByRole("region", { name: "Agent transcript" })).toBeVisible();
  await expect(page.locator('[data-interaction-id="other-question"]')).not.toBeFocused();
});
