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

  // Closing it returns focus to the drawer trigger, the control that stands in
  // for the row that opened it, and leaves nothing behind that blocks the
  // shell: the drawer reopens.
  await touchTap(page, settings.getByRole("button", { name: "Close settings" }));
  await expect(settings).toHaveCount(0);
  const drawerTrigger = page.getByRole("button", { name: "Open projects and environments" });
  await expect(drawerTrigger).toBeFocused();
  await touchTap(page, drawerTrigger);
  await expect(drawer.getByText("drawer-environment")).toBeVisible();
});

test("closing drawer-opened settings with the keyboard returns focus to the drawer trigger", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "the projects drawer is phone-only");
  await page.goto("/environment-settings-drawer");
  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  await expect(drawer).toBeVisible();

  const actions = drawer.getByRole("button", { name: "Environment actions" });
  await actions.focus();
  await page.keyboard.press("Enter");
  const settingsItem = page.getByRole("menuitem", { name: "Settings" });
  await expect(settingsItem).toBeVisible();
  await settingsItem.focus();
  await page.keyboard.press("Enter");

  const settings = page.getByRole("dialog", { name: "Environment Settings" });
  await expect(settings).toBeVisible();
  await expect(drawer).toHaveCount(0);
  // The dialog takes focus while open, so the keyboard stays inside it.
  await expect
    .poll(() => settings.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  const drawerTrigger = page.getByRole("button", { name: "Open projects and environments" });
  await expect(drawerTrigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(drawer.getByText("drawer-environment")).toBeVisible();
});

test("bottom-bar environment settings return focus after first load and cached reopening", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "the projects drawer is phone-only");
  await page.goto("/environment-settings-drawer");
  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  await expect(drawer).toBeVisible();
  await touchTap(
    page,
    page.getByRole("button", { name: "Close projects and environments" }).last(),
  );
  const drawerTrigger = page.getByRole("button", { name: "Open projects and environments" });
  const settings = page.getByRole("dialog", { name: "Environment Settings" });
  for (const closeWithKeyboard of [false, true]) {
    await touchTap(page, drawerTrigger);
    await touchTap(page, drawer.getByRole("button", { name: "Environment settings", exact: true }));
    await expect(settings).toBeVisible();
    await expect(drawer).toHaveCount(0);
    await expect
      .poll(() => settings.evaluate((dialog) => dialog.contains(document.activeElement)))
      .toBe(true);
    const section = settings.getByRole("combobox", { name: "Settings section" });
    await touchTap(page, section);
    await touchTap(page, page.getByRole("option", { name: "Defaults", exact: true }));
    await expect(section).toHaveText("Defaults");
    const codex = settings
      .getByRole("radiogroup", { name: "Default agent" })
      .getByRole("radio", { name: "Codex", exact: true });
    await touchTap(page, codex);
    await expect(codex).toHaveAttribute("aria-checked", "true");
    if (closeWithKeyboard) await page.keyboard.press("Escape");
    else await touchTap(page, settings.getByRole("button", { name: "Close settings" }));
    await expect(settings).toHaveCount(0);
    await expect(drawerTrigger).toBeFocused();
  }
});
