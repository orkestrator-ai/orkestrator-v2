import { expect, test, type Locator } from "@playwright/test";

async function toolPosition(list: Locator, id: string) {
  return list.evaluate((el, partId) => {
    const tool = el.querySelector<HTMLElement>(`[data-transcript-part-id="${partId}"]`);
    if (!tool) return null;
    return {
      offset: tool.getBoundingClientRect().top - el.getBoundingClientRect().top,
      index: tool.closest<HTMLElement>("[data-chat-message-index]")?.dataset.chatMessageIndex,
    };
  }, id);
}
for (const view of ["native", "reviewer"]) {
  for (const mixed of [false, true]) {
    test(`${view}: ${mixed ? "paging before prose" : "a same-minute page growing row zero"} holds the original tool position`, async ({
      page,
    }) => {
      const query = new URLSearchParams();
      if (view === "reviewer") query.set("reviewer", "1");
      if (mixed) query.set("mixed", "1");
      await page.goto(`/transcript-paging?${query}`);
      const list = page.locator("[data-virtuoso-scroller]");
      const load = page.getByRole("button", { name: "Load earlier messages", exact: true });
      const check = async () => {
        await expect(list).toBeVisible();
        if (!mixed) {
          // The same-minute reads coalesce into one folded group. Open it, and
          // before scrolling to the top, since focusing it scrolls the list:
          // the page then grows a tall row, and the group must stay open as
          // older calls are coalesced in front of the ones it was opened with.
          // Retried, as an activation that lands while the freshly mounted list
          // is still settling its row sizes can miss the trigger.
          await expect(async () => {
            const show = list.getByRole("button", { name: /^Show \d+ tool calls:/ });
            if ((await show.count()) > 0) await show.first().press("Enter");
            await expect(list.getByRole("button", { name: /^Fold \d+ tool calls:/ })).toBeVisible({
              timeout: 1_000,
            });
          }).toPass();
        }
        await list.hover();
        await expect
          .poll(async () => {
            await page.mouse.wheel(0, -4000);
            const [button, viewport, top] = await Promise.all([
              load.boundingBox(),
              list.boundingBox(),
              list.evaluate((el) => el.scrollTop),
            ]);
            return (
              top <= 1 &&
              button !== null &&
              viewport !== null &&
              button.y >= viewport.y &&
              button.y + button.height <= viewport.y + viewport.height
            );
          })
          .toBe(true);
        await expect.poll(() => toolPosition(list, "call-40")).not.toBeNull();
        const before = (await toolPosition(list, "call-40"))!;
        expect(before.index).toBe(mixed ? "1" : "0");
        await load.click();
        await expect(load).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Loading…", exact: true })).toHaveCount(0);
        await expect
          .poll(async () => {
            const after = await toolPosition(list, "call-40");
            return after ? Math.abs(after.offset - before.offset) : Infinity;
          })
          .toBeLessThan(3);
        const after = (await toolPosition(list, "call-40"))!;
        if (mixed) expect(Number(after.index)).toBeGreaterThan(Number(before.index));
        else expect(after.index).toBe("0");
        await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
      };
      await check();
      await page.getByRole("button", { name: "Switch environment" }).click();
      await page.getByRole("button", { name: "Return to transcript" }).click();
      await expect(list).toBeVisible();
      await page.reload();
      await check();
    });
  }
}
