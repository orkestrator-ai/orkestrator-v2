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
  test(`${view}: a same-minute page grows row zero and holds the original tool position`, async ({
    page,
  }) => {
    await page.goto(`/transcript-paging${view === "reviewer" ? "?reviewer" : ""}`);
    const list = page.locator("[data-virtuoso-scroller]");
    const load = page.getByRole("button", { name: "Load earlier messages", exact: true });
    const check = async () => {
      await expect(list).toBeVisible();
      await list.hover();
      await expect
        .poll(async () => {
          await page.mouse.wheel(0, -4000);
          return load.isVisible();
        })
        .toBe(true);
      await expect.poll(() => toolPosition(list, "call-40")).not.toBeNull();
      const before = (await toolPosition(list, "call-40"))!;
      expect(before.index).toBe("0");
      await load.click();
      await expect(load).toHaveCount(0);
      await expect
        .poll(async () => {
          const after = await toolPosition(list, "call-40");
          return after ? Math.abs(after.offset - before.offset) : Infinity;
        })
        .toBeLessThan(3);
      // Forty tools were inserted inside the same display row, above call-40.
      expect((await toolPosition(list, "call-40"))!.index).toBe("0");
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
