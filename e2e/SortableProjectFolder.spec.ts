import { expect, test } from "@playwright/test";

test("sorts a project folder from its real browser context menu", async ({ page }) => {
  await page.goto("/sortable-project-folder");

  const projectNames = page.getByRole("list", { name: "Work projects" }).getByRole("listitem");
  await expect(projectNames).toHaveText(["Zulu", "Alpha"]);

  await page.getByTitle("Collapse folder Work").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Sort" }).click();

  await expect(projectNames).toHaveText(["Alpha", "Zulu"]);
});

// Members pad themselves like top-level rows, so the folder's content must
// span to the folder's right edge for their chevrons to line up.
test("folder members share the folder's right edge", async ({ page }) => {
  await page.goto("/sortable-project-folder");

  const folder = await page.locator('[data-project-folder="Work"]').boundingBox();
  const content = await page.locator('[data-project-folder-content="Work"]').boundingBox();
  expect(content!.x + content!.width).toBeCloseTo(folder!.x + folder!.width, 0);
});
