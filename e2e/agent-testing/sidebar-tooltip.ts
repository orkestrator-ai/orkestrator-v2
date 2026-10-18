import type { Page } from "@playwright/test";

/**
 * Close a sidebar tooltip left by the previous hover before clicking an entry.
 *
 * Escape is Stop for the visible chat tab whether its composer has focus or
 * nothing has (`useEscapeToStop`), so a bare `keyboard.press("Escape")` while a
 * turn runs interrupts it. The key is only sent when a tooltip is showing, and
 * then from the project's sidebar toggle, which no tab treats as a stop.
 */
export async function dismissSidebarTooltip(page: Page, projectName: string): Promise<void> {
  await page.mouse.move(0, 0);
  if (!(await page.getByRole("tooltip").first().isVisible())) return;
  const toggle = page
    .getByRole("button", {
      name: new RegExp(
        `^(Expand|Collapse) project ${projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
    })
    .first();
  await toggle.focus();
  await page.keyboard.press("Escape");
}
