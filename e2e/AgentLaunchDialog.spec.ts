import { expect, test } from "@playwright/test";

// Use the full Chrome browser: bundled Chromium does not expose the native
// datalist popup through automation on macOS. Install with `bunx playwright install chrome`.
// Do not pass a Chrome channel to an alternate engine, even for skipped tests.
test.use({
  channel:
    process.env.ORKESTRATOR_E2E_BROWSER && process.env.ORKESTRATOR_E2E_BROWSER !== "chromium"
      ? undefined
      : "chrome",
  headless: false,
});
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Requires Chrome's native datalist and CDP",
);

test("selects a native branch suggestion with the keyboard and confirms", async ({ page }) => {
  await page.goto("/agent-launch");
  const dialog = page.getByRole("dialog", { name: "Configure pull request" });
  const branch = page.getByLabel("Target branch");
  await expect(dialog).toBeVisible();
  await expect(branch).toHaveValue("main");
  await expect(branch).toHaveAttribute("list", "create-pr-model-target-branches");
  expect(
    await page
      .locator("datalist option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
  ).toEqual(["main", "release/2.0", "develop"]);
  await branch.click();
  await branch.press("ControlOrMeta+A");
  await branch.press("Backspace");
  await branch.pressSequentially("rel", { delay: 100 });
  // The browser-owned popup has no DOM locator to await.
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  // Playwright's macOS editing commands target the text editor. Native key codes
  // without those commands let Chrome's own datalist popup handle navigation.
  for (const [key, windowsVirtualKeyCode, nativeVirtualKeyCode] of [
    ["ArrowDown", 40, 125],
    ["Enter", 13, 36],
  ] as const) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code: key,
      windowsVirtualKeyCode,
      ...(process.platform === "darwin" ? { nativeVirtualKeyCode } : {}),
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
      windowsVirtualKeyCode,
      ...(process.platform === "darwin" ? { nativeVirtualKeyCode } : {}),
    });
    await page.waitForTimeout(500);
  }
  await cdp.detach();
  await expect(branch).toHaveValue("release/2.0");
  await expect(dialog).toBeVisible();
  const confirm = page.getByRole("button", { name: "Create pull request" });
  await expect(confirm).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("pr-launch-selection")).toHaveText("release/2.0");
});

test("allows a manually entered branch and resets it on reopen", async ({ page }) => {
  await page.goto("/agent-launch");
  const branch = page.getByLabel("Target branch");
  await branch.fill("main; unsafe");
  await expect(branch).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Create pull request" })).toBeDisabled();
  await branch.fill("manual/base");
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(page.getByTestId("pr-launch-selection")).toHaveText("manual/base");
  await page.getByRole("button", { name: "Reopen PR dialog" }).click();
  await expect(branch).toHaveValue("main");
});
