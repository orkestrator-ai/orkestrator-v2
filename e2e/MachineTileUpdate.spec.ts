import { expect, test, type Locator } from "@playwright/test";
import { MACHINE_COLOR_TOKENS } from "@orkestrator/protocol/backend-profile";

/** Sample the painted tile at its real CSS size, including antialiasing. */
async function arrowPaint(tile: Locator) {
  const screenshot = { scale: "css", animations: "disabled" } as const;
  const withArrow = await tile.screenshot(screenshot);
  const withoutArrow = await tile.screenshot({
    ...screenshot,
    style: '[data-testid="machine-tile-update"] { visibility: hidden }',
  });

  return tile.evaluate(
    async (button, { withArrow, withoutArrow }) => {
      const svg = button.querySelector<SVGSVGElement>('[data-testid="machine-tile-update"]')!;
      const path = svg.querySelector("path")!;
      const tileBox = button.getBoundingClientRect();
      const markBox = svg.getBoundingClientRect();
      const x = Math.round(markBox.left - tileBox.left);
      const y = Math.round(markBox.top - tileBox.top);
      const initials = document.createRange();
      initials.selectNodeContents(button.firstElementChild!);

      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      async function pixels(base64: string) {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        ctx.drawImage(image, -x, -y);
        return ctx.getImageData(0, 0, 8, 8).data;
      }
      const painted = await pixels(withArrow);
      const background = await pixels(withoutArrow);

      function color(value: string) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
      }
      function luminance(rgb: Uint8ClampedArray) {
        const weights = [0.2126, 0.7152, 0.0722];
        return weights.reduce((sum, weight, index) => {
          const value = rgb[index]! / 255;
          const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          return sum + weight * linear;
        }, 0);
      }
      function contrast(a: Uint8ClampedArray, b: Uint8ClampedArray) {
        const light = luminance(a);
        const dark = luminance(b);
        return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
      }
      const style = getComputedStyle(path);
      const fill = color(style.fill);
      const stroke = color(style.stroke);
      // Resolve system keywords in the tile's colour scheme, with the same
      // user palette the browser uses to compute the SVG's fill and stroke.
      const probe = document.createElement("span");
      probe.style.forcedColorAdjust = "none";
      probe.hidden = true;
      button.append(probe);
      probe.style.color = "Canvas";
      const canvasColor = color(getComputedStyle(probe).color);
      probe.style.color = "CanvasText";
      const canvasText = color(getComputedStyle(probe).color);
      probe.remove();
      let strongestOutline = 1;
      let interiorPixels = 0;
      for (let i = 0; i < painted.length; i += 4) {
        const pixel = painted.slice(i, i + 3);
        const backdrop = background.slice(i, i + 3);
        // Allow antialiased edges and colour-space conversion without a golden PNG.
        const near = (target: Uint8ClampedArray) =>
          pixel.every((channel, index) => Math.abs(channel - target[index]!) <= 32);
        if (near(fill) && !pixel.every((channel, index) => channel === backdrop[index]))
          interiorPixels++;
        if (near(stroke)) strongestOutline = Math.max(strongestOutline, contrast(pixel, backdrop));
      }

      const filledAt = (x: number, y: number) => path.isPointInFill(new DOMPoint(x, y));
      return {
        size: [markBox.width, markBox.height],
        corner: [markBox.top - tileBox.top, tileBox.right - markBox.right],
        border: button.clientLeft,
        initialsClear: initials.getBoundingClientRect().right <= markBox.left,
        cpuClear:
          markBox.bottom <=
          button.querySelector('[data-testid="machine-tile-cpu"]')!.getBoundingClientRect().top,
        // The head widens below the tip, then narrows back to the stem.
        shape: [
          [filledAt(2.8, 2.6), filledAt(5, 2.6), filledAt(7.2, 2.6)],
          [filledAt(2.8, 4.8), filledAt(5, 4.8), filledAt(7.2, 4.8)],
          [filledAt(2.8, 7.5), filledAt(5, 7.5), filledAt(7.2, 7.5)],
        ],
        colors: [Array.from(fill), Array.from(stroke)],
        systemColors: [Array.from(canvasColor), Array.from(canvasText)],
        themeColors: [
          Array.from(color(getComputedStyle(svg).getPropertyValue("--color-success").trim())),
          Array.from(color(getComputedStyle(svg).getPropertyValue("--color-zinc-950").trim())),
        ],
        interiorPixels,
        strongestOutline,
        strokeContrast: contrast(fill, stroke),
      };
    },
    { withArrow: withArrow.toString("base64"), withoutArrow: withoutArrow.toString("base64") },
  );
}

for (const forcedColors of ["none", "active"] as const) {
  test(`machine updates render a legible up arrow across the palette (${forcedColors})`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ forcedColors });
    const sidebar = testInfo.project.name === "mobile-chromium" ? "&phone-overlay" : "";
    await page.goto(`/repository-environment-list?machine-updates${sidebar}`);
    const tiles = page.getByRole("group", { name: "Machines shown in the list" });
    const olderTile = tiles.getByRole("button", { name: "mini, CPU 23%, shown", exact: true });
    await expect(olderTile).toHaveAccessibleDescription(
      /mini runs Orkestrator 2\.38\.0, older than the command node's 2\.40\.0/,
    );
    await expect(tiles.getByTestId("machine-tile-update")).toHaveCount(9);
    await expect(tiles.locator('[data-dimmed="true"]')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await testInfo.attach("machine-tile-palette", {
      body: await tiles.screenshot({ scale: "css", animations: "disabled" }),
      contentType: "image/png",
    });

    for (const color of [...MACHINE_COLOR_TOKENS, "neutral"]) {
      await test.step(color, async () => {
        const tile = tiles.locator(`[data-machine-color="${color}"]`);
        const mark = tile.getByTestId("machine-tile-update");
        await expect(mark).toBeVisible();
        await expect(mark).toHaveAttribute("aria-hidden", "true");
        const paint = await arrowPaint(tile);
        expect(paint.size).toEqual([8, 8]);
        expect(paint.corner).toEqual([1 + paint.border, 1 + paint.border]);
        expect(paint.initialsClear).toBe(true);
        expect(paint.cpuClear).toBe(true);
        expect(paint.shape).toEqual([
          [false, true, false],
          [true, true, true],
          [false, true, false],
        ]);
        expect(paint.colors).toEqual(
          forcedColors === "active" ? paint.systemColors : paint.themeColors,
        );
        expect(paint.interiorPixels).toBeGreaterThan(0);
        expect(paint.strokeContrast).toBeGreaterThanOrEqual(3);
        expect(paint.strongestOutline).toBeGreaterThanOrEqual(3);
      });
    }
  });
}
