import { expect, test, type Page } from "@playwright/test";

const SIGNAL_BLUE_RGB = "rgb(59, 130, 246)";

async function openProcessPanel(page: Page) {
  await page.goto("/system-usage");
  await expect(page.getByRole("img", { name: "Disk storage usage: 63%" })).toBeVisible();
  await page.getByRole("button", { name: "Open environment process usage" }).click();
  await expect(page.getByRole("region", { name: "title-bar-layout processes" })).toBeVisible();
}

test("environment names and totals use signal blue independently of the Create PR fill at process size", async ({
  page,
}) => {
  await openProcessPanel(page);

  const heading = page.getByRole("heading", { name: "title-bar-layout" });
  const totals = page.getByRole("group", {
    name: "title-bar-layout total usage: 18% CPU, 117 MB RAM",
  });
  const processRow = page.getByRole("listitem").filter({ hasText: "node" });
  const createPr = page.getByRole("button", { name: "Create PR" });

  await expect(heading).toBeVisible();
  await expect(totals).toBeVisible();
  await expect(processRow).toBeVisible();
  await expect(createPr).toBeVisible();

  const themePrimary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim(),
  );
  expect(themePrimary).toBe("#3b82f6");

  await expect(heading).toHaveCSS("color", SIGNAL_BLUE_RGB);
  await expect(totals).toHaveCSS("color", SIGNAL_BLUE_RGB);
  await expect(createPr).toHaveCSS("background-color", "rgb(37, 99, 235)");

  const [totalsFontSize, processFontSize] = await Promise.all([
    totals.evaluate((element) => getComputedStyle(element).fontSize),
    processRow.evaluate((element) => getComputedStyle(element).fontSize),
  ]);
  expect(totalsFontSize).toBe(processFontSize);
  expect(totalsFontSize).toBe("12px");
});

test("environment header stays on one row without overflowing the panel", async ({ page }) => {
  await openProcessPanel(page);

  const section = page.getByRole("region", { name: "title-bar-layout processes" });
  const geometry = await section.evaluate((element) => {
    const heading = element.querySelector("h3");
    const totals = element.querySelector('[role="group"]');
    const processRow = element.querySelector("li");
    const dialog = element.closest('[role="dialog"]');
    if (!heading || !totals || !processRow || !dialog) {
      throw new Error("Missing process-panel header");
    }

    const headingBox = heading.getBoundingClientRect();
    const totalsBox = totals.getBoundingClientRect();
    const row = heading.parentElement;
    const rowBox = row?.getBoundingClientRect();
    const dialogBox = dialog.getBoundingClientRect();

    return {
      sameRow: headingBox.bottom > totalsBox.top && totalsBox.bottom > headingBox.top,
      totalsToTheRight: totalsBox.left >= headingBox.right - 1,
      totalsInsideDialog: totalsBox.right <= dialogBox.right + 1,
      headingInsideDialog: headingBox.left >= dialogBox.left - 1,
      rowSingleLine: rowBox
        ? rowBox.height <= Math.max(headingBox.height, totalsBox.height) + 4
        : false,
      dialogInsideViewport:
        dialogBox.left >= 0 &&
        dialogBox.right <= window.innerWidth + 1 &&
        dialogBox.top >= 0 &&
        dialogBox.bottom <= window.innerHeight + 1,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });

  expect(geometry.sameRow).toBe(true);
  expect(geometry.totalsToTheRight).toBe(true);
  expect(geometry.totalsInsideDialog).toBe(true);
  expect(geometry.headingInsideDialog).toBe(true);
  expect(geometry.rowSingleLine).toBe(true);
  expect(geometry.pageOverflow).toBe(false);
});

for (const unsupported of [false, true]) {
  test(`reopening preserves process failure without a sample (unsupported=${unsupported})`, async ({
    page,
  }) => {
    await page.goto("/system-usage");
    await expect(page.getByRole("img", { name: "Disk storage usage: 63%" })).toBeVisible();
    await page.evaluate((unsupported) => {
      const invoke = window.orkestrator!.invoke;
      window.orkestrator!.invoke = async (command, args) => {
        if (command === "get_environment_process_usage") {
          throw new Error(
            unsupported ? "Unknown backend command: get_environment_process_usage" : "offline",
          );
        }
        return invoke(command, args);
      };
    }, unsupported);
    await page.getByRole("button", { name: "Open environment process usage" }).click();
    await expect(page.getByText("Couldn't read processes")).toBeVisible();
    await page
      .getByRole("dialog", { name: "Environment process usage" })
      .getByRole("button", { name: "Close environment process usage" })
      .click();
    await page.getByRole("button", { name: "Open environment process usage" }).click();
    await expect(page.getByText("Couldn't read processes")).toBeVisible();
    await expect(page.getByText("Loading processes…")).toHaveCount(0);
    if (unsupported) {
      await page.screenshot({
        path: `output/visual-previews/usage-reopened-unavailable-${test.info().project.name}.png`,
      });
    }
  });
}
