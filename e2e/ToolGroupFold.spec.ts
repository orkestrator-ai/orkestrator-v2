import { expect, test, type Page } from "@playwright/test";
import { startAnchorProbe, stopAnchorProbe } from "./transcript-anchor-probe";

const scrollerSelector = '[data-transcript-scroller="true"]';
const contentSelector = ".tool-group-fold-content";

async function bottomGap(page: Page) {
  return page
    .locator(scrollerSelector)
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

/** Records every animation and every height the group's body takes, after layout. */
async function observeGroupBody(page: Page) {
  await page.evaluate((selector) => {
    const probe = {
      animations: [] as { name: string; duration: number }[],
      heights: [] as number[],
      gaps: [] as number[],
    };
    (window as unknown as { groupProbe: typeof probe }).groupProbe = probe;
    document.addEventListener("animationstart", (event) => {
      if (
        event.target instanceof HTMLElement &&
        (event.target.matches(selector) || event.target.matches(".tool-group-head-enter"))
      ) {
        probe.animations.push({
          name: event.animationName,
          duration: Number.parseFloat(getComputedStyle(event.target).animationDuration) * 1000,
        });
      }
    });
    const scroller = document.querySelector<HTMLElement>('[data-transcript-scroller="true"]')!;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      probe.gaps.push(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
      requestAnimationFrame(() => channel.port2.postMessage(0));
    };
    requestAnimationFrame(() => channel.port2.postMessage(0));
    const body = Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!;
    new ResizeObserver(() => probe.heights.push(body.getBoundingClientRect().height)).observe(body);
  }, contentSelector);
}

/** Waits for every running fold or open animation to finish. */
async function settleFold(page: Page) {
  await page.evaluate(
    (selector) =>
      Promise.all(
        Array.from(document.querySelectorAll(selector)).flatMap((element) =>
          element.getAnimations().map((animation) => animation.finished),
        ),
      ),
    `${contentSelector}, .tool-group-head-enter`,
  );
  await renderedFrame(page);
}

async function renderedFrame(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }),
  );
}

type GroupProbe = {
  animations: { name: string; duration: number }[];
  heights: number[];
  gaps: number[];
};

async function readGroupProbe(page: Page) {
  return page.evaluate(() => (window as unknown as { groupProbe: GroupProbe }).groupProbe);
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`a live group crossing the fold threshold folds into its line with ${reducedMotion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/streaming-transcript?long=1&fold=1");
    const row = page.locator("[data-chat-message-index]").last();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(2);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    const rowCount = await page.getByTestId("transcript-row-count").textContent();
    const frame = await row.locator("[data-transcript-group-frame]").elementHandle();
    await observeGroupBody(page);

    await page.getByRole("button", { name: "Grow tool group" }).click();
    // The rows fold away under the head line in the same host.
    const show = page.getByRole("button", { name: /^Show 3 tool calls:/ });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
    expect(await frame!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByTestId("transcript-row-count")).toHaveText(rowCount!);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    await settleFold(page);
    const folded = await readGroupProbe(page);
    expect(Math.max(...folded.gaps)).toBeLessThanOrEqual(2);
    if (reducedMotion === "reduce") {
      expect(folded.animations).toEqual([]);
    } else {
      expect(folded.animations).toContainEqual({ name: "tool-group-fold-close", duration: 500 });
      expect(folded.animations).toContainEqual({ name: "tool-group-head-enter", duration: 500 });
      // The height passed through intermediate values on its way to zero.
      const settled = new Set(folded.heights.map(Math.round));
      expect(settled.size).toBeGreaterThan(4);
    }

    await show.click();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(3);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    const animationName = await page
      .locator(contentSelector)
      .last()
      .evaluate((element) => getComputedStyle(element).animationName);
    expect(animationName).toBe(reducedMotion === "reduce" ? "none" : "tool-group-fold-open");

    await settleFold(page);
    expect(Math.max(...(await readGroupProbe(page)).gaps)).toBeLessThanOrEqual(2);

    // Folded by the reader, the rows animate away again.
    await page.getByRole("button", { name: /^Fold 3 tool calls:/ }).click();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    await settleFold(page);
    expect(Math.max(...(await readGroupProbe(page)).gaps)).toBeLessThanOrEqual(2);

    // Reverse an opening while its height is still changing.
    await show.click();
    if (reducedMotion === "no-preference") {
      await expect
        .poll(() =>
          row
            .locator(contentSelector)
            .evaluate((element) =>
              element.getAnimations().some((animation) => animation.playState === "running"),
            ),
        )
        .toBe(true);
    }
    await page.getByRole("button", { name: /^Fold 3 tool calls:/ }).click();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
    await settleFold(page);
    expect(Math.max(...(await readGroupProbe(page)).gaps)).toBeLessThanOrEqual(2);
  });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  for (const position of ["below", "above"] as const) {
    test(`a live group growing ${position} a released reader preserves their place with ${reducedMotion} motion`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion });
      await page.goto(
        `/streaming-transcript?long=1&fold=1${position === "above" ? "&foldAbove=1" : ""}`,
      );
      await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
      const scroller = page.locator(scrollerSelector);
      // Let the scroller attach its input listeners after the first bottom fill.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 0;
            const next = () => (++frames === 8 ? resolve() : requestAnimationFrame(next));
            requestAnimationFrame(next);
          }),
      );
      const box = (await scroller.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      const scrollEnded = scroller.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            element.addEventListener("scrollend", () => resolve(), { once: true });
          }),
      );
      await page.mouse.wheel(0, -250);
      await scrollEnded;
      await expect.poll(() => bottomGap(page)).toBeGreaterThan(100);
      // The reader has stopped and is reading: the wheel's animation (which can
      // restart around writes and so end more than once) is over.
      await page.waitForTimeout(400);
      const group = page.locator('[data-chat-message-key="live-fold"]');
      if (position === "above") {
        // Bring the group into overscan immediately above a released viewport.
        await expect
          .poll(async () => {
            if (await group.count()) return true;
            await page.mouse.wheel(0, -250);
            await page.waitForTimeout(100);
            return false;
          })
          .toBe(true);
        await group.evaluate((element) => {
          const list = element.closest<HTMLElement>('[data-transcript-scroller="true"]')!;
          list.scrollTop +=
            element.getBoundingClientRect().bottom - list.getBoundingClientRect().top + 40;
        });
        await page.waitForTimeout(400);
        const groupBox = (await group.boundingBox())!;
        expect(groupBox.y + groupBox.height).toBeLessThan(box.y);
      }
      const anchorIndex = await scroller.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll<HTMLElement>("[data-chat-message-index]")).find(
          (row) => row.getBoundingClientRect().bottom > viewport.top,
        )!.dataset.chatMessageIndex;
      });
      // The tail remains inside overscan, so this exercises an actual mounted group.
      const tail = group;
      await expect(tail.getByRole("button", { name: "Exec Command success" })).toHaveCount(2);
      await startAnchorProbe(scroller, `css:[data-chat-message-index="${anchorIndex}"]`);
      await page.getByRole("button", { name: "Grow tool group" }).click();
      await expect(tail.getByRole("button", { name: /^Show 3 tool calls:/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(tail.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
      await settleFold(page);
      const probe = await stopAnchorProbe(scroller);
      expect(probe.missing).toBe(0);
      expect(probe.maxError).toBeLessThanOrEqual(2);
      await expect.poll(() => bottomGap(page)).toBeGreaterThan(100);
    });
  }
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`short and restored open groups have no mount animation with ${reducedMotion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/streaming-transcript?long=1&fold=1");
    const body = page.locator('[data-chat-message-key="live-fold"]').locator(contentSelector);
    await expect(body).toHaveAttribute("data-state", "open");
    expect(await body.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await page.getByRole("button", { name: "Save and remount" }).click();
    await expect(page.getByTestId("list-generation")).toHaveText("1");
    expect(await body.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await page.getByRole("button", { name: "Grow tool group" }).click();
    const show = page.getByRole("button", { name: /^Show 3 tool calls:/ });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await settleFold(page);
    await show.click();
    await settleFold(page);
    await page.getByRole("button", { name: "Save and remount" }).click();
    await expect(page.getByTestId("list-generation")).toHaveText("2");
    await expect(body).toHaveAttribute("data-state", "open");
    expect(await body.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  });

  test(`summary entry does not replay after long-short-long with ${reducedMotion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/streaming-transcript?long=1&fold=1");
    await expect(page.locator(contentSelector).last()).toHaveAttribute("data-state", "open");
    await observeGroupBody(page);
    await page.getByRole("button", { name: "Grow tool group" }).click();
    await expect(page.getByRole("button", { name: /^Show 3 tool calls:/ })).toBeVisible();
    await settleFold(page);
    const first = (await readGroupProbe(page)).animations.filter(
      (animation) => animation.name === "tool-group-head-enter",
    );
    expect(first).toHaveLength(reducedMotion === "reduce" ? 0 : 1);
    await page.getByRole("button", { name: "Shrink tool group" }).click();
    await expect(
      page
        .locator('[data-chat-message-key="live-fold"]')
        .getByRole("button", { name: "Exec Command success" }),
    ).toHaveCount(2);
    await page.getByRole("button", { name: "Grow tool group" }).click();
    await expect(page.getByRole("button", { name: /^Show 3 tool calls:/ })).toBeVisible();
    await settleFold(page);
    expect(
      (await readGroupProbe(page)).animations.filter(
        (animation) => animation.name === "tool-group-head-enter",
      ),
    ).toEqual(first);
  });

  for (const interaction of ["focus", "selection"] as const) {
    test(`automatic folding preserves row ${interaction} with ${reducedMotion} motion`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion });
      await page.goto("/streaming-transcript?long=1&fold=1");
      const group = page.locator('[data-chat-message-key="live-fold"]');
      const control = group.getByRole("button", { name: "Exec Command success" }).first();
      await expect(control).toBeVisible();
      const held = await control.elementHandle();
      if (interaction === "focus") await control.focus();
      else
        await control.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = document.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
        });
      await renderedFrame(page);
      // Deliver the stream update without moving the reader's focus/selection.
      await page
        .getByRole("button", { name: "Grow tool group" })
        .evaluate((element: HTMLButtonElement) => element.click());
      await expect(group.getByRole("button", { name: /^Fold 3 tool calls:/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await page.waitForTimeout(550);
      expect(await held!.evaluate((element) => element.isConnected)).toBe(true);
      if (interaction === "focus") await expect(control).toBeFocused();
      else
        expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
          "Exec Command\nsuccess",
        );
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        document.getSelection()?.removeAllRanges();
      });
      await expect(group.getByRole("button", { name: /^Show 3 tool calls:/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(group.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
      await settleFold(page);
    });
  }
}

test("a 1,500-call group opens in a bounded viewport that owns its own scrolling", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=1500");
  const scroller = page.locator(scrollerSelector);
  const show = page.getByRole("button", { name: /^Show 1500 tool calls:/ });
  await expect(show).toBeVisible();
  await show.click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  await expect(viewport).toBeVisible();
  // Mounted work is proportional to the visible window, not to the group.
  await expect.poll(() => viewport.locator("[data-transcript-part-id]").count()).toBeGreaterThan(0);
  const mounted = await viewport.locator("[data-transcript-part-id]").count();
  expect(mounted).toBeLessThan(60);
  // The open group's row stays within the body ceiling plus its head line.
  const row = page.locator("[data-chat-message-index]").last();
  const ceiling = await page.evaluate(() =>
    Math.min(
      28 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      0.55 * innerHeight,
    ),
  );
  const rowHeight = (await row.boundingBox())!.height;
  expect(rowHeight).toBeLessThanOrEqual(ceiling + 120);
  // A wheel over the group scrolls the group, not the transcript. The open
  // animation settles first: the transcript follows the group as it grows.
  await settleFold(page);
  const outerBefore = await scroller.evaluate((element) => element.scrollTop);
  const innerScroller = viewport.locator("[data-virtuoso-scroller]");
  const innerBefore = await innerScroller.evaluate((element) => element.scrollTop);
  await innerScroller.hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => innerScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(innerBefore + 100);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(outerBefore, 0);
  // Still bounded after scrolling deep into it.
  expect(await viewport.locator("[data-transcript-part-id]").count()).toBeLessThan(60);
});

test("a selection inside a long group's viewport survives nearby inner scrolling", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=1500");
  await page.getByRole("button", { name: /^Show 1500 tool calls:/ }).click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  const innerScroller = viewport.locator("[data-virtuoso-scroller]");
  await expect
    .poll(() => viewport.locator("[data-tool-group-entry-index]").count())
    .toBeGreaterThan(2);
  const entry = viewport.locator('[data-tool-group-entry-index="1"]');
  const held = await entry.elementHandle();
  await entry.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  // Let selectionchange deliver, then move the reader past the inner
  // overscan (120 px) but inside the protection bound (8 rows beyond the
  // visible range): it stays mounted only because it is protected.
  await page.waitForTimeout(50);
  const entryHeight = (await entry.boundingBox())!.height;
  await innerScroller.evaluate((element, by) => {
    element.scrollTop += by;
  }, entryHeight * 7.5);
  await page.waitForTimeout(200);
  expect(await held!.evaluate((element) => element.isConnected)).toBe(true);
  expect(
    await page.evaluate(() => document.getSelection()?.toString().length ?? 0),
  ).toBeGreaterThan(0);
  // Far past it, protection releases and the window stays bounded.
  await innerScroller.evaluate((element) => {
    element.scrollTop += 20_000;
  });
  await expect.poll(() => held!.evaluate((element) => element.isConnected)).toBe(false);
  expect(await viewport.locator("[data-tool-group-entry-index]").count()).toBeLessThan(60);
});

test("focus inside a long group's viewport survives nearby inner scrolling", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=1500");
  await page.getByRole("button", { name: /^Show 1500 tool calls:/ }).click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  const innerScroller = viewport.locator("[data-virtuoso-scroller]");
  await expect
    .poll(() => viewport.locator("[data-tool-group-entry-index]").count())
    .toBeGreaterThan(2);
  const entry = viewport.locator('[data-tool-group-entry-index="1"]');
  const control = entry.locator("button, [tabindex]").first();
  await control.focus();
  const held = await control.elementHandle();
  const entryHeight = (await entry.boundingBox())!.height;
  // Past the inner overscan but inside the protection bound: the focused
  // control is neither unmounted nor blurred.
  await innerScroller.evaluate((element, by) => {
    element.scrollTop += by;
  }, entryHeight * 7.5);
  await page.waitForTimeout(200);
  expect(await held!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await held!.evaluate((element) => document.activeElement === element)).toBe(true);
  // Far past it, protection releases and the window stays bounded.
  await innerScroller.evaluate((element) => {
    element.scrollTop += 20_000;
  });
  await expect.poll(() => held!.evaluate((element) => element.isConnected)).toBe(false);
  expect(await viewport.locator("[data-tool-group-entry-index]").count()).toBeLessThan(60);
});

test("a waiting group that fits its cap follows appended calls as it starts overflowing", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=12&liveGroup=1");
  await page.getByRole("button", { name: /^Show 12 tool calls:/ }).click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  const inner = viewport.locator("[data-virtuoso-scroller]");
  const gap = () =>
    inner.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect(viewport.locator('[data-transcript-part-id="tool-5011"]')).toBeVisible();
  await expect
    .poll(() => inner.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBe(0);
  await page.getByRole("button", { name: "Append group calls" }).click();
  await expect
    .poll(() => inner.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await expect(viewport.locator('[data-transcript-part-id="tool-5019"]')).toBeVisible();
  await page.getByRole("button", { name: "Append group calls" }).click();
  await expect(viewport.locator('[data-transcript-part-id="tool-5027"]')).toBeVisible();
  await expect.poll(gap).toBeLessThanOrEqual(2);
  // Once the reader leaves the inner end, later calls respect their place.
  await inner.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(gap).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Append group calls" }).click();
  await expect(page.getByRole("button", { name: /^Fold 36 tool calls:/ })).toBeVisible();
  await expect.poll(() => inner.evaluate((element) => element.scrollTop)).toBe(0);
});

test("history prepended inside an open virtualized group preserves the visible call and its offset", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=80");
  await page.getByRole("button", { name: /^Show 80 tool calls:/ }).click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  const inner = viewport.locator("[data-virtuoso-scroller]");
  await expect(viewport.locator('[data-transcript-part-id="tool-5000"]')).toBeVisible();
  await inner.evaluate((element) => {
    element.scrollTop = 900;
  });
  const visibleCall = () =>
    inner.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const part = Array.from(
        element.querySelectorAll<HTMLElement>("[data-transcript-part-id]"),
      ).find((part) => part.getBoundingClientRect().bottom > top);
      return part
        ? { id: part.dataset.transcriptPartId!, offset: part.getBoundingClientRect().top - top }
        : null;
    });
  await expect
    .poll(async () => {
      const call = await visibleCall();
      return call !== null && call.id !== "tool-5000";
    })
    .toBe(true);
  const before = await visibleCall();
  await page.getByRole("button", { name: "Prepend group calls" }).click();
  await expect(page.getByRole("button", { name: /^Fold 90 tool calls:/ })).toBeVisible();
  await expect.poll(visibleCall).toEqual(before);
  expect(await viewport.locator("[data-tool-group-entry-index]").count()).toBeLessThan(60);
});
