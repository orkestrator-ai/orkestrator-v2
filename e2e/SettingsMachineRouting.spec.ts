import { expect, test } from "@playwright/test";

test("leaf-bound Settings preserves ownership across selection, save and reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/settings-machines");
  const path = page.getByRole("textbox", { name: "Default projects folder", exact: true });
  const browse = page.getByRole("button", { name: "Browse for the default projects folder" });
  await expect(path).toHaveValue("/leaf/projects");
  await expect(browse).toBeEnabled();
  await page.getByRole("button", { name: /^Command.*command node/ }).click();
  await expect(path).toHaveValue("/command/projects");
  await expect(browse).toBeDisabled();
  await expect(page.getByRole("button", { name: "Browse for SSH agent socket" })).toBeDisabled();
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
  await expect(browse).toBeDisabled();
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
