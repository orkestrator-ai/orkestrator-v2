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
