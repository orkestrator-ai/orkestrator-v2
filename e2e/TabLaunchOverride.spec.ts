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
    page.getByRole("tab", { name: /Fix the parser/ }).getByTestId("tab-launch-override"),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /Run the checks/ }).getByTestId("tab-launch-override"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: /My own tab/ }).getByTestId("tab-launch-override"),
  ).toHaveCount(0);
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

test("a worker the command node launched on a leaf is marked on the leaf's tab", async ({
  page,
}) => {
  await page.goto("/tab-launch-override?leaf");
  await expect(page.getByText("Port the parser")).toBeVisible();
  const leaf = page.getByRole("region", { name: "Leaf node" });
  // The command node's row names the leaf's job tab, and only that tab.
  await expect(
    leaf.getByRole("tab", { name: /Lint the port/ }).getByTestId("tab-launch-override"),
  ).toHaveAttribute(
    "title",
    "This launch uses gpt-5.5. The coordinator overrode the saved default.",
  );
  await expect(leaf.getByTestId("tab-launch-override")).toHaveCount(1);
  // The command node's own tabs with the same ids keep their own answers.
  await expect(
    page.getByRole("tab", { name: /Fix the parser/ }).getByTestId("tab-launch-override"),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /Run the checks/ }).getByTestId("tab-launch-override"),
  ).toHaveCount(0);
  // The command node is read once for both strips; the leaf answers for itself.
  await page.getByRole("button", { name: "Show commands" }).click();
  const button = page.getByRole("button", { name: /list_coordinator_launch_overrides/ });
  const commands = (await button.textContent())!
    .split(",")
    .filter((command) => command.includes("coordinator"));
  expect(commands).toEqual(["list_coordinator_launch_overrides"]);
  const leafCommands = (await button.getAttribute("data-leaf-commands"))!
    .split(",")
    .filter((command) => command.includes("coordinator"));
  expect(leafCommands).toEqual(["list_coordinator_launch_overrides"]);
});
