import { expect, test } from "@playwright/test";

for (const [kind, pickerName, submitName] of [
  ["restart", "Restart fix model", "Restart Fix"],
  ["fix", "Custom fix model", "Start fix"],
  ["feature", "Build agent, model and reasoning", undefined],
] as const) {
  test(`${kind} platform switch selects Pi's saved default`, async ({ page }, testInfo) => {
    await page.goto(`/pi-launch-defaults?kind=${kind}`);
    const picker = page.getByRole("combobox", { name: pickerName });
    await picker.click();
    await page.getByRole("button", { name: "pi models", exact: true }).click();
    const mobile = testInfo.project.name === "mobile-chromium";
    if (mobile) await page.getByRole("menuitem", { name: /^Reasoning/ }).click();
    const reasoning = page.getByRole("group", {
      name: mobile ? "Reasoning choices" : "Reasoning",
      exact: true,
    });
    await expect(reasoning.getByRole("menuitemradio", { name: "High", exact: true })).toBeVisible();
    await expect(reasoning.getByRole("menuitemradio", { name: "Low", exact: true })).toHaveCount(0);
    if (mobile) await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(picker).toContainText("Saved Pi default");
    if (submitName) await page.getByRole("button", { name: submitName, exact: true }).click();
    await expect(page.locator("output")).toContainText('"model":"openai/gpt-6.1-sol"');
    // These launch dialogs hold draft choices only; reload starts a fresh draft.
    await page.reload();
    await expect(picker).toContainText("Sonnet");
  });
}
