import { expect, test, type Locator } from "@playwright/test";
import { scrollDiagnostics, startAnchorProbe, stopAnchorProbe } from "./transcript-anchor-probe";

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
      const list = page.locator("[data-transcript-scroller]");
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
        // Sample the held tool through the whole transition, not only once it
        // settles: a visible jump followed by recovery is a failure.
        await startAnchorProbe(list, "call-40");
        await load.click();
        await expect(load).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Loading…", exact: true })).toHaveCount(0);
        await expect
          .poll(async () => {
            const after = await toolPosition(list, "call-40");
            return after ? Math.abs(after.offset - before.offset) : Infinity;
          })
          .toBeLessThan(3);
        // Let late measurement and the restoration's own frames finish.
        await page.waitForTimeout(800);
        const probe = await stopAnchorProbe(list);
        expect(probe.count).toBeGreaterThan(10);
        expect(probe.missing).toBe(0);
        expect(probe.maxError).toBeLessThanOrEqual(2);
        const diagnostics = await scrollDiagnostics(list);
        expect(diagnostics.staleCallbacksRefused ?? 0).toBeGreaterThanOrEqual(0);
        const after = (await toolPosition(list, "call-40"))!;
        if (mixed) expect(Number(after.index)).toBeGreaterThan(Number(before.index));
        else expect(after.index).toBe("0");
        if (mixed) {
          // The page added rows above: the transcript itself moved down.
          await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
        } else {
          // The page merged older calls into the open group, which scrolls
          // them in its own bounded viewport: that viewport moved instead.
          await expect
            .poll(() =>
              list.evaluate(
                (el) =>
                  el.querySelector<HTMLElement>(
                    "[data-transcript-inner-viewport] [data-virtuoso-scroller]",
                  )?.scrollTop ?? 0,
              ),
            )
            .toBeGreaterThan(500);
        }
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

for (const view of ["native", "reviewer"]) {
  test(`${view}: find reaches a prepended row after the base index moved`, async ({ page }) => {
    const query = new URLSearchParams({ mixed: "1" });
    if (view === "reviewer") query.set("reviewer", "1");
    await page.goto(`/transcript-paging?${query}`);
    const list = page.locator("[data-transcript-scroller]");
    await expect(list).toBeVisible();
    await list.hover();
    const load = page.getByRole("button", { name: "Load earlier messages", exact: true });
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -4000);
        return (await load.count()) > 0 && (await load.isVisible());
      })
      .toBe(true);
    await load.click();
    await expect(load).toHaveCount(0);
    // 80 display rows were prepended: Virtuoso's base index moved by 80, and
    // a match in the new history must still resolve to its own local row.
    await list.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
    const input = page.getByRole("textbox", { name: "Find in chat" });
    await expect(input).toBeVisible();
    await input.fill("Reached stop 3.");
    await expect(page.getByText(/^1 of 1$/)).toBeVisible();
    const row = list.locator('[data-chat-message-key^="row-3"]').first();
    await expect(row).toBeVisible();
    const placed = await row.evaluate((element) => {
      const scroller = element.closest<HTMLElement>("[data-transcript-scroller]")!;
      const box = element.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      return {
        index: Number(element.dataset.chatMessageIndex),
        inView: box.bottom > viewport.top && box.top < viewport.bottom,
        atEnd: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2,
      };
    });
    // row-3's prose is the 7th display row (two per source row, prose first).
    expect(placed.index).toBeLessThan(10);
    expect(placed.inView).toBe(true);
    expect(placed.atEnd).toBe(false);
  });
}
