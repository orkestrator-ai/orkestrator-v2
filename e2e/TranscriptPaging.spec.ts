import { expect, test, type Locator } from "@playwright/test";
import { expectPlaceHeld, holdPosition } from "./transcript-hold";
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
  for (const [mixed, bounded] of [
    [false, false],
    [true, false],
    // A view whose own byte bound cut it pages from the cursor it names (0232).
    ...(view === "native" ? [[true, true]] : []),
  ]) {
    test(`${view}: ${mixed ? "paging before prose" : "a same-minute page growing row zero"}${bounded ? " in a byte-bounded view" : ""} holds the original tool position`, async ({
      page,
    }) => {
      const query = new URLSearchParams();
      if (view === "reviewer") query.set("reviewer", "1");
      if (mixed) query.set("mixed", "1");
      if (bounded) query.set("bounded", "1");
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
        // Newly mounted short groups have their full measured height, with no
        // fold-open animation to move the held tool after capture.
        if (mixed) {
          const bodies = list.locator('.tool-group-fold-content[data-state="open"]');
          expect(await bodies.count()).toBeGreaterThan(0);
          expect(
            await bodies.evaluateAll((elements) =>
              elements.every((element) => getComputedStyle(element).animationName === "none"),
            ),
          ).toBe(true);
        }
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

// The reviewer only: the native tab's background poll (every 500–1500 ms)
// retires a history page still in flight, so a page slow enough to move during
// never lands there. That is the session hook's paging policy, not scrolling.
test("reviewer: a reader who moves while a page loads is held where they moved to", async ({
  page,
}) => {
  await page.goto("/transcript-paging?mixed=1&slow=1&reviewer=1");
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
  const loading = page.getByRole("button", { name: "Loading…", exact: true });
  await expect(loading).toBeVisible();
  // The page is held for 1.5 s. Move away from where it was requested and let
  // the wheel settle, then hold whichever tool is now nearest the top.
  await page.mouse.wheel(0, 360);
  await page.waitForTimeout(400);
  await expect(loading).toBeVisible();
  const held = await list.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const tools = Array.from(
      el.querySelectorAll<HTMLElement>("[data-transcript-part-id^='call-']"),
    );
    return tools.find((tool) => tool.getBoundingClientRect().top - top >= 0)?.dataset
      .transcriptPartId;
  });
  expect(held).toBeDefined();
  expect(held).not.toBe("call-40");
  const before = (await toolPosition(list, held!))!;
  await startAnchorProbe(list, held!);
  await expect(loading).toHaveCount(0, { timeout: 5_000 });
  // Let late measurement and the restoration's own frames finish.
  await page.waitForTimeout(800);
  const probe = await stopAnchorProbe(list);
  expect(probe.count).toBeGreaterThan(10);
  expect(probe.missing).toBe(0);
  expect(probe.maxError).toBeLessThanOrEqual(2);
  const after = (await toolPosition(list, held!))!;
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(3);
  // The page really did land above the reader.
  expect(Number(after.index)).toBeGreaterThan(Number(before.index) + 40);
});

for (const view of ["native", "reviewer"] as const) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`${view}: paging folds a visible short group during held-place restoration with ${reducedMotion} motion`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion });
      await page.goto(`/transcript-paging?short=1${view === "reviewer" ? "&reviewer=1" : ""}`);
      const list = page.locator("[data-transcript-scroller]");
      await list.hover();
      const load = page.getByRole("button", { name: "Load earlier messages", exact: true });
      await expect
        .poll(async () => {
          await page.mouse.wheel(0, -4000);
          return await list.evaluate((element) => element.scrollTop <= 1);
        })
        .toBe(true);
      await expect(load).toBeVisible();
      await page.waitForTimeout(400);
      const group = list.locator("[data-transcript-group-frame]").first();
      await expect(group.getByRole("button", { name: /^Read .*success$/ })).toHaveCount(2);
      // Hold the group frame while the original member rows are replaced by
      // the newest call's summary during restoration.
      const anchor = "css:[data-transcript-group-frame]";
      await startAnchorProbe(list, anchor);
      await load.click();
      await expect(load).toHaveCount(0);
      const show = list.getByRole("button", { name: /^Show 60 tool calls:/ });
      await expect(show).toHaveAttribute("aria-expanded", "false");
      await expect(list.getByRole("button", { name: /^Read .*success$/ })).toHaveCount(0);
      await page.evaluate(async () => {
        await Promise.all(
          Array.from(
            document.querySelectorAll(".tool-group-fold-content, .tool-group-head-enter"),
          ).flatMap((element) => element.getAnimations().map((animation) => animation.finished)),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
        );
      });
      await expect(group.locator('[data-transcript-part-id="call-59"]')).toHaveCount(1);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(group.locator('[data-transcript-part-id="call-58"]')).toHaveCount(0);
      const probe = await stopAnchorProbe(list);
      expect(probe.count).toBeGreaterThan(0);
      expect(probe.missing).toBe(0);
      expect(
        probe.maxError,
        JSON.stringify({
          expected: probe.expected,
          trace: probe.trace
            .filter((sample) => Math.abs(sample[1]! - probe.expected) > 2)
            .slice(0, 8),
          diagnostics: await scrollDiagnostics(list),
        }),
      ).toBeLessThanOrEqual(2);
    });
  }
}

/**
 * The live shape of a long tool-only conversation (todo 0090): the 100-row
 * window is one folded group of 100 calls and the answer. History merges
 * into that group, so a page adds no display row (only the prompt, once it
 * arrives), and the folded line keeps the newest call's part id throughout.
 */
async function foldedGroupAtTop(page: import("@playwright/test").Page, query: URLSearchParams) {
  await page.goto(`/transcript-paging?${query}`);
  const list = page.locator("[data-transcript-scroller]");
  await expect(list).toBeVisible();
  await list.hover();
  const load = page.getByRole("button", { name: "Load earlier messages", exact: true });
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
  await expect(list.getByRole("button", { name: /^Show 100 tool calls:/ })).toBeVisible();
  return { list, load };
}

/** The folded line's place, the list's scroll range and the controller's last outcome. */
async function foldedLine(list: Locator) {
  return list.evaluate((el) => {
    const line = el.querySelector<HTMLElement>('[data-transcript-part-id="call-149"]');
    const diagnostics = (
      el as unknown as { orkTranscriptScrollDiagnostics?: () => { lastOutcome?: string } }
    ).orkTranscriptScrollDiagnostics?.();
    return {
      offset: line ? line.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
      index: Number(
        line?.closest<HTMLElement>("[data-chat-message-index]")?.dataset.chatMessageIndex,
      ),
      visible:
        line !== null &&
        line.getBoundingClientRect().bottom > el.getBoundingClientRect().top &&
        line.getBoundingClientRect().top < el.getBoundingClientRect().top + el.clientHeight,
      count: line?.textContent?.match(/(\d+) tool calls/)?.[1],
      scrollTop: el.scrollTop,
      maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
      outcome: diagnostics?.lastOutcome,
    };
  });
}

for (const view of ["native", "reviewer"]) {
  test(`${view}: a page coalescing into the folded group at the top holds its line`, async ({
    page,
  }) => {
    const query = new URLSearchParams({ stops: "150", paged: "12", prompt: "1" });
    if (view === "reviewer") query.set("reviewer", "1");
    const { list, load } = await foldedGroupAtTop(page, query);
    const before = await foldedLine(list);
    expect(before.offset).not.toBeNull();
    await startAnchorProbe(list, "call-149");
    await load.click();
    // Twelve calls merged into the group; no display row was added above it.
    await expect.poll(async () => (await foldedLine(list)).count).toBe("112");
    await expect(load).toBeVisible();
    await page.waitForTimeout(800);
    const probe = await stopAnchorProbe(list);
    expect(probe.missing).toBe(0);
    expect(probe.maxError).toBeLessThanOrEqual(2);
  });

  // The page brings the prompt, the one display row above the group. With room
  // to scroll the line is held exactly; a transcript that then fits its
  // viewport cannot scroll, so the controller ends clamped at the top and the
  // prompt pushes the line down (the 124 px the live spec reported). The
  // reviewer view hides the workflow's prompts, so only the native tab has it.
  for (const height of view === "native" ? [300, 1000] : []) {
    test(`${view}: the prompt landing above the folded group at ${height} px`, async ({ page }) => {
      await page.setViewportSize({ width: page.viewportSize()!.width, height });
      const query = new URLSearchParams({ stops: "150", prompt: "1" });
      if (view === "reviewer") query.set("reviewer", "1");
      const { list, load } = await foldedGroupAtTop(page, query);
      const before = await foldedLine(list);
      await startAnchorProbe(list, "call-149");
      await load.click();
      await expect(load).toHaveCount(0);
      await expect(list.locator('[data-chat-message-key="prompt"]')).toHaveCount(1);
      await expect.poll(async () => (await foldedLine(list)).outcome).toMatch(/converged|clamped/);
      await page.waitForTimeout(800);
      const probe = await stopAnchorProbe(list);
      const after = await foldedLine(list);
      expect(probe.missing).toBe(0);
      // Where the list must stand to hold the line, as far as it can scroll.
      const hold = holdPosition(
        { ...before, offset: before.offset! },
        { ...after, offset: after.offset! },
      );
      expectPlaceHeld(
        {
          anchorStop: 149,
          anchorIndexBefore: before.index,
          anchorAfter: after,
          hold,
          scrollTopAfter: after.scrollTop,
        },
        `${view}: prompt landing at ${height} px`,
      );
      expect(hold.errorPx).toBeLessThanOrEqual(1);
      if (height === 300) {
        expect(hold.clampedPx).toBe(0);
        expect(after.outcome).toBe("converged");
        expect(after.scrollTop).toBeGreaterThan(0);
        expect(probe.maxError).toBeLessThanOrEqual(2);
      } else {
        expect(after.maxScrollTop).toBe(0);
        expect(hold.clampedPx).toBeGreaterThan(8);
        expect(after.outcome).toBe("clamped");
        expect(after.offset! - before.offset!).toBeGreaterThan(8);
      }
    });
  }
}
