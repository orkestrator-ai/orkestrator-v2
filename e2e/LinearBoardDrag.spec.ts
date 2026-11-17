import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

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
