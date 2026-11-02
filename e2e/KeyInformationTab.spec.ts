import { expect, test, type Page } from "@playwright/test";

/**
 * The build tab's Key information panel pops out into a tab of its own, and a
 * right-click on the header button goes straight to that tab.
 */

const expectedTarget = JSON.stringify({
  environmentId: "key-info-environment",
  pipelineId: "key-info-pipeline",
});

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.getByTestId("pipeline-key-information-tab").evaluate((element) => {
    const scroller = element.querySelector<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("Missing key information scroller");
    return scroller.scrollWidth - scroller.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

test("the panel's pop-out button opens the brief as a tab", async ({ page }) => {
  await page.goto("/key-information-tab");
  const header = page.getByTestId("build-pipeline-header");
  await header.getByRole("button", { name: "Key information" }).click();
  const panel = page.getByRole("dialog", { name: "Key information" });
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Open key information in a tab" }).click();

  await expect(panel).toBeHidden();
  await expect(page.getByTestId("opened-with")).toHaveText(expectedTarget);
  const tab = page.getByTestId("pipeline-key-information-tab");
  await expect(tab.getByRole("region", { name: "Problem" })).toBeVisible();
  await expect(tab.getByRole("group", { name: "Summary" })).toBeVisible();
  await expect(tab.getByRole("region", { name: "Tests" }).getByRole("row")).toHaveCount(6);
  await expectNoHorizontalOverflow(page);
});

test("right-clicking the header button goes straight to the tab", async ({ page }) => {
  await page.goto("/key-information-tab");
  await page
    .getByTestId("build-pipeline-header")
    .getByRole("button", { name: "Key information" })
    .click({ button: "right" });

  await expect(page.getByRole("dialog", { name: "Key information" })).toHaveCount(0);
  await expect(page.getByTestId("opened-with")).toHaveText(expectedTarget);
  await expect(page.getByTestId("pipeline-key-information-tab")).toBeVisible();
});

test("a summary tile jumps to its section", async ({ page }) => {
  await page.goto("/key-information-tab?view=tab");
  const tab = page.getByTestId("pipeline-key-information-tab");
  await tab
    .getByRole("group", { name: "Summary" })
    .getByRole("button", { name: /Verification/ })
    .click();

  const verification = tab.getByRole("region", { name: "Verification" });
  await expect(verification).toBeInViewport();
  await expect(verification.getByText("Round 2: passed")).toBeVisible();
});

test("a wide pane adds the section list and puts context beside the solution", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "this asserts the wide layout");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/key-information-tab?view=tab");
  const tab = page.getByTestId("pipeline-key-information-tab");

  await expect(tab.getByRole("navigation", { name: "Key information sections" })).toBeVisible();
  const context = await tab.getByRole("region", { name: "Context" }).boundingBox();
  const solution = await tab.getByRole("region", { name: "Solution" }).boundingBox();
  if (!context || !solution) throw new Error("Expected rendered sections");
  expect(Math.abs(context.y - solution.y)).toBeLessThanOrEqual(1);
  expect(solution.x).toBeGreaterThan(context.x + context.width);
  await expectNoHorizontalOverflow(page);
});

test("the tab explains an empty brief", async ({ page }) => {
  await page.goto("/key-information-tab?view=tab&empty=1");
  await expect(page.getByText("Nothing has been recorded yet")).toBeVisible();
});
