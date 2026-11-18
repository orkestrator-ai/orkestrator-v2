import { expect, test, type Locator } from "@playwright/test";

async function fitsInside(control: Locator, container: Locator) {
  const bounds = await container.boundingBox();
  const rect = await control.boundingBox();
  return Boolean(
    bounds && rect && rect.x >= bounds.x - 1 && rect.x + rect.width <= bounds.x + bounds.width + 1,
  );
}

test("long story tabs scroll without covering Build", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 780 });
  await page.goto("/tab-styles?view=features");
  const tabs = page.getByRole("tablist", { name: "Feature views" });
  const stories = tabs.getByRole("tab", { name: "Stories", exact: true });
  const build = page.getByRole("button", { name: "Build", exact: true });
  const newest = tabs.getByRole("tab", { name: /^Story 7:/ });
  const closeNewest = tabs.getByRole("button", { name: /^Close Story 7:/ });
  for (let story = 1; story <= 7; story++) {
    await stories.click();
    await page.getByRole("button", { name: new RegExp(`^Story ${story}:`) }).click();
  }
  await expect(newest).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => fitsInside(newest, tabs)).toBe(true);
  await page.setViewportSize({ width: 640, height: 780 });
  await expect.poll(() => fitsInside(newest, tabs)).toBe(true);
  await expect(newest).toHaveCSS("border-bottom-width", "2px");
  await expect(newest).not.toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  await expect
    .poll(async () => {
      const strip = await tabs.boundingBox();
      const button = await build.boundingBox();
      return Boolean(strip && button && strip.x + strip.width <= button.x);
    })
    .toBe(true);
  await build.click({ trial: true });

  await stories.focus();
  await stories.press("End");
  await expect(newest).toBeFocused();
  await expect.poll(() => fitsInside(newest, tabs)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(closeNewest).toBeFocused();
  await expect.poll(() => fitsInside(closeNewest, tabs)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(newest).toHaveCount(0);
  await expect(stories).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("button", { name: /^Close Story 6:/ }).click();
  await expect(tabs.getByRole("tab", { name: /^Story 6:/ })).toHaveCount(0);

  await page.reload();
  await expect(stories).toBeEnabled();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
});

for (const width of [320, 360]) {
  test(`design workspace modes fit and work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/tab-styles?view=design");
    const dialog = page.getByRole("dialog");
    const list = dialog.getByRole("tablist", { name: "Design workspace mode" });
    const modes = ["New design", "Open design", "Saved designs"];
    await list.getByRole("tab", { name: modes[0] }).focus();
    for (const name of modes) {
      const selected = list.getByRole("tab", { name });
      await expect(selected).toBeFocused();
      await expect(selected).toHaveAttribute("aria-selected", "true");
      await expect(dialog.getByRole("tabpanel", { name })).toBeVisible();
      await expect.poll(() => fitsInside(list, dialog)).toBe(true);
      for (const mode of modes) {
        await expect.poll(() => fitsInside(list.getByRole("tab", { name: mode }), list)).toBe(true);
      }
      await page.keyboard.press("ArrowRight");
    }
    await expect(list.getByRole("tab", { name: modes[0] })).toBeFocused();
  });
}

// Composite the rendered colours before converting sRGB to relative luminance.
async function contrast(foreground: Locator, background: Locator) {
  const base = await background.evaluate((element) => getComputedStyle(element).backgroundColor);
  return foreground.evaluate((element, base) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true })!;
    paint.fillStyle = base;
    paint.fillRect(0, 0, 1, 1);
    paint.globalAlpha = Number(style.opacity);
    paint.fillStyle = style.backgroundColor;
    paint.fillRect(0, 0, 1, 1);
    const luminance = () => {
      const [r, g, b] = Array.from(paint.getImageData(0, 0, 1, 1).data, (value) => {
        const srgb = value / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const surface = luminance();
    paint.fillStyle = style.color;
    paint.fillRect(0, 0, 1, 1);
    const ink = luminance();
    return (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
  }, base);
}

test("selected Files tabs have 8px corners and keep their controls legible", async ({ page }) => {
  await page.goto("/tab-styles?view=files");
  const tabs = page.getByRole("tablist", { name: "Files panel views" });
  const changes = tabs.getByRole("tab", { name: "Changes 1" });
  await expect(changes).toHaveAttribute("data-state", "active");
  await expect(changes).toHaveCSS("border-radius", "8px");
  await expect
    .poll(() => contrast(changes.getByText("1", { exact: true }), changes))
    .toBeGreaterThanOrEqual(4.5);

  await changes.focus();
  for (const name of ["All files", "PRs"]) {
    await page.keyboard.press("ArrowRight");
    const tab = tabs.getByRole("tab", { name, exact: true });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toHaveCSS("border-radius", "8px");
    await expect(tab).toHaveCSS("outline-style", "solid");
    await expect(tab).toHaveCSS("outline-width", "1px");
  }

  for (const [number, state] of [
    [1, "Draft"],
    [2, "Closed"],
  ] as const) {
    const tab = tabs.getByRole("tab", { name: new RegExp(`#${number}`) });
    const close = tabs.getByRole("button", { name: `Close example/workspace #${number}` });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toHaveCSS("border-radius", "8px");
    await expect
      .poll(() => contrast(tab.getByRole("img", { name: state }), tab))
      .toBeGreaterThanOrEqual(3);
    await expect.poll(() => contrast(close, tab)).toBeGreaterThanOrEqual(3);
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await expect(tab).toHaveCount(0);
  }
});

test("selected Skills and Plugins tabs have 8px corners and readable counts", async ({ page }) => {
  await page.goto("/tab-styles?view=skills");
  const list = page.getByRole("tablist", { name: "Skills or plugins" });
  const skills = list.getByRole("tab", { name: "Skills 0" });
  await expect(skills).toHaveCSS("border-radius", "8px");
  await expect
    .poll(() => contrast(skills.getByText("0", { exact: true }), skills))
    .toBeGreaterThanOrEqual(4.5);
  await list.getByRole("tab", { name: "Plugins" }).click();
  const plugins = list.getByRole("tab", { name: "Plugins 1" });
  await expect(plugins).toHaveAttribute("aria-selected", "true");
  await expect(plugins).toHaveCSS("border-radius", "8px");
  await expect
    .poll(() => contrast(plugins.getByText("1", { exact: true }), plugins))
    .toBeGreaterThanOrEqual(4.5);
  await expect(skills.getByText("0", { exact: true })).toHaveCSS("opacity", "0.7");
});

for (const { view, tablist } of [
  { view: "extensions", tablist: "Agent extensions" },
  { view: "skills", tablist: "Agent" },
]) {
  test(`selected ${tablist} tabs in ${view} settings have 8px corners`, async ({ page }) => {
    await page.goto(`/tab-styles?view=${view}`);
    const list = page.getByRole("tablist", { name: tablist, exact: true });
    const claude = list.getByRole("tab", { name: "Claude", exact: true });
    const codex = list.getByRole("tab", { name: "Codex", exact: true });

    await expect(claude).toHaveAttribute("aria-selected", "true");
    await expect(claude).toHaveCSS("border-radius", "8px");

    await claude.focus();
    await page.keyboard.press("ArrowRight");
    await expect(codex).toBeFocused();
    await expect(codex).toHaveAttribute("aria-selected", "true");
    await expect(codex).toHaveCSS("border-radius", "8px");
  });
}
