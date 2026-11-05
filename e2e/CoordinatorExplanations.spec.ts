import { expect, test } from "@playwright/test";
import path from "node:path";

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
