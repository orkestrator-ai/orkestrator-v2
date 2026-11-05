import { expect, test } from "@playwright/test";
import path from "node:path";

test("resume picker shows fork lineage and resumes the selected branch", async ({ page }) => {
  await page.goto("/native-resume-session");
  const dialog = page.getByRole("dialog", { name: "Resume Session" });
  await expect(dialog.getByText("Alternative implementation", { exact: true })).toBeVisible();
  const row = dialog.getByRole("button", { name: /Compare implementations/ });
  await expect(row).toContainText("Alternative implementation");
  await row.click();
  await expect(page.getByTestId("selected-session")).toHaveText("fork");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("archived conversations stay reachable and restore before resuming", async ({ page }) => {
  await page.goto("/native-resume-session");
  const dialog = page.getByRole("dialog", { name: "Resume Session" });
  const archived = dialog.getByRole("button", { name: /A finished conversation/ });

  await expect(dialog.getByText("Original implementation")).toBeVisible();
  await expect(archived).toHaveCount(0);

  await dialog.getByRole("switch", { name: "Show archived (1)" }).click();
  await expect(archived).toContainText("Archived");
  // Newer than every live row, and still below them.
  const rows = dialog.getByRole("button", { name: /implementation|finished/ });
  expect((await rows.allTextContents()).at(-1)).toContain("A finished conversation");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await archived.click();
  await expect(page.getByTestId("archive-calls")).toHaveText("restore:kept");
  await expect(page.getByTestId("selected-session")).toHaveText("kept");
});

for (const failure of ["timeout", "long", "blank"] as const) {
  test(`resume picker failure layout: ${failure}`, async ({ page }, testInfo) => {
    const narrow = testInfo.project.name === "mobile-chromium";
    await page.setViewportSize({ width: narrow ? 390 : 1280, height: narrow ? 844 : 800 });
    await page.goto(`/native-resume-session?failure=${failure}`);
    const dialog = page.getByRole("dialog", { name: "Resume Session" });
    const heading = dialog.getByText("Failed to load sessions", { exact: true });
    const message =
      failure === "long" ? "x".repeat(500) : "Pi took too long to read its session history";
    const detail = dialog.getByText(message, { exact: true });

    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await expect(heading).toBeVisible();
      if (failure === "blank") {
        await expect(heading.locator("..").locator("p")).toHaveCount(1);
      } else {
        await expect(detail).toBeVisible();
        const headingBox = await heading.boundingBox();
        const detailBox = await detail.boundingBox();
        expect(detailBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height);
        if (failure === "long") {
          // An unbroken reason must wrap, not widen the dialog or escape it.
          expect(detailBox!.height).toBeGreaterThan(
            await detail.evaluate((element) =>
              Number.parseFloat(getComputedStyle(element).lineHeight),
            ),
          );
        }
      }
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    await page.screenshot({
      path: path.resolve(
        `output/visual-previews/resume-error-${failure}-${narrow ? "390" : "1280"}.png`,
      ),
    });
  });
}
