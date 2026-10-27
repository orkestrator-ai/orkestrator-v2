import { expect, test, type Page } from "@playwright/test";

async function openSearch(page: Page) {
  await page.goto("/project-search-machines");
  await page.getByTestId("project-search-trigger").click();
  const input = page.getByRole("combobox", { name: "Search projects and environments" });
  await expect(input).toBeFocused();
  return input;
}

test("a project only on another machine is a labelled result in the one merged list", async ({
  page,
}) => {
  const input = await openSearch(page);
  await input.fill("tel");
  const row = page.getByRole("option", { name: "telegram-scraper, project on mbp3" });
  await expect(row).toBeVisible();
  await expect(row.getByText("mbp3")).toBeVisible();
  await expect(page.getByText("Other machines")).toHaveCount(0);
  await expect(page.getByText("No projects or environments match that search.")).toHaveCount(0);
  await input.press("Enter");
  await expect(page.getByTestId("selected")).toHaveText("mbp3:tg");
});

test("one row per machine, offline rows greyed, and every row fits the dialog", async ({
  page,
}) => {
  const input = await openSearch(page);
  await input.fill("orkestrator");
  const projects = page.getByRole("option", { name: /^orkestrator-v2, project on / });
  await expect(projects).toHaveCount(3);
  await expect(projects.nth(0)).toHaveAccessibleName("orkestrator-v2, project on studio");
  await expect(projects.nth(1)).toHaveAccessibleName("orkestrator-v2, project on mbp3");
  await expect(projects.nth(2)).toHaveAccessibleName("orkestrator-v2, project on mini, offline");
  await expect(projects.nth(2)).toHaveCSS("opacity", "0.6");
  await expect(page.getByTestId("federated-search-incomplete")).toBeVisible();

  // Rows never overflow the results list, on a phone or a desktop.
  const list = page.getByRole("listbox", { name: "Search results" });
  const listBox = (await list.boundingBox())!;
  for (const option of await page.getByRole("option").all()) {
    const box = (await option.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(listBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
    for (const label of await option.getByTestId("project-search-machine").all()) {
      const labelBox = (await label.boundingBox())!;
      expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
  }

  // Tab cycles to environments: the remote environment stays, projects go.
  await input.press("Tab");
  await input.press("Tab");
  await expect(projects).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "run-desktop-app, environment of orkestrator-v2 on mbp3" }),
  ).toBeVisible();
});

test("the machine filter narrows the merged list to one machine", async ({ page }) => {
  const input = await openSearch(page);
  await input.fill("orkestrator");
  await page.getByTestId("project-search-filter").click();
  await page.getByRole("menuitemradio", { name: /mbp3/ }).click();
  await expect(page.getByLabel("Filter results: All, mbp3")).toBeVisible();
  await expect(page.getByRole("option", { name: /^orkestrator-v2, project on / })).toHaveCount(1);
  await expect(page.getByTestId("federated-search-incomplete")).toHaveCount(0);
});

test("choosing another machine's environment opens it on that machine", async ({ page }) => {
  const input = await openSearch(page);
  await input.fill("run-desktop");
  await page
    .getByRole("option", { name: "run-desktop-app, environment of orkestrator-v2 on mbp3" })
    .click();
  await expect(page.getByTestId("opened")).toHaveText("bk_mbp3");
});
