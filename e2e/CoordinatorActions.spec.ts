import { expect, test } from "@playwright/test";
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
      path: path.resolve(`output/visual-previews/jump-highlight-after-${viewport.name}.png`),
    });

    // Part-way through, the glow is fading rather than at full strength.
    await page.waitForTimeout(1_500);
    await page.screenshot({
      path: path.resolve(`output/visual-previews/jump-highlight-after-${viewport.name}-fading.png`),
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
