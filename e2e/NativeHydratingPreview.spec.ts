import { expect, test } from "@playwright/test";

test("a non-pageable hydrating preview never mounts a header or shifts the transcript", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "desktop coverage is sufficient for virtualized transcript anchoring",
  );
  await page.goto("/native-hydrating-preview");

  const shell = page.getByTestId("native-hydrating-preview-shell");
  const scroller = shell.locator('[data-virtuoso-scroller="true"]');
  await expect(page.getByTestId("native-hydration-state")).toHaveText("preview");
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
  await expect(scroller).toBeVisible();

  await scroller.evaluate((element) => {
    element.scrollTop = 420;
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const previewScrollTop = await scroller.evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "Hydrate transcript" }).click();

  await expect(page.getByTestId("native-hydration-state")).toHaveText("hydrated");
  await expect(shell.getByText("Hydrated transcript snapshot")).toBeAttached();
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(previewScrollTop);
});
