import { expect, test } from "@playwright/test";

for (const forcedColors of ["none", "active"] as const) {
  test(`focus remains visible apart from selection (${forcedColors})`, async ({ page }) => {
    await page.emulateMedia({ forcedColors });
    await page.goto("/focus-visibility");
    await page.addStyleTag({ content: "* { transition: none !important; }" });
    await page.keyboard.press("Tab");
    for (const name of ["unselected", "selected"]) {
      const node = page.getByRole("button", { name: new RegExp(`^${name}`) });
      await node.focus();
      await expect(node).toHaveCSS("outline-style", "solid");
      await expect(node).toHaveCSS("outline-width", "1px");
      await expect(node).toHaveCSS("outline-offset", "-2px");
      expect(await node.evaluate((el) => getComputedStyle(el).outlineColor)).not.toBe(
        "rgba(0, 0, 0, 0)",
      );
    }
    const selected = page.getByRole("radio", { name: "Selected option" });
    await selected.focus();
    await expect(selected).toHaveCSS("outline-style", "solid");
    await expect(selected).toHaveCSS("outline-offset", "-2px");
    const radio = page.getByRole("radio", { name: "Claude", exact: true });
    await radio.focus();
    const label = page.locator(`label[for="${await radio.getAttribute("id")}"]`);
    await expect(label).toHaveCSS("outline-style", "solid");
    await expect(label).toHaveCSS("outline-offset", "-2px");
    for (const name of ["Solid fill", "Annotation fill", "Invalid control"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.focus();
      await expect(button).toHaveCSS("outline-style", "solid");
      await expect(button).toHaveCSS("outline-offset", name === "Invalid control" ? "-2px" : "2px");
      if (forcedColors === "none") {
        await expect(button).toHaveCSS(
          "outline-color",
          name === "Invalid control" ? "rgb(229, 83, 75)" : "rgb(59, 130, 246)",
        );
      }
    }
  });
}

test("focus token contrasts at least 3:1 with dark surfaces", async ({ page }) => {
  await page.goto("/focus-visibility");
  const ratios = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const lum = (color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data).map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
    };
    const css = getComputedStyle(document.documentElement);
    const ring = lum(css.getPropertyValue("--color-ring"));
    return [
      "background",
      "card",
      "elevated",
      "elevated-hover",
      "selected",
      "flow-node",
      "sidebar",
    ].map((surface) => {
      const background = lum(css.getPropertyValue(`--color-${surface}`));
      return (Math.max(ring, background) + 0.05) / (Math.min(ring, background) + 0.05);
    });
  });
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(3);
});

test("selected flow nodes gain a separate focus outline", async ({ page }) => {
  await page.goto("/pipeline-flow");
  const graph = page.getByRole("tablist", { name: "Build pipeline" });
  const selected = graph.locator('[data-flow-node][aria-selected="true"]');
  await expect(selected).toBeVisible();
  await page.keyboard.press("Shift");
  await selected.focus();
  await expect(selected).toHaveCSS("outline-style", "solid");
  await expect(selected).toHaveCSS("outline-offset", "-2px");
  await expect(selected).toHaveCSS("outline-color", "rgb(59, 130, 246)");
  await selected.evaluate((el) => (el as HTMLElement).blur());
  await expect(selected).toHaveCSS("outline-offset", "3px");
});
