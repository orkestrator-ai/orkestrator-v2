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
