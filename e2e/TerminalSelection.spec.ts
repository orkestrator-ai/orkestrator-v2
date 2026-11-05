import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

for (const mode of ["shell", "mouse"]) {
  test(`macOS Option selection sends no input in ${mode} mode`, async ({ page }, testInfo) => {
    // xterm detects macOS at module load. Exercise that path on Linux CI too.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    });
    await page.goto(`/terminal-links?selection=${mode}`);
    await expect(page.getByTestId("osc-ready")).toHaveText("true");
    const screen = page.getByTestId("osc-terminal").locator(".xterm-screen");
    const bounds = await screen.boundingBox();
    if (!bounds) throw new Error("Missing terminal screen");
    const cellWidth = bounds.width / 30;
    const cellHeight = bounds.height / 5;
    const point = (col: number, row: number) => ({
      x: bounds.x + (col + 0.5) * cellWidth,
      y: bounds.y + (row + 0.5) * cellHeight,
    });
    const start = point(2, 0);
    await page.keyboard.down("Alt");
    // Click and one-cell drag take xterm's short-gesture cursor-move branch
    // unless altClickMovesCursor is disabled.
    await page.mouse.click(start.x, start.y);
    await expect(page.getByTestId("terminal-input")).toHaveText("[]");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const adjacent = point(3, 0);
    await page.mouse.move(adjacent.x, adjacent.y);
    await page.mouse.up();
    await expect(page.getByTestId("terminal-input")).toHaveText("[]");
    // Across rows, verify linear selection rather than a rectangular column.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const end = point(5, 1);
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await expect(page.getByTestId("terminal-selection")).toHaveText("cdefghij\nklmno");
    await expect(page.getByTestId("terminal-input")).toHaveText("[]");
    const previewDir = path.resolve("output/visual-previews");
    await fs.mkdir(previewDir, { recursive: true });
    await page.getByTestId("osc-terminal").screenshot({
      path: path.join(previewDir, `option-selection-${mode}-${testInfo.project.name}.png`),
    });
    if (mode === "mouse") {
      // Prove reporting really is enabled and ordinary clicks still reach the PTY.
      await page.mouse.click(start.x, start.y);
      await expect(page.getByTestId("terminal-input")).not.toHaveText("[]");
    }
    await page.reload();
    await expect(page.getByTestId("osc-ready")).toHaveText("true");
    await expect(page.getByTestId("terminal-input")).toHaveText("[]");
  });
}
