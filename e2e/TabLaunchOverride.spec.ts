import { expect, test, type Page } from "@playwright/test";

const open = async (page: Page) => {
  await page.goto("/tab-launch-override");
  await expect(page.getByText("Fix the parser")).toBeVisible();
};

test("only the tab whose launch overrode the default is marked", async ({ page }) => {
  await open(page);
  const marker = page.getByTestId("tab-launch-override");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveText("requested");
  await expect(marker).toHaveAttribute(
    "title",
    "This launch uses claude-opus-5-5 · max. The coordinator overrode the saved default.",
  );
  // In the tab it belongs to: the word sits between that tab's title and close button.
  await expect(
    page.getByRole("button", { name: /Fix the parser.*requested/ }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Run the checks.*requested/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /My own tab.*requested/ })).toHaveCount(0);
});

test("the whole strip makes one coordinator read", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("tab-launch-override")).toHaveCount(1);
  await page.getByRole("button", { name: "Show commands" }).click();
  const commands = (await page.getByTestId("commands").textContent())!
    .split(",")
    .filter((command) => command.includes("coordinator"));
  expect(commands).toEqual(["list_coordinator_launch_overrides"]);
});

test("the marker keeps its full word and a narrow strip scrolls rather than wrapping", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await open(page);
  const marker = page.getByTestId("tab-launch-override");
  await expect(marker).toBeVisible();
  const box = await marker.evaluate((element) => ({
    clipped: element.scrollWidth > element.clientWidth,
    wraps: element.getBoundingClientRect().height > 24,
  }));
  expect(box).toEqual({ clipped: false, wraps: false });
  const strip = page.locator(".overflow-x-auto").first();
  expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // The page itself does not gain a sideways scroll.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
