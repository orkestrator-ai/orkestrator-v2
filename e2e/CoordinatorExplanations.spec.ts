import { expect, test } from "@playwright/test";
import path from "node:path";
import { COORDINATOR_COMPOSER_PLACEHOLDER } from "../apps/web/src/components/projects/CoordinatorPanelNotices";

// Includes a full renderer reload as well as scrolling and interacting with the dock.
test.setTimeout(60_000);

test("short panes keep onboarding, starter and sending reachable", async ({ page }, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === "mobile-chromium" ? 390 : 1024,
    height: 360,
  });
  await page.goto("/coordinator-explanations");
  const dismiss = page.getByRole("button", { name: "Dismiss how the coordinator works" });
  await dismiss.scrollIntoViewIfNeeded();
  await expect(dismiss).toBeInViewport();
  await page.getByRole("button", { name: "Explain this project", exact: true }).click();
  const send = page.getByRole("button", { name: /Send message/ });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport();
  await page.screenshot({
    path: path.resolve(`output/visual-previews/c10-short-after-${testInfo.project.name}.png`),
  });
  await send.click();
  await expect(page.getByText("Message sent", { exact: true })).toBeVisible();
  await dismiss.click();
  await expect(page.getByRole("region", { name: "How the coordinator works" })).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-coordinator-intro-card]")).toHaveCount(0);
});

test("toolbar fits and every picker tier is visible before selection", async ({
  page,
}, testInfo) => {
  await page.goto("/coordinator-explanations");
  const help = page.getByRole("button", { name: "How the coordinator works", exact: true });
  await expect(help).toBeInViewport({ timeout: 15_000 });
  await expect(page.locator("[data-coordinator-tier-pill='enforced']")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Refresh repository status" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeInViewport();
  await help.click();
  await expect(page.locator("[data-coordinator-intro-menu]")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Fixture model", exact: true }).click();
  for (const tier of ["Enforced", "Provider-configured", "Advisory"]) {
    const pill = page
      .getByRole("group", { name: "Agent platforms", exact: true })
      .locator("[data-native-platform-badge]")
      .filter({ hasText: `Read-only · ${tier}` });
    await pill.scrollIntoViewIfNeeded();
    await expect(pill).toBeInViewport();
    await expect(pill).toBeVisible();
  }
  await page.screenshot({
    path: path.resolve(`output/visual-previews/c10-picker-after-${testInfo.project.name}.png`),
  });
});

test("wrapped coordinator placeholder stays above controls and recovers after clearing", async ({
  page,
}, testInfo) => {
  await page.goto("/coordinator-explanations");
  const input = page.getByRole("textbox", { name: COORDINATOR_COMPOSER_PLACEHOLDER });
  const placeholder = page.locator("[data-native-compose-placeholder]");
  const controls = page.locator('[data-native-compose-controls="primary"]');
  await expect(input).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const readGeometry = async () => {
    const placeholderBox = await placeholder.boundingBox();
    const inputBox = await input.boundingBox();
    const controlsBox = await controls.boundingBox();
    expect(placeholderBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    // Measure actual rendered bounds, not the classes implementing the layout.
    expect(placeholderBox!.y + placeholderBox!.height).toBeLessThanOrEqual(
      inputBox!.y + inputBox!.height + 1,
    );
    expect(placeholderBox!.y + placeholderBox!.height).toBeLessThanOrEqual(controlsBox!.y);
    expect(placeholderBox!.x).toBeGreaterThanOrEqual(inputBox!.x);
    expect(placeholderBox!.x + placeholderBox!.width).toBeLessThanOrEqual(
      inputBox!.x + inputBox!.width + 1,
    );
    return { input: inputBox!, controls: controlsBox!, placeholder: placeholderBox! };
  };
  const empty = await readGeometry();
  if (testInfo.project.name === "mobile-chromium") {
    const lineHeight = await placeholder.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).lineHeight),
    );
    expect(empty.placeholder.height).toBeGreaterThan(lineHeight * 2);
  }

  await input.focus();
  await page.keyboard.type("Draft");
  await expect(placeholder).toHaveCount(0);
  await expect(input).toHaveText("Draft");
  if (testInfo.project.name === "mobile-chromium") {
    expect((await input.boundingBox())!.height).toBeLessThan(empty.input.height);
  }
  await input.press("ControlOrMeta+A");
  await input.press("Backspace");
  await expect(placeholder).toHaveText(COORDINATOR_COMPOSER_PLACEHOLDER);
  const cleared = await readGeometry();
  expect(Math.abs(cleared.input.height - empty.input.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(cleared.controls.y - empty.controls.y)).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(placeholder).toHaveText(COORDINATOR_COMPOSER_PLACEHOLDER);
  const reloaded = await readGeometry();
  expect(Math.abs(reloaded.input.height - empty.input.height)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/coordinator-placeholder-regression-${testInfo.project.name}.png`,
    ),
  });
});
