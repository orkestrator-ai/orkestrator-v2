import { expect, test } from "@playwright/test";

test("short mobile viewports scroll configuration while keeping actions visible", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile project only");
  // Short enough that the configuration cannot fit whatever it currently holds,
  // so the footer has to stay pinned rather than being pushed out of the dialog.
  await page.setViewportSize({ width: 390, height: 300 });
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
  expect(layout.dialogBottom).toBeLessThanOrEqual(300);
  expect(layout.regionBottom).toBeLessThanOrEqual(layout.footerTop);
  expect(layout.footerBottom).toBeLessThanOrEqual(300);

  await configuration.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => configuration.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(cancelButton).toBeInViewport();
  await expect(confirmButton).toBeInViewport();

  await confirmButton.click();
  await expect(dialog).toBeHidden();
  // `ReviewTabType` is `AgentPlatform` now; the native mode lives in the option
  // label ("Claude Native"), not in the value, so the tab type is plain `claude`.
  await expect(page.getByTestId("review-launch-selection"))
    .toHaveText("claude|claude-sonnet|default");
});
test("one picker chooses the provider, the model, and the reasoning effort", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/review-launch");

  const trigger = page.getByRole("combobox", { name: "Agent, model and reasoning" });
  await expect(trigger).toContainText("Claude Sonnet");
  await expect(trigger).toContainText("Default");

  // Another provider's model is one hop away: no separate provider control.
  await trigger.click();
  // The fixture uses the legacy Claude/Codex/OpenCode allowlist. Providers
  // disabled in global settings must not reappear through the shared picker.
  await expect(page.getByRole("button", { name: "claude models" })).toBeVisible();
  await expect(page.getByRole("button", { name: "opencode models" })).toBeVisible();
  await expect(page.getByRole("button", { name: "cursor models" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "grok models" })).toHaveCount(0);
  await page.getByRole("button", { name: "codex models" }).click();
  await page.getByRole("group", { name: "Models" })
    .getByRole("menuitemradio", { name: /Codex Review/ })
    .click();
  await expect(trigger).toContainText("Codex Review");

  await trigger.click();
  await page.getByRole("group", { name: "Reasoning" })
    .getByRole("menuitemradio", { name: "High" })
    .click();
  await expect(trigger).toContainText("High");

  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByTestId("review-launch-selection"))
    .toHaveText("codex|codex-review|high");
});

test("the picker trigger stays a comfortable target and names the current choice", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/review-launch");

  const trigger = page.getByRole("combobox", { name: "Agent, model and reasoning" });
  await expect(trigger).toContainText("Claude Sonnet");

  const layout = await trigger.evaluate((element) => {
    const button = element as HTMLButtonElement;
    const rect = button.getBoundingClientRect();
    const label = button.querySelector(".truncate") as HTMLElement;
    return {
      height: rect.height,
      width: rect.width,
      scrollWidth: button.scrollWidth,
      clientWidth: button.clientWidth,
      labelWidth: label.getBoundingClientRect().width,
    };
  });

  // `min-h-11` keeps it the same size as the other review controls, and the
  // label truncates rather than widening the trigger past the dialog.
  expect(layout.height).toBeGreaterThanOrEqual(44);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.labelWidth).toBeLessThanOrEqual(layout.width);
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

  // The dialog header badge plus the single configuration step.
  expect(badges).toHaveLength(2);
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

test("chooses a provider, a model and an effort with the keyboard alone", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/review-launch");

  const trigger = page.getByRole("combobox", { name: "Agent, model and reasoning" });
  const reasoning = page.getByRole("group", { name: "Reasoning" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  // With no saved favourites, opening the picker starts on the selected
  // provider so the model list is immediately usable.
  await expect(page.getByRole("button", { name: "claude models" }))
    .toHaveAttribute("aria-pressed", "true");

  // A Radix menu is a single tab stop and calls preventDefault on Tab, so the
  // platform rail answers Left/Right instead — the keys the provider radio
  // group this control replaced also used.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "codex models" }))
    .toHaveAttribute("aria-pressed", "true");

  // Focus lands on the new provider's list, which is what announces the switch.
  const codexModel = page.getByRole("menuitemradio", { name: /Codex Review/ });
  await expect(codexModel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText("Codex Review");

  // Closing and reopening the picker restores the currently selected provider.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "codex models" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(codexModel).toBeFocused();

  // Reasoning shares the menu's roving focus group, so arrows reach it.
  await page.keyboard.press("ArrowDown");
  await expect(reasoning.getByRole("menuitemradio", { name: "Default" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(reasoning.getByRole("menuitemradio", { name: "Medium" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(reasoning.getByRole("menuitemradio", { name: "High" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText("High");

  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByTestId("review-launch-selection"))
    .toHaveText("codex|codex-review|high");
});

test("the phone layout reaches every choice through its drill-in views", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile project only");
  await page.goto("/review-launch");

  const trigger = page.getByRole("combobox", { name: "Agent, model and reasoning" });
  await trigger.click();

  // The phone layout stacks the choices instead of showing three columns.
  await expect(page.getByRole("group", { name: "Agent platforms" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Models" })).toHaveCount(0);
  await page.getByRole("button", { name: "codex models" }).click();
  await page.getByRole("menuitemradio", { name: /Codex Review/ }).click();
  await expect(trigger).toContainText("Codex Review");

  await trigger.click();
  await page.locator("[data-native-mobile-reasoning-trigger]").click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect(trigger).toContainText("High");

  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByTestId("review-launch-selection"))
    .toHaveText("codex|codex-review|high");
});
