import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("a secondary click opens the ticket menu and primary dragging still works after dismissal", async ({
  page,
}) => {
  await page.goto("/linear-board-drag");
  const card = page.locator('[data-issue-id="card-0"]');
  const target = page.locator('[data-issue-id="card-1"]');
  const preview = page.getByTestId("linear-board-card-overlay");
  await card.click({ button: "right" });
  const menu = page.getByTestId("ticket-context-menu");
  await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(page.getByTestId("last-move")).toBeEmpty();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  const start = (await card.boundingBox())!;
  const end = (await target.boundingBox())!;
  await page.mouse.move(start.x + 35, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 45, start.y + start.height / 2);
  await expect(preview).toBeVisible();
  await page.mouse.move(end.x + 35, end.y + end.height - 10, { steps: 5 });
  await expect(page.getByTestId("linear-board-drop-indicator")).toHaveAttribute(
    "data-placement",
    "after",
  );
  await page.mouse.up();
  await expect(page.getByTestId("last-move")).toHaveText('{"card-0":2.5}');
  await page.reload();
  await expect(page.getByTestId("linear-board-card").first()).toHaveAttribute(
    "data-issue-id",
    "card-1",
  );
});

test("the Linear drag preview casts a shadow while the board card stays flat", async ({ page }) => {
  await page.goto("/linear-board-drag");
  const source = page.getByTestId("linear-board-card").filter({ hasText: "ENG-0" });
  const preview = page.getByTestId("linear-board-card-overlay");
  await expect(source).toHaveCSS("box-shadow", "none");
  await source.hover();
  await expect(source).toHaveCSS("box-shadow", "none");

  const start = (await source.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 16, start.y + start.height / 2);
  await expect(preview).toBeVisible();
  await expect(preview).not.toHaveCSS("box-shadow", "none");
  await expect(source).toHaveCSS("box-shadow", "none");
  await page.mouse.up();

  await expect(preview).toHaveCount(0);
});

for (const placement of ["before", "after"] as const) {
  test(`scrolling during drag keeps the pointer's ${placement} placement`, async ({
    page,
  }, info) => {
    await page.goto("/linear-board-drag");
    const cards = page.getByTestId("linear-board-card");
    const source = cards.filter({ hasText: "ENG-0" });
    const start = (await source.boundingBox())!;
    const lane = page.getByRole("region", { name: "Todo lane" });
    const scroller = lane.locator(".overflow-y-auto");
    const scrollBox = (await scroller.boundingBox())!;
    const x = start.x + 35;
    await page.mouse.move(x, start.y + 20);
    await page.mouse.down();
    await page.mouse.move(x + 10, start.y + 20);
    await page.mouse.move(x, scrollBox.y + scrollBox.height - 8, { steps: 12 });
    // Real dnd-kit edge auto-scroll, observed by scroll position rather than a delay.
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
    await page.mouse.move(x, scrollBox.y + scrollBox.height / 2);
    const targetId = await cards.evaluateAll(
      (elements, middle) => {
        return elements
          .find((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.top > middle - 60 &&
              rect.bottom < middle + 100 &&
              element.getAttribute("data-issue-id") !== "card-0"
            );
          })
          ?.getAttribute("data-issue-id");
      },
      scrollBox.y + scrollBox.height / 2,
    );
    expect(targetId).toBeTruthy();
    const target = page.locator(`[data-issue-id="${targetId}"]`);
    const rect = (await target.boundingBox())!;
    await page.mouse.move(x, placement === "before" ? rect.y + 10 : rect.y + rect.height - 10);
    const indicator = page.getByTestId("linear-board-drop-indicator");
    await expect(indicator).toHaveAttribute("data-placement", placement);
    await expect(target.locator("..").getByTestId("linear-board-drop-indicator")).toBeVisible();
    const folder = path.join(process.cwd(), "output/visual-previews");
    await mkdir(folder, { recursive: true });
    await page.screenshot({
      path: path.join(folder, `linear-scroll-${placement}-${info.project.name}.png`),
    });
    await page.mouse.up();
    const index = Number(targetId!.split("-")[1]);
    const expected = placement === "before" ? index + 0.5 : index + 1.5;
    await expect(page.getByTestId("last-move")).toHaveText(JSON.stringify({ "card-0": expected }));
    const sequence = await cards.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-issue-id")),
    );
    const sourceIndex = sequence.indexOf("card-0");
    expect(sequence[sourceIndex + (placement === "before" ? 1 : -1)]).toBe(targetId);
    await page.reload();
    await expect(cards.first()).toBeVisible();
    expect(
      await cards.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-issue-id")),
      ),
    ).toEqual(sequence);
  });
}

for (const position of ["a gap between cards", "the left gutter"] as const) {
  test(`edge scrolling goes on while the pointer rests over ${position}`, async ({ page }) => {
    await page.goto("/linear-board-drag");
    const cards = page.getByTestId("linear-board-card");
    const scroller = page.getByRole("region", { name: "Todo lane" }).locator(".overflow-y-auto");
    const box = (await scroller.boundingBox())!;
    // Well inside the edge that scrolls, with a gap scrolled to exactly there.
    const gap = box.y + box.height - 12;
    await scroller.evaluate((element, y) => {
      const rects = Array.from(
        element.querySelectorAll('[data-testid="linear-board-card"]'),
        (card) => card.getBoundingClientRect(),
      );
      const middles = rects.slice(1).map((rect, index) => (rects[index]!.bottom + rect.top) / 2);
      element.scrollTop = middles.find((middle) => middle >= y)! - y;
    }, gap);
    const initial = await scroller.evaluate((element) => element.scrollTop);
    const start = (await cards.filter({ hasText: "ENG-1" }).first().boundingBox())!;
    const x = start.x + 35;
    await page.mouse.move(x, start.y + 20);
    await page.mouse.down();
    await page.mouse.move(x + 10, start.y + 20);
    // Cross into the edge zone at the final x, so the gutter case cannot
    // start scrolling from the gap at the center of the lane.
    const targetX = position === "the left gutter" ? box.x + 1 : x;
    await page.mouse.move(targetX, start.y + 20);
    await page.mouse.move(targetX, gap);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(initial + 200);
    await page.mouse.up();
  });
}
