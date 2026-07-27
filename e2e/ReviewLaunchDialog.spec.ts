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
  const confirmButton = page.getByRole("button", { name: "Start review" });

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
    .toHaveText("claude-native|claude-sonnet|default");
});

test("provider choices follow native radio keyboard behavior", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/review-launch");

  const providerGroup = page.getByRole("radiogroup", { name: "Review provider" });
  const claudeRadio = providerGroup.getByRole("radio", { name: "Claude" });
  const codexRadio = providerGroup.getByRole("radio", { name: "Codex" });
  const openCodeRadio = providerGroup.getByRole("radio", { name: "OpenCode" });

  await claudeRadio.focus();
  await claudeRadio.press("ArrowRight");
  await expect(codexRadio).toBeChecked();
  await expect(codexRadio).toBeFocused();
  await expect(codexRadio).toHaveAttribute("tabindex", "0");
  await expect(claudeRadio).toHaveAttribute("tabindex", "-1");

  await codexRadio.press("ArrowRight");
  await expect(openCodeRadio).toBeChecked();

  // Both ends wrap around.
  await openCodeRadio.press("ArrowRight");
  await expect(claudeRadio).toBeChecked();
  await expect(claudeRadio).toBeFocused();
  await claudeRadio.press("ArrowLeft");
  await expect(openCodeRadio).toBeChecked();
  await expect(openCodeRadio).toBeFocused();

  // Home and End jump straight to the ends.
  await openCodeRadio.press("Home");
  await expect(claudeRadio).toBeChecked();
  await claudeRadio.press("End");
  await expect(openCodeRadio).toBeChecked();
  await expect(openCodeRadio).toHaveAttribute("tabindex", "0");
  await expect(claudeRadio).toHaveAttribute("tabindex", "-1");
});

test("model trigger grows to contain its name and description", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/review-launch");

  const modelTrigger = page.getByRole("combobox", { name: "Model" });
  await expect(modelTrigger).toContainText("Claude Sonnet");
  await expect(modelTrigger).toContainText("Balanced reviews for everyday code changes");

  const layout = await modelTrigger.evaluate((element) => {
    const trigger = element as HTMLElement;
    const textStack = trigger.firstElementChild as HTMLElement;
    const name = textStack.children[0] as HTMLElement;
    const description = textStack.children[1] as HTMLElement;
    const triggerRect = trigger.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    const descriptionRect = description.getBoundingClientRect();

    return {
      clientHeight: trigger.clientHeight,
      scrollHeight: trigger.scrollHeight,
      triggerTop: triggerRect.top,
      triggerBottom: triggerRect.bottom,
      triggerHeight: triggerRect.height,
      nameTop: nameRect.top,
      nameBottom: nameRect.bottom,
      descriptionTop: descriptionRect.top,
      descriptionBottom: descriptionRect.bottom,
    };
  });

  expect(layout.triggerHeight).toBeGreaterThan(44);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight);
  expect(layout.nameTop).toBeGreaterThanOrEqual(layout.triggerTop);
  expect(layout.descriptionTop).toBeGreaterThanOrEqual(layout.nameBottom);
  expect(layout.descriptionBottom).toBeLessThanOrEqual(layout.triggerBottom);
});

test("step and header icon badges render as equally sized circles", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/review-launch");

  const dialog = page.getByRole("dialog", { name: "Configure code review" });
  await expect(dialog).toBeVisible();

  const badges = await dialog.evaluate((element) =>
    Array.from(element.querySelectorAll<HTMLElement>(".size-8.place-items-center"))
      .map((badge) => {
        const rect = badge.getBoundingClientRect();
        const glyph = badge.querySelector("svg")?.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          radius: Number.parseFloat(getComputedStyle(badge).borderTopLeftRadius),
          glyphWidth: glyph?.width ?? 0,
          glyphHeight: glyph?.height ?? 0,
        };
      }),
  );

  // The dialog header badge plus one marker per step.
  expect(badges).toHaveLength(4);
  for (const badge of badges) {
    // Squares, not rectangles: shrink-0 keeps flex siblings from squashing them.
    expect(badge.width).toBe(32);
    expect(badge.height).toBe(32);
    // Fully rounded, so a square box renders as a circle rather than a squircle.
    expect(badge.radius).toBeGreaterThanOrEqual(16);
    expect(badge.glyphWidth).toBe(16);
    expect(badge.glyphHeight).toBe(16);
  }
});
