import { expect, test, type Locator, type Page } from "@playwright/test";

async function touchTap(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("Expected a rendered touch target");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test("environment settings opened from the projects drawer are usable on a phone", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "the projects drawer is phone-only");
  await page.goto("/environment-settings-drawer");
  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  await expect(drawer).toBeVisible();

  await touchTap(page, drawer.getByRole("button", { name: "Environment actions" }));
  await touchTap(page, page.getByRole("menuitem", { name: "Settings" }));

  // The drawer gives way to the dialog instead of trapping it underneath.
  const settings = page.getByRole("dialog", { name: "Environment Settings" });
  await expect(settings).toBeVisible();
  await expect(drawer).toHaveCount(0);

  const section = settings.getByRole("combobox", { name: "Settings section" });
  const firstSection = (await section.textContent())?.trim();
  await touchTap(page, section);
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  const otherSection = options.filter({ hasNotText: firstSection ?? "" }).first();
  const otherLabel = (await otherSection.textContent())?.trim() ?? "";
  await touchTap(page, otherSection);
  await expect(section).toHaveText(otherLabel);

  // Closing it leaves nothing behind that blocks the shell: the drawer reopens.
  await touchTap(page, settings.getByRole("button", { name: "Close settings" }));
  await expect(settings).toHaveCount(0);
  await touchTap(page, page.getByRole("button", { name: "Open projects and environments" }));
  await expect(drawer.getByText("drawer-environment")).toBeVisible();
});
