import { expect, test, type Locator, type Page } from "@playwright/test";

/** A real pointer drag: dnd-kit only activates after the pointer has moved 8px. */
async function dragTo(page: Page, source: Locator, x: number, y: number) {
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 5 });
  await page.mouse.move(x, y, { steps: 15 });
  await page.mouse.up();
}

test.describe("coordinator tab groups", () => {
  test("drags a side agent into its own group beside the coordinator, then back", async ({
    page,
  }, testInfo) => {
    // Phones show split groups one at a time through the pane switcher.
    test.skip(testInfo.project.name !== "desktop-chromium", "desktop layout only");
    await page.goto("/coordinator-pane-tree");
    const panes = page.locator("[data-coordinator-pane]");
    await expect(panes).toHaveCount(1);

    // Drop on the right edge of the only group: it splits, side by side.
    const box = (await panes.first().boundingBox())!;
    await dragTo(
      page,
      page.getByRole("button", { name: "Side 1" }),
      box.x + box.width - 10,
      box.y + box.height / 2,
    );

    await expect(panes).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Coordinator conversation" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Side 1 conversation" })).toBeVisible();
    const left = (await panes.nth(0).boundingBox())!;
    const right = (await panes.nth(1).boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x + left.width / 2);
    await expect(panes.nth(1).getByRole("button", { name: "Side 1" })).toBeVisible();
    await expect(panes.nth(0).getByRole("button", { name: "Side 1" })).toHaveCount(0);

    // Drop it back onto the first group's tab strip: the emptied group closes.
    const strip = (await panes.nth(0).getByRole("button", { name: "Side 2" }).boundingBox())!;
    await dragTo(
      page,
      panes.nth(1).getByRole("button", { name: "Side 1" }),
      strip.x + strip.width + 30,
      strip.y + strip.height / 2,
    );
    await expect(panes).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Side 1" })).toBeVisible();
  });
});

async function splitSide(page: Page) {
  await page.goto("/coordinator-pane-tree");
  const pane = page.locator("[data-coordinator-pane]").first();
  const box = (await pane.boundingBox())!;
  await dragTo(
    page,
    page.getByRole("button", { name: "Side 1", exact: true }),
    box.x + box.width - 10,
    box.y + box.height / 2,
  );
  await expect(page.locator("[data-coordinator-pane]")).toHaveCount(2);
}

test("sortable tab exposes its accessibility attributes and pointer listener", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop drag only");
  await page.goto("/coordinator-pane-tree");
  const tab = page.getByRole("button", { name: "Side 1", exact: true });
  await expect(tab).toHaveAttribute("tabindex", "0");
  await expect(tab).toHaveAttribute("aria-roledescription", "sortable");
  await expect(tab).toHaveAttribute("aria-describedby", /DndDescribedBy/);
  await splitSide(page);
});

test("keyboard focus routes Find and Escape between restored native composers", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "concurrent desktop panes");
  await splitSide(page);
  await page.reload();
  const main = page.getByRole("region", { name: "Coordinator conversation", exact: true });
  const side = page.getByRole("region", { name: "Side 1 conversation", exact: true });
  const mainInput = main.getByRole("textbox");
  const sideInput = side.getByRole("textbox");
  await mainInput.fill("draft retained in main");
  // Walk the actual tab order into the other composer without a pointer click.
  for (
    let index = 0;
    index < 15 && !(await sideInput.evaluate((element) => element === document.activeElement));
    index += 1
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(sideInput).toBeFocused();
  await expect(page.getByLabel("Selected conversation")).toHaveText("side-1");
  await page.keyboard.press("ControlOrMeta+f");
  await expect(side.getByRole("textbox", { name: "Find in chat" })).toBeFocused();
  await expect(main.getByRole("search", { name: "Find in agent chat" })).toHaveCount(0);
  await page.keyboard.press("Escape"); // Close Find, then stop the focused turn.
  await sideInput.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Side 1 stops")).toHaveText("1");
  await expect(page.getByLabel("Coordinator stops")).toHaveText("0");
  for (
    let index = 0;
    index < 15 && !(await mainInput.evaluate((element) => element === document.activeElement));
    index += 1
  ) {
    await page.keyboard.press("Shift+Tab");
  }
  await expect(mainInput).toBeFocused();
  await expect(mainInput).toHaveText("draft retained in main");
  await expect(page.getByLabel("Selected conversation")).toHaveText("main");
  await page.keyboard.press("ControlOrMeta+f");
  await expect(main.getByRole("textbox", { name: "Find in chat" })).toBeFocused();
  await page.keyboard.press("Escape");
  await mainInput.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Coordinator stops")).toHaveText("1");
  await expect(page.getByLabel("Side 1 stops")).toHaveText("1");
});

test("mobile switcher labels restored panes and keeps hidden composers mounted", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile pane switcher");
  await page.setViewportSize({ width: 1024, height: 900 });
  await splitSide(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const first = page.getByRole("tab", { name: "1. Coordinator", exact: true });
  const second = page.getByRole("tab", { name: "2. Side 1", exact: true });
  await expect(second).toHaveAttribute("aria-selected", "true");
  await first.click();
  const main = page.getByRole("region", { name: "Coordinator conversation", exact: true });
  const side = page.getByRole("region", {
    name: "Side 1 conversation",
    exact: true,
    includeHidden: true,
  });
  await main.getByRole("textbox").fill("keep my draft");
  const mountedMain = await main.elementHandle();
  await second.focus();
  await page.keyboard.press("Enter");
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(main).toBeHidden();
  await expect(side).toBeVisible();
  await expect(page.getByLabel("Selected conversation")).toHaveText("side-1");
  expect(await mountedMain!.evaluate((element) => element.isConnected)).toBe(true);
  await first.click();
  await expect(main.getByRole("textbox")).toHaveText("keep my draft");
});
