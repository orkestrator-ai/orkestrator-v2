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

for (const palette of ["dark", "simulated-light"] as const) {
  for (const selected of [true, false]) {
    test(`working outline inherits a contrasting text color: ${palette}, selected=${selected}`, async ({
      page,
    }) => {
      await page.goto("/coordinator-activity");
      // Sample settled colors, never a transient frame between selection states.
      await page.addStyleTag({ content: "*, *::before { transition: none !important; }" });
      // There is no shipped light theme. Exercise the same currentColor contract
      // with explicit light surface/text tokens rather than claiming theme support.
      if (palette === "simulated-light") {
        await page.addStyleTag({
          content: `:root {
          --color-background: #ffffff;
          --color-chrome: #ffffff;
          --color-foreground: #18181b;
          --color-muted-foreground: #52525b;
          --color-elevated: #f4f4f5;
        }`,
        });
      }
      const tab = coordinatorTab(page);
      if (!selected) await page.getByRole("tab", { name: "Kanban", exact: true }).click();
      await expect(tab).toHaveAttribute("aria-selected", String(selected));
      // Move away so hover text colors cannot conceal a dim unselected state.
      await page.mouse.move(0, 0);
      const ring = tab.getByTestId("coordinator-working-outline-ring");
      await expect(ring).toHaveClass(/environment-working-spinner-text-colored/);
      await expect
        .poll(() =>
          tab.evaluate((element) => {
            const ring = element.querySelector("[data-testid='coordinator-working-outline-ring']")!;
            const text = getComputedStyle(element).color;
            const style = getComputedStyle(ring);
            return (
              style.color === text &&
              getComputedStyle(ring, "::before").backgroundImage.includes(text)
            );
          }),
        )
        .toBe(true);
      const contrast = () =>
        tab.evaluate((element) => {
          const ring = element.querySelector("[data-testid='coordinator-working-outline-ring']")!;
          // Canvas resolves both rgb and oklch computed colors into sRGB bytes.
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d")!;
          const luminance = (color: string) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const values = Array.from(ctx.getImageData(0, 0, 1, 1).data)
              .slice(0, 3)
              .map((v) => {
                const n = v / 255;
                return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
              });
            return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
          };
          let surface: Element | null = element;
          while (surface && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)")
            surface = surface.parentElement;
          const head = luminance(getComputedStyle(ring).color);
          const background = luminance(getComputedStyle(surface!).backgroundColor);
          return (Math.max(head, background) + 0.05) / (Math.min(head, background) + 0.05);
        });
      // The opaque head is the activity cue; the intentional transparent tail fades.
      await expect.poll(contrast).toBeGreaterThanOrEqual(3);
      expect(await spinning(ring)).toBe(true);
    });
  }
}

for (const presentation of ["bar", "grid"] as const) {
  test(`working outline stays inside the ${presentation} tab at narrow width`, async ({ page }) => {
    // Keep room for the fixture's fixed 288px sidebar plus a whole tab.
    await page.setViewportSize({ width: 640, height: 844 });
    await page.goto(`/coordinator-activity?presentation=${presentation}`);
    const tab = coordinatorTab(page);
    const list = page.getByRole("tablist", { name: "Project navigation" });
    const outline = tab.getByTestId("coordinator-working-outline");
    await expect(outline).toBeVisible();
    if (presentation === "bar") {
      // The fixture sidebar deliberately leaves a narrow scrolling navigation bar.
      expect(await list.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
      await list.evaluate((e) => {
        e.scrollLeft = e.scrollWidth;
      });
      expect(await list.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
      // Coordinator is the first tab. Put its inset outline exactly at the
      // clipping boundary while leaving the tablist horizontally scrolled.
      await list.evaluate((e) => {
        e.scrollLeft = 1;
      });
      expect(await list.evaluate((e) => e.scrollLeft)).toBe(1);
    }
    const geometry = await tab.evaluate((element) => {
      const outline = element.querySelector("[data-testid='coordinator-working-outline']")!;
      const ring = outline.firstElementChild!;
      const tab = element.getBoundingClientRect();
      const box = outline.getBoundingClientRect();
      const list = element.parentElement!.getBoundingClientRect();
      return {
        inset: [
          box.left - tab.left,
          box.top - tab.top,
          tab.right - box.right,
          tab.bottom - box.bottom,
        ],
        visible:
          box.left >= list.left &&
          box.right <= list.right &&
          box.top >= list.top &&
          box.bottom <= list.bottom,
        tabRadius: getComputedStyle(element).borderRadius,
        ringRadius: getComputedStyle(ring, "::before").borderRadius,
      };
    });
    expect(geometry.inset).toEqual([1, 1, 1, 1]);
    expect(geometry.visible).toBe(true);
    expect(geometry.tabRadius).toBe(presentation === "grid" ? "8px" : "6px");
    expect(geometry.ringRadius).toBe(geometry.tabRadius);
    const dimensions = await list.evaluate((e) => [e.scrollWidth, e.scrollHeight]);
    await page.getByRole("button", { name: "Coordinator idle" }).click();
    await expect(outline).toHaveCount(0);
    expect(await list.evaluate((e) => [e.scrollWidth, e.scrollHeight])).toEqual(dimensions);
  });
}
