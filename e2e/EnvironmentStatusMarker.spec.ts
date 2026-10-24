import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/environment-status-marker");
});

for (const shape of ["circle", "square"]) {
  for (const state of ["idle", "working", "waiting"]) {
    test(`hovering the ${shape} center opens the machine tooltip through its ${state} ring`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-chromium", "tooltips require a hover pointer");
      const machineColor = await page
        .getByTestId("circle-idle")
        .getByTestId("machine-dot")
        .evaluate((dot) => getComputedStyle(dot).backgroundColor);
      const marker = page.getByTestId(`${shape}-${state}`);
      const dot = marker.getByTestId("machine-dot");
      const ring = marker.getByTestId("environment-status-ring");
      await expect(page.getByRole("tooltip")).toBeHidden();
      await expect(ring).toHaveCSS("pointer-events", "none");
      await expect(ring).toHaveCSS("animation-name", state === "idle" ? "none" : "pulse");
      await expect(dot).toHaveCSS("animation-name", "none");
      await expect(dot).toHaveCSS("opacity", "1");
      await expect(dot).toHaveCSS("background-color", machineColor);
      // The default hover targets the center and performs browser hit testing.
      await dot.hover();
      await expect(dot).toHaveAttribute("data-state", "delayed-open");
      await expect(page.getByRole("tooltip")).toHaveText("Build machine · Connected");
    });
  }
}

test("forced colors keep inactive rings and machine or neutral centers visible in both shapes", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  for (const shape of ["circle", "square"]) {
    for (const state of ["inactive", "idle", "working", "waiting", "neutral"]) {
      const marker = page.getByTestId(`${shape}-${state}`).getByTestId("environment-status-marker");
      const styles = await marker.evaluate((element) => {
        const ring = getComputedStyle(element.firstElementChild!);
        const dot = getComputedStyle(element.lastElementChild!);
        const probe = document.createElement("span");
        probe.style.color = "CanvasText";
        element.append(probe);
        const canvasText = getComputedStyle(probe).color;
        probe.remove();
        return {
          active: matchMedia("(forced-colors: active)").matches,
          border: ring.borderTopColor,
          width: ring.borderTopWidth,
          fill: dot.backgroundColor,
          canvasText,
        };
      });
      expect(styles.active).toBe(true);
      expect(styles.border).toBe(styles.canvasText);
      expect(styles.width).toBe("2px");
      expect(styles.fill).toBe(styles.canvasText);
    }
  }
});
