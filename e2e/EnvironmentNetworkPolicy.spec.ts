import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test("policy 2 explains the override instead of suggesting an image-only rebuild", async ({
  page,
}, testInfo) => {
  await page.goto("/environment-network-policy?state=unavailable");
  const status = page.getByRole("status");
  await expect(status).toContainText("Name checks require network policy 3");
  await expect(status).toContainText("network policy 2 override is removed");
  await expect(status).not.toContainText("image predates name checks");
  expect(await status.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("network policy 2 override is removed");
  const previews = path.resolve("output/visual-previews");
  await mkdir(previews, { recursive: true });
  await page.screenshot({
    path: path.join(previews, `egress-policy2-after-${testInfo.project.name}.png`),
    fullPage: true,
  });
});

for (const [state, text] of [
  ["enforced", "Names are checked too"],
  ["off", "Name checks were switched off"],
  ["old", "image predates name checks"],
  ["missing", "has not reported its firewall state"],
  ["failed", "firewall failed to apply"],
] as const) {
  test(`network state ${state} retains its distinct explanation after reload`, async ({ page }) => {
    await page.goto(`/environment-network-policy?state=${state}`);
    await expect(page.getByRole("status")).toContainText(text);
    await page.reload();
    await expect(page.getByRole("status")).toContainText(text);
  });
}

test("an unavailable backend does not claim an enforcement state", async ({ page }) => {
  await page.goto("/environment-network-policy?state=error");
  await expect(page.getByRole("heading", { name: "Container network policy" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});
