import { expect, test } from "@playwright/test";

test("short mobile viewports scroll configuration while keeping actions visible", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile project only");
  await page.setViewportSize({ width: 390, height: 360 });
  await page.goto("/review-launch");

  const dialog = page.getByRole("dialog", { name: "Configure code review" });
  const configuration = page.getByRole("region", { name: "Review configuration" });
  const cancelButton = page.getByRole("button", { name: "Cancel" });
  const confirmButton = page.getByRole("button", { name: "OK" });

  await expect(dialog).toBeVisible();
  await expect(configuration).toBeVisible();
  await expect(cancelButton).toBeInViewport();
  await expect(confirmButton).toBeInViewport();

  const layout = await configuration.evaluate((element) => {
    const region = element as HTMLElement;
    const dialogElement = region.closest('[role="dialog"]') as HTMLElement;
    const footer = dialogElement.querySelector('[data-slot="dialog-footer"]') as HTMLElement;
    const dialogRect = dialogElement.getBoundingClientRect();
    const regionRect = region.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    return {
      clientHeight: region.clientHeight,
      scrollHeight: region.scrollHeight,
      dialogTop: dialogRect.top,
      dialogBottom: dialogRect.bottom,
      regionBottom: regionRect.bottom,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
    };
  });

  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.dialogTop).toBeGreaterThanOrEqual(0);
  expect(layout.dialogBottom).toBeLessThanOrEqual(360);
  expect(layout.regionBottom).toBeLessThanOrEqual(layout.footerTop);
  expect(layout.footerBottom).toBeLessThanOrEqual(360);

  await configuration.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => configuration.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(cancelButton).toBeInViewport();
  await expect(confirmButton).toBeInViewport();

  await confirmButton.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("review-launch-selection"))
    .toHaveText("claude-cli|claude-sonnet|default");
});

test("provider and mode choices follow native radio keyboard behavior", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/review-launch");

  const providerGroup = page.getByRole("radiogroup", { name: "Review provider" });
  const claudeRadio = providerGroup.getByRole("radio", { name: "Claude" });
  const codexRadio = providerGroup.getByRole("radio", { name: "Codex" });

  await claudeRadio.focus();
  await claudeRadio.press("ArrowRight");
  await expect(codexRadio).toBeChecked();
  await expect(codexRadio).toBeFocused();
  await expect(codexRadio).toHaveAttribute("tabindex", "0");
  await expect(claudeRadio).toHaveAttribute("tabindex", "-1");

  const modeGroup = page.getByRole("radiogroup", { name: "Codex mode" });
  const cliRadio = modeGroup.getByRole("radio", { name: /^CLI/ });
  const nativeRadio = modeGroup.getByRole("radio", { name: /^Native/ });

  await cliRadio.focus();
  await cliRadio.press("ArrowRight");
  await expect(nativeRadio).toBeChecked();
  await expect(nativeRadio).toBeFocused();
  await expect(nativeRadio).toHaveAttribute("tabindex", "0");
  await expect(cliRadio).toHaveAttribute("tabindex", "-1");
});
