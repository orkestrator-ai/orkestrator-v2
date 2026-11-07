import { expect, test } from "@playwright/test";

test("Settings for the shown leaf preserves ownership across selection, save and reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/settings-machines");
  const path = page.getByRole("textbox", { name: "Default projects folder", exact: true });
  const browse = page.getByRole("button", { name: "Browse for the default projects folder" });
  // The shown leaf is reached through the command node: its folders are not this window's.
  await expect(path).toHaveValue("/leaf/projects");
  await expect(browse).toBeDisabled();
  await page.getByRole("button", { name: /^Command.*command node/ }).click();
  await expect(path).toHaveValue("/command/projects");
  await expect(browse).toBeEnabled();
  await path.fill("/command/changed");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("settings-machine:command") ?? "{}").global
            ?.defaultProjectsDirectory,
      ),
    )
    .toBe("/command/changed");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("settings-machine:command")!).global.allowedDomains,
    ),
  ).toEqual(["command.test"]);
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(path).toHaveValue("/other/projects");
  await expect(browse).toBeDisabled();
  await page.reload();
  await expect(path).toHaveValue("/leaf/projects");
  await page.getByRole("button", { name: /^Command.*command node/ }).click();
  await expect(path).toHaveValue("/command/changed");
  await expect(browse).toBeEnabled();
  expect(errors).toEqual([]);
});

test("Auto-steer is saved on the command node whichever machine is selected", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const stored = (owner: string) =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "{}").global?.autoSteer,
      `settings-machine:${owner}`,
    );
  await page.goto("/settings-machines");
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Default projects folder", exact: true }),
  ).toHaveValue("/other/projects");
  await expect(page.getByTestId("settings-scope")).toContainText("Preferences come from");

  const autoSteer = page.getByRole("switch", { name: "Auto-steer" });
  await autoSteer.click();
  await expect.poll(() => stored("command")).toBe(true);
  expect(await stored("other")).toBeUndefined();
  expect(await stored("leaf")).toBeUndefined();

  // The command node's value is what every selected machine now shows.
  await page.reload();
  await expect(autoSteer).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Default projects folder", exact: true }),
  ).toHaveValue("/other/projects");
  await expect(autoSteer).toHaveAttribute("aria-checked", "true");
  expect(errors).toEqual([]);
});

test("failed machine config has an accessible retry without switching away", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/settings-machines?retry");
  await expect(
    page.getByRole("textbox", { name: "Default projects folder", exact: true }),
  ).toHaveValue("/leaf/projects");
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture machine offline");
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Default projects folder", exact: true }),
  ).toHaveValue("/other/projects");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("container budgets survive Settings section changes on the selected machine", async ({
  page,
}) => {
  const chooseSection = async (name: string) => {
    const picker = page.getByRole("combobox", { name: "Settings section" });
    if (await picker.isVisible()) {
      await picker.click();
      await page.getByRole("option", { name, exact: true }).click();
    } else {
      await page.getByRole("button", { name, exact: true }).click();
    }
  };
  await page.goto("/settings-machines");
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await chooseSection("Container");
  await expect(page.getByText(/On this Docker:.*8 GB memory/)).toBeVisible();
  for (const mode of ["Custom", "No limits", "Built-in default"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    if (mode === "Custom") await page.getByRole("spinbutton", { name: "Memory (GB)" }).fill("4");
    await page.getByRole("button", { name: "Save limits" }).click();
    await expect(page.getByRole("button", { name: "Save limits" })).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const limits = JSON.parse(localStorage.getItem("settings-machine:other") ?? "{}").global
            ?.containerResourceLimits;
          return limits === undefined
            ? "default"
            : limits.memoryMiB === 4096
              ? "custom"
              : "unrestricted";
        }),
      )
      .toBe(mode === "Custom" ? "custom" : mode === "No limits" ? "unrestricted" : "default");
    await chooseSection("General");
    await chooseSection("Container");
    await expect(page.getByRole("button", { name: mode, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    if (mode === "Custom")
      await expect(page.getByRole("spinbutton", { name: "Memory (GB)" })).toHaveValue("4");
  }
  expect(await page.evaluate(() => localStorage.getItem("settings-machine:leaf"))).toBeNull();
});

test("a directly opened leaf reconciles masked Auto-steer without repeated saves", async ({
  page,
}, testInfo) => {
  await page.goto("/settings-machines?direct-leaf");
  const toggle = page.getByRole("switch", { name: "Auto-steer" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `output/visual-previews/auto-steer-direct-leaf-before-${testInfo.project.name}.png`,
  });
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("settings-machine:patch-count")))
    .toBe("1");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => localStorage.getItem("settings-machine:patch-count"))).toBe("1");
  await page.screenshot({
    path: `output/visual-previews/auto-steer-direct-leaf-after-${testInfo.project.name}.png`,
  });
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});
