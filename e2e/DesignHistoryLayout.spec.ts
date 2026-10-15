import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDesignServiceHost } from "./design-service-client";

test("unbroken undo and redo labels wrap within the history pane", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "ork-design-history-layout-"));
  const worktree = join(dir, "worktree");
  await mkdir(worktree);
  const service = startDesignServiceHost(dir, worktree);

  try {
    const canvas = await service.create("design-fixture", "History layout");
    const frameName = "W".repeat(40);
    await service.createFrame(
      canvas.id,
      "design-fixture",
      1,
      { name: frameName, x: 0, y: 0, width: 400, height: 300, html: "<main>Frame</main>" },
      "user",
    );
    await page.exposeFunction("designInvoke", (command: string, args: Record<string, unknown>) =>
      service.invoke(command, args),
    );
    await page.goto(`/design-canvas?canvasId=${canvas.id}`);
    await page.getByRole("button", { name: "Design history" }).click();

    const pane = page.getByRole("complementary", { name: "Design history" });
    const section = pane.getByRole("region", { name: "Undo and redo" });
    const undo = section.getByRole("button", { name: `Undo Add frame “${frameName}”` });
    const redo = section.getByRole("button", { name: `Redo Add frame “${frameName}”` });
    const expectContainedWrap = async (button: typeof undo) => {
      await expect(button).toBeVisible();
      const measurements = await button.evaluate((element) => {
        const panel = element.closest('aside[aria-label="Design history"]')!;
        const buttonBox = element.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        return {
          buttonHeight: buttonBox.height,
          buttonRight: buttonBox.right,
          panelRight: panelBox.right,
          buttonOverflow: element.scrollWidth - element.clientWidth,
          sectionOverflow:
            element.closest("section")!.scrollWidth - element.closest("section")!.clientWidth,
          overflowWrap: getComputedStyle(element).overflowWrap,
        };
      });
      expect(measurements.overflowWrap).toBe("anywhere");
      expect(measurements.buttonHeight).toBeGreaterThan(35);
      expect(measurements.buttonRight).toBeLessThanOrEqual(measurements.panelRight + 1);
      expect(measurements.buttonOverflow).toBeLessThanOrEqual(1);
      expect(measurements.sectionOverflow).toBeLessThanOrEqual(1);
    };

    await expectContainedWrap(undo);
    await undo.click();
    await expectContainedWrap(redo);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
