import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

test("floating actions fit their icon, reopen with keyboard, and navigate", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/coordinator-actions");
  const icon = page.getByRole("button", { name: "Actions, 1 waiting" });
  await expect(icon).toHaveAttribute("aria-expanded", "false");
  const width = await icon.evaluate((element) => ({
    icon: element.getBoundingClientRect().width,
    wrapper: element.parentElement!.getBoundingClientRect().width,
  }));
  expect(Math.abs(width.icon - width.wrapper)).toBeLessThan(1);
  await page.screenshot({
    path: path.resolve("output/visual-previews/actions-pr-metadata-narrow.png"),
  });
  await icon.focus();
  await expect(icon).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(icon).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Transcript control" }).focus();
  await icon.focus();
  await expect(icon).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /#42 Improve search and filters/ })).toBeVisible();
  await page.getByRole("button", { name: "Which option?" }).click();
  await expect(page.getByTestId("anchor")).toHaveText("assistant");
  await page.screenshot({
    path: path.resolve("output/visual-previews/actions-pr-metadata-open.png"),
  });
});

test("wide actions dock below mail with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/coordinator-actions");
  await expect(page.getByRole("button", { name: "Which option?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Actions, 1 waiting" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /#42 Improve search and filters/ })).toBeVisible();
  const actions = await page.getByRole("region", { name: "Actions", exact: true }).boundingBox();
  const mail = await page.getByText("One message waiting").boundingBox();
  expect(actions!.y).toBeGreaterThan(mail!.y + mail!.height);
  await page.screenshot({
    path: path.resolve("output/visual-previews/actions-pr-metadata-wide.png"),
  });
});

test("real shell measures viewport cutoff, excludes overscan, navigates and resolves live questions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/coordinator-actions-transcript");
  await page.getByRole("button", { name: "Read end", exact: true }).click();
  await expect(page.getByRole("button", { name: "Question at 40", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Live blocking question", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Answer question", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Done: Live blocking question", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Read start", exact: true }).click();
  await expect(page.getByRole("button", { name: "Question at 40", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Read end", exact: true }).click();
  await page.getByRole("button", { name: "Question at 5", exact: true }).click();
  await expect(page.getByTestId("anchor")).toHaveText("row-5");
  await page.screenshot({ path: path.resolve("output/visual-previews/actions-shell-desktop.png") });
  await page.reload();
  await page.getByRole("button", { name: "Read end", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Live blocking question", exact: true }),
  ).toBeVisible();
});

/** The jumped-to item's glow, measured against its row and the scroller. */
async function measureJumpGlow(page: import("@playwright/test").Page) {
  const glow = page.locator("[data-conversation-target-glow]");
  await expect(glow).toHaveCount(1);
  return glow.evaluate((element) => {
    const row = element.closest<HTMLElement>("[data-conversation-target]")!;
    const scroller = element.closest<HTMLElement>("[data-virtuoso-scroller]")!;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    return {
      rowKey: row.dataset.chatMessageKey,
      phase: element.getAttribute("data-conversation-target-glow"),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      width: box.width,
      rowWidth: rowBox.width,
      // Room the glow has before the scroller would clip it.
      roomLeft: box.left - scrollerBox.left,
      roomRight: scrollerBox.right - box.right,
      animationName: style.animationName,
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      rowBackground: getComputedStyle(row).backgroundColor,
      rowOutline: getComputedStyle(row).outlineStyle,
    };
  });
}

for (const viewport of [
  { name: "desktop", width: 1600, height: 900 },
  { name: "narrow", width: 390, height: 844 },
]) {
  test(`a jump glows the item at its own width and fades (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/coordinator-actions-transcript");
    await page.getByRole("button", { name: "Read end", exact: true }).click();
    const card = page.getByRole("button", { name: "Question at 5", exact: true });
    // A narrow pane folds the panel to its icon; focus opens it.
    if (viewport.width < 800) await page.getByRole("button", { name: /^Actions/ }).focus();
    await card.click();
    await expect(page.getByTestId("anchor")).toHaveText("row-5");

    const glow = await measureJumpGlow(page);
    expect(glow.rowKey).toBe("row-5");
    // The item's own box (the transcript column), not the full-width row.
    expect(glow.width).toBeLessThan(glow.rowWidth);
    expect(glow.width).toBeLessThanOrEqual(768);
    // The 9px glow fits inside the scroller on both sides.
    expect(glow.roomLeft).toBeGreaterThanOrEqual(9);
    expect(glow.roomRight).toBeGreaterThanOrEqual(9);
    expect(glow.animationName).toMatch(/^conversation-target-glow-[ab]$/);
    expect(glow.boxShadow).toContain("rgba(56, 189, 248");
    expect(glow.outlineStyle).toBe("none");
    expect(glow.rowBackground).toBe("rgba(0, 0, 0, 0)");
    expect(glow.rowOutline).toBe("none");
    await page.screenshot({
      path: path.resolve(`output/visual-previews/jump-highlight-fixed-${viewport.name}.png`),
    });

    // Sample the real CSS animation at fixed times so slow screenshots cannot
    // race the hook's cleanup timer. A constant shadow must fail this check.
    const shadowAt = async (time: number) =>
      page.locator("[data-conversation-target-glow]").evaluate((element, time) => {
        const animation = element.getAnimations()[0]!;
        animation.pause();
        animation.currentTime = time;
        const shadow = getComputedStyle(element).boxShadow;
        return Math.max(
          ...Array.from(shadow.matchAll(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/g), (match) =>
            Number(match[1]),
          ),
        );
      }, time);
    const initialAlpha = await shadowAt(0);
    const fadingAlpha = await shadowAt(1500);
    expect(initialAlpha).toBeGreaterThan(0.1);
    expect(fadingAlpha).toBeGreaterThan(0);
    expect(fadingAlpha).toBeLessThan(initialAlpha / 2);
    const finalAlpha = await shadowAt(2400);
    expect(finalAlpha).toBeLessThan(0.01);
    expect(finalAlpha).toBeLessThan(fadingAlpha);
    await page.screenshot({
      path: path.resolve(`output/visual-previews/jump-highlight-fixed-${viewport.name}-fading.png`),
    });
    // A repeat jump to the same item restarts the glow.
    if (viewport.width < 800) await page.getByRole("button", { name: /^Actions/ }).focus();
    await card.click();
    await expect.poll(async () => (await measureJumpGlow(page)).phase).not.toBe(glow.phase);
    // It is removed once the period ends.
    await expect(page.locator("[data-conversation-target-glow]")).toHaveCount(0, {
      timeout: 4_000,
    });
    await expect(page.locator("[data-conversation-target]")).toHaveCount(0);
    // The item has the same box with and without the highlight: no reflow.
    const after = await page
      .locator('[data-chat-message-key="row-5"] [data-transcript-item]')
      .first()
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      });
    expect(after).toEqual(glow.box);
  });
}

test("with reduced motion the jump glow shows without fading and is removed", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/coordinator-actions-transcript");
  await page.getByRole("button", { name: "Read end", exact: true }).click();
  await page.getByRole("button", { name: "Question at 5", exact: true }).click();
  const glow = await measureJumpGlow(page);
  expect(glow.animationName).toBe("none");
  expect(glow.boxShadow).toContain("rgba(56, 189, 248, 0.55)");
  await page.waitForTimeout(1_500);
  // Still at full strength part-way through the period.
  expect((await measureJumpGlow(page)).boxShadow).toContain("rgba(56, 189, 248, 0.55)");
  await page.screenshot({
    path: path.resolve("output/visual-previews/jump-highlight-after-reduced-motion.png"),
  });
  await expect(page.locator("[data-conversation-target-glow]")).toHaveCount(0, {
    timeout: 4_000,
  });
});

test("a jump to a row still growing in shows the glow unclipped", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/coordinator-actions-transcript");
  // Hold the live-arrival entrance open so the jump deterministically lands in it.
  await page.addStyleTag({ content: ":root { --transcript-arrival-duration: 30s; }" });
  await page.getByRole("button", { name: "Read end", exact: true }).click();
  await page.getByRole("button", { name: "Append question", exact: true }).click();
  const arrived = page.locator('[data-chat-message-key="row-50"]');
  // The entrance hides the row content's overflow while it runs.
  await expect(arrived).toHaveAttribute("data-transcript-arrival", "");
  await page.getByRole("button", { name: "Question at 50", exact: true }).click();
  await expect(page.getByTestId("anchor")).toHaveText("row-50");

  const glow = await measureJumpGlow(page);
  expect(glow.rowKey).toBe("row-50");
  await expect(arrived).not.toHaveAttribute("data-transcript-arrival");
  // Nothing between the item and the scroller clips its overflow, and the
  // row is at full height rather than part-way through growing in.
  const clipping = await page.locator("[data-conversation-target-glow]").evaluate((element) => {
    const clipped: string[] = [];
    for (
      let node = element.parentElement;
      node && !node.hasAttribute("data-virtuoso-scroller");
      node = node.parentElement
    ) {
      const { overflowX, overflowY } = getComputedStyle(node);
      if (overflowX !== "visible" || overflowY !== "visible") {
        clipped.push(`${node.tagName}:${overflowX}/${overflowY}`);
      }
    }
    const rowBox = element.closest<HTMLElement>("[data-chat-message-key]")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    // How far the item reaches past the bottom of its row.
    return { clipped, overhang: box.bottom - rowBox.bottom };
  });
  expect(clipping.clipped).toEqual([]);
  expect(clipping.overhang).toBeLessThanOrEqual(0.5);
  expect(glow.roomLeft).toBeGreaterThanOrEqual(9);
  expect(glow.roomRight).toBeGreaterThanOrEqual(9);
  await page.screenshot({
    path: path.resolve("output/visual-previews/jump-highlight-arrival-unclipped.png"),
  });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`compact mail glow fits 320px gutters with ${reducedMotion} motion`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.emulateMedia({ reducedMotion });
    await page.goto("/coordinator-actions-transcript");
    await page.getByRole("button", { name: "Read start", exact: true }).click();
    const item = page
      .locator('[data-chat-message-key="peer-mail-fixture"] [data-transcript-item]')
      .first();
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("data-transcript-item", "mail");
    const before = await item.evaluate((element) => {
      const { width, height } = element.getBoundingClientRect();
      return { width, height };
    });
    await page.getByRole("button", { name: "Jump mail", exact: true }).click();
    const glow = await measureJumpGlow(page);
    expect(glow.rowKey).toBe("peer-mail-fixture");
    expect(glow.roomLeft).toBeGreaterThanOrEqual(8);
    expect(glow.roomRight).toBeGreaterThanOrEqual(8);
    expect({ width: glow.box.width, height: glow.box.height }).toEqual(before);
    // CSS blur's painted extent is about 1.5 times its radius, plus spread.
    // At full strength both sides therefore fit the smallest 8px gutter.
    const shadow = await item.evaluate((element, reduced) => {
      if (!reduced) {
        const animation = element.getAnimations()[0]!;
        animation.pause();
        animation.currentTime = 0;
      }
      return getComputedStyle(element).boxShadow;
    }, reducedMotion === "reduce");
    expect(shadow).toContain("rgba(56, 189, 248, 0.55) 0px 0px 4px 1px");
    expect(1.5 * 4 + 1).toBeLessThanOrEqual(Math.min(glow.roomLeft, glow.roomRight));
    expect(glow.animationName).toBe(
      reducedMotion === "reduce" ? "none" : "conversation-target-glow-b",
    );
    await page.screenshot({
      path: path.resolve(`output/visual-previews/jump-mail-320-${reducedMotion}.png`),
    });
    await expect(item).not.toHaveAttribute("data-conversation-target-glow", { timeout: 4000 });
    const after = await item.boundingBox();
    expect({ width: after!.width, height: after!.height }).toEqual(before);
  });
}

for (const width of [320, 1600]) {
  test(`user bubble keeps its base shadow throughout the jump at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/coordinator-actions-transcript");
    await page.getByRole("button", { name: "Read start", exact: true }).click();
    const item = page.locator('[data-chat-message-key="row-2"] [data-transcript-item]').first();
    await expect(item).toBeVisible();
    const base = await item.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(base).not.toBe("none");
    await page.screenshot({
      path: path.resolve(`output/visual-previews/jump-user-${width}-before.png`),
    });
    await page.getByRole("button", { name: "Jump user", exact: true }).click();
    await expect(item).toHaveAttribute("data-conversation-target-glow");
    for (const time of [0, 1500, 2500]) {
      const shadow = await item.evaluate((element, time) => {
        const animation = element.getAnimations()[0]!;
        animation.pause();
        animation.currentTime = time;
        return getComputedStyle(element).boxShadow;
      }, time);
      expect(shadow.endsWith(base)).toBe(true);
      if (time === 0)
        await page.screenshot({
          path: path.resolve(`output/visual-previews/jump-user-${width}-glow.png`),
        });
    }
    await expect(item).not.toHaveAttribute("data-conversation-target-glow", { timeout: 4000 });
    expect(await item.evaluate((element) => getComputedStyle(element).boxShadow)).toBe(base);
    expect(
      await item.evaluate((element) =>
        (element as HTMLElement).style.getPropertyValue("--conversation-target-base-shadow"),
      ),
    ).toBe("");
  });
}

const waitingIcon = (page: Page) => page.getByRole("button", { name: "Actions, 1 waiting" });
const collapseHeader = (page: Page) => page.getByRole("button", { name: "Collapse actions" });
const actionsRegion = (page: Page) => page.locator('section[aria-label="Actions"]');

test("wide header folds the docked panel to its icon, and only the icon or header toggles it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/coordinator-actions");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(collapseHeader(page)).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: path.resolve("output/visual-previews/actions-wide-open.png") });
  await collapseHeader(page).click();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  await expect(actionsRegion(page)).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Which option?" })).toHaveCount(0);
  await page.screenshot({ path: path.resolve("output/visual-previews/actions-wide-folded.png") });
  // Hovering the folded icon on a wide pane does not open it.
  await waitingIcon(page).hover();
  await page.waitForTimeout(250);
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  await waitingIcon(page).click();
  await expect(waitingIcon(page)).toHaveCount(0);
  await expect(collapseHeader(page)).toBeFocused();
  // Sticky: nothing but the header closes it.
  await page.getByRole("button", { name: "Transcript control" }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 890);
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "Which option?" }).click();
  await expect(page.getByTestId("anchor")).toHaveText("assistant");
  await expect(collapseHeader(page)).toHaveAttribute("aria-expanded", "true");
  // Keyboard: Enter on the header folds, Space on the icon reopens.
  await collapseHeader(page).focus();
  await page.keyboard.press("Enter");
  await expect(waitingIcon(page)).toBeFocused();
  await page.keyboard.press(" ");
  await expect(collapseHeader(page)).toBeFocused();
  await expect(collapseHeader(page)).toHaveAttribute("aria-expanded", "true");
});

test("the wide choice persists across reload, other windows and narrow resizes", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/coordinator-actions");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await collapseHeader(page).click();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");

  const other = await context.newPage();
  await other.setViewportSize({ width: 1600, height: 900 });
  await other.goto("/coordinator-actions");
  await expect(waitingIcon(other)).toHaveAttribute("aria-expanded", "false");
  await waitingIcon(other).click();
  // The first window follows the other window's choice.
  await expect(collapseHeader(page)).toHaveAttribute("aria-expanded", "true");
  await collapseHeader(page).click();
  await expect(waitingIcon(other)).toHaveAttribute("aria-expanded", "false");
  await other.close();

  // Narrow: the overlay's own behaviour, starting folded.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  await waitingIcon(page).hover();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "true");
  // Wide again restores the remembered fold, not the overlay's open state.
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  await waitingIcon(page).click();
  await expect(collapseHeader(page)).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(collapseHeader(page)).toHaveAttribute("aria-expanded", "true");
  await expect(waitingIcon(page)).toHaveCount(0);
});

test("narrow overlay folds on an outside click and from its header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/coordinator-actions");
  await waitingIcon(page).focus();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "true");
  await page.mouse.click(10, 820);
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Transcript control" }).focus();
  await waitingIcon(page).focus();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.resolve("output/visual-previews/actions-narrow-open.png") });
  await collapseHeader(page).click();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  await expect(waitingIcon(page)).toBeFocused();
});

test("reduced motion shows and hides without a transition in both modes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/coordinator-actions");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const transition = () =>
    actionsRegion(page).evaluate((element) => getComputedStyle(element).transitionProperty);
  expect(await transition()).toBe("none");
  await collapseHeader(page).click();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "false");
  expect(await transition()).toBe("none");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Transcript control" }).focus();
  await waitingIcon(page).focus();
  await expect(waitingIcon(page)).toHaveAttribute("aria-expanded", "true");
  expect(await transition()).toBe("none");
});

test("a short pane shows the newest whole cards and never scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 420 });
  await page.goto("/coordinator-actions?many");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "Follow-up question 8" })).toBeVisible();
  // The oldest cards are dropped first, and the count still includes them.
  await expect(page.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /#42 Improve search/ })).toHaveCount(0);
  await expect(collapseHeader(page)).toContainText("9 waiting");
  const geometry = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>("[data-actions-panel-box]")!;
    const stack = document.querySelector<HTMLElement>("[data-floating-notice-stack]")!;
    const cards = Array.from(box.querySelectorAll<HTMLElement>("li:not([hidden])"));
    const bottom = box.getBoundingClientRect().bottom;
    return {
      boxScrolls: box.scrollHeight > box.clientHeight + 1,
      stackScrolls: stack.scrollHeight > stack.clientHeight + 1,
      scrollable: Array.from(box.querySelectorAll<HTMLElement>("*")).some(
        (element) => getComputedStyle(element).overflowY === "auto",
      ),
      cut: cards.some((card) => card.getBoundingClientRect().bottom > bottom + 0.5),
      shown: cards.length,
      viewport: bottom <= window.innerHeight,
    };
  });
  expect(geometry).toMatchObject({
    boxScrolls: false,
    stackScrolls: false,
    scrollable: false,
    cut: false,
    viewport: true,
  });
  expect(geometry.shown).toBeGreaterThan(0);
  expect(geometry.shown).toBeLessThan(10);
  await page.screenshot({ path: path.resolve("output/visual-previews/actions-short-pane.png") });
  // A taller pane fits more cards again.
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page.getByRole("button", { name: "Which option?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
});

test("remote collapse recovers card focus and a tiny pane preserves the header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/coordinator-actions?many");
  await page.getByRole("button", { name: "Follow-up question 8" }).focus();
  await page.evaluate(() => {
    const key = "orkestrator.coordinator-actions.docked";
    localStorage.setItem(key, "collapsed");
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  const icon = page.getByRole("button", { name: /^Actions,/ });
  await expect(icon).toBeFocused();
  await icon.click();
  await page.setViewportSize({ width: 1600, height: 150 });
  const header = page.getByRole("button", { name: "Collapse actions" });
  await expect(header).toBeVisible();
  const dimensions = await header.evaluate((element) => {
    const header = element.getBoundingClientRect();
    const box = element.closest("[data-actions-panel-box]")!.getBoundingClientRect();
    return { headerBottom: header.bottom, boxBottom: box.bottom };
  });
  expect(dimensions.headerBottom).toBeLessThanOrEqual(dimensions.boxBottom);
  await page.screenshot({
    path: path.resolve("output/visual-previews/actions-fix-tiny-header.png"),
  });
});
