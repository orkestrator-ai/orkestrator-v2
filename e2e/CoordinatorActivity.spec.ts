import { expect, test, type Locator, type Page } from "@playwright/test";

/** Whether the ring's own spinner animation is running. */
const spinning = (ring: Locator) =>
  ring.evaluate((element) =>
    element.getAnimations().some((animation) => animation.playState === "running"),
  );

const coordinatorTab = (page: Page) => page.getByRole("tab", { name: "Coordinator", exact: true });

/** A tab's box within the tablist's content, whatever has scrolled around it. */
const boxInTablist = (tab: Locator) =>
  tab.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const list = element.parentElement!;
    const origin = list.getBoundingClientRect();
    return {
      x: box.x - origin.x + list.scrollLeft,
      y: box.y - origin.y + list.scrollTop,
      width: box.width,
      height: box.height,
    };
  });

test("a coordinator's activity shows on its tab and its project heading", async ({ page }) => {
  await page.goto("/coordinator-activity");
  const tab = coordinatorTab(page);
  const tabIcon = tab.getByTestId("coordinator-activity-icon");
  const tabOutline = tab.getByTestId("coordinator-working-outline");
  const sidebar = page.getByTestId("fixture-sidebar");
  const heading = (name: string) => sidebar.getByRole("button", { name, exact: true });

  // Working: the spinner circles the toolbar tab and the project heading's icon.
  await expect(tabOutline).toBeVisible();
  const tabRing = tab.getByTestId("coordinator-working-outline-ring");
  await expect(tabRing).toHaveClass(/environment-working-spinner/);
  expect(await spinning(tabRing)).toBe(true);
  await expect(tabIcon).toHaveAttribute("data-state", "idle");
  await expect(tabIcon.getByTestId("coordinator-activity-ring")).toBeHidden();
  const working = heading("orkestrator").getByTestId("coordinator-activity-icon");
  await expect(working).toHaveAttribute("data-state", "working");
  await expect(working.getByTestId("coordinator-activity-ring")).toHaveClass(
    /environment-working-spinner/,
  );
  await expect(heading("orkestrator")).toHaveAccessibleDescription(/Coordinator working/);

  // Waiting and idle around a project's own leading icon.
  await expect(heading("website").getByTestId("coordinator-activity-icon")).toHaveAttribute(
    "data-state",
    "waiting",
  );
  const idle = heading("docs").getByTestId("coordinator-activity-icon");
  await expect(idle).toHaveAttribute("data-state", "idle");
  await expect(idle.getByTestId("coordinator-activity-ring")).toBeHidden();

  // Nothing moves: the tab and its neighbour keep their boxes either way.
  const kanban = page.getByRole("tab", { name: "Kanban", exact: true });
  const workingTabBox = await boxInTablist(tab);
  const workingKanbanBox = await boxInTablist(kanban);
  await page.getByRole("button", { name: "Coordinator idle" }).click();
  await expect(tabOutline).toHaveCount(0);
  await expect(tabIcon).toHaveAttribute("data-state", "idle");
  expect(await boxInTablist(tab)).toEqual(workingTabBox);
  expect(await boxInTablist(kanban)).toEqual(workingKanbanBox);
  // A project with no icon of its own shows the coordinator's only while active.
  await expect(heading("orkestrator").getByTestId("coordinator-activity-icon")).toHaveCount(0);

  // The tab's waiting state stays a halo on its icon.
  await page.getByRole("button", { name: "Coordinator waiting" }).click();
  await expect(tabIcon).toHaveAttribute("data-state", "waiting");
  await expect(tabIcon.getByTestId("coordinator-activity-ring")).toHaveClass(/animate-pulse/);
  await expect(tabOutline).toHaveCount(0);
  expect(await boxInTablist(tab)).toEqual(workingTabBox);
  expect(await boxInTablist(kanban)).toEqual(workingKanbanBox);
  await expect(heading("orkestrator")).toHaveAccessibleDescription(/Coordinator waiting for you/);
});

test("the tab's spinner follows its outline, unclipped, on the shared timeline", async ({
  page,
}) => {
  await page.goto("/coordinator-activity");
  const tab = coordinatorTab(page);
  const outline = tab.getByTestId("coordinator-working-outline");
  const ring = tab.getByTestId("coordinator-working-outline-ring");
  await expect(outline).toBeVisible();
  await tab.scrollIntoViewIfNeeded();

  // Around the tab's whole box, 1px in so its fill shows outside, with its corners.
  const tabBox = (await tab.boundingBox())!;
  expect(await outline.boundingBox()).toEqual({
    x: tabBox.x + 1,
    y: tabBox.y + 1,
    width: tabBox.width - 2,
    height: tabBox.height - 2,
  });
  const tabRadius = await tab.evaluate((element) => getComputedStyle(element).borderRadius);
  expect(tabRadius).toBe("6px");
  const ringRadius = await ring.evaluate((element) => {
    return getComputedStyle(element, "::before").borderRadius;
  });
  expect(ringRadius).toBe(tabRadius);

  // Drawn within the tab, it gives the scrolling bar nothing to clip or scroll.
  const tablist = page.getByRole("tablist", { name: "Project navigation" });
  const overflowY = () =>
    tablist.evaluate((element) => element.scrollHeight - element.clientHeight);
  const scrollWidth = () => tablist.evaluate((element) => element.scrollWidth);
  const workingOverflow = await overflowY();
  const workingWidth = await scrollWidth();
  expect(workingOverflow).toBe(0);

  // In step with the environment spinners.
  const marker = page.getByTestId("environment-status-ring");
  const startTimes = (element: Element) => element.getAnimations().map((a) => a.startTime);
  expect(await ring.evaluate(startTimes)).toEqual([0]);
  expect(await marker.evaluate(startTimes)).toEqual([0]);

  // Hit testing and focus go to the tab, never the ring.
  const hit = await page.evaluate(
    ([x, y]) => {
      const element = document.elementFromPoint(x!, y!);
      return element?.closest("[data-testid='coordinator-working-outline']") !== null;
    },
    [tabBox.x + tabBox.width / 2, tabBox.y + 1.5],
  );
  expect(hit).toBe(false);
  expect(await outline.evaluate((element) => element.querySelector("[tabindex]"))).toBeNull();

  await page.getByRole("button", { name: "Coordinator idle" }).click();
  await expect(outline).toHaveCount(0);
  expect(await overflowY()).toBe(workingOverflow);
  expect(await scrollWidth()).toBe(workingWidth);
});

test("the tab's focus ring stays visible beside the spinner", async ({ page }) => {
  await page.goto("/coordinator-activity");
  const tab = coordinatorTab(page);
  const outline = tab.getByTestId("coordinator-working-outline");
  await expect(outline).toBeVisible();
  await tab.focus();
  await expect(tab).toBeFocused();
  expect(await tab.evaluate((element) => element.matches(":focus-visible"))).toBe(true);

  // A 2px inset ring on the tab, with the spinner moved just inside it.
  const shadow = await tab.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(shadow).toMatch(/inset/);
  expect(shadow).toMatch(/2px/);
  const tabBox = (await tab.boundingBox())!;
  const outlineBox = (await outline.boundingBox())!;
  expect(outlineBox.x - tabBox.x).toBe(2);
  expect(outlineBox.y - tabBox.y).toBe(2);
  expect(outlineBox.width).toBe(tabBox.width - 4);
  expect(outlineBox.height).toBe(tabBox.height - 4);
});

test("forced colours replace the tab's spinner with a static outline", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/coordinator-activity");
  const tab = coordinatorTab(page);
  const ring = tab.getByTestId("coordinator-working-outline-ring");
  await expect(ring).toBeVisible();

  expect(await spinning(ring)).toBe(false);
  const style = await ring.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      width: computed.borderTopWidth,
      line: computed.borderTopStyle,
      radius: computed.borderTopLeftRadius,
      spinner: getComputedStyle(element, "::before").display,
    };
  });
  expect(style).toEqual({ width: "2px", line: "solid", radius: "6px", spinner: "none" });
});
