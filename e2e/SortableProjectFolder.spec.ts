import { expect, test } from "@playwright/test";

test("sorts a project folder from its real browser context menu", async ({ page }) => {
  await page.goto("/sortable-project-folder");

  const projectNames = page.getByRole("list", { name: "Work projects" }).getByRole("listitem");
  await expect(projectNames).toHaveText(["Zulu", "Alpha"]);

  await page.getByTitle("Collapse folder Work").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Sort" }).click();

  await expect(projectNames).toHaveText(["Alpha", "Zulu"]);
});
