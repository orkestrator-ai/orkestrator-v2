import { expect, test, type Locator, type Page } from "@playwright/test";

/** Compare painted center pixels, rather than just the dot's computed fill. */
async function centerPixels(page: Page, marker: Locator) {
  const box = await marker.getByTestId("environment-status-marker").boundingBox();
  if (!box) throw new Error("Marker has no rendered bounds");
  return page.screenshot({
    clip: {
      x: Math.round(box.x + box.width / 2 - 1),
      y: Math.round(box.y + box.height / 2 - 1),
      width: 2,
      height: 2,
    },
    animations: "allow",
    scale: "css",
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/environment-status-marker");
});

for (const shape of ["circle", "square"]) {
  for (const state of ["idle", "working", "waiting"]) {
    test(`hovering the ${shape} center opens the machine tooltip over its ${state} halo`, async ({
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

for (const shape of ["circle", "square"]) {
  for (const identity of ["", "neutral-"]) {
    test(`${shape} ${identity || "machine-"}center pixels stay unchanged throughout working and waiting pulses`, async ({
      page,
    }) => {
      const baseline = await centerPixels(page, page.getByTestId(`${shape}-${identity}idle`));
      for (const state of ["working", "waiting"]) {
        const marker = page.getByTestId(`${shape}-${identity}${state}`);
        const halo = marker.getByTestId("environment-status-ring");
        const opacities: number[] = [];
        for (const phase of [0, 500, 1000, 1500]) {
          const opacity = await halo.evaluate(async (element, time) => {
            const animation = element.getAnimations()[0];
            if (!animation) throw new Error("Expected a pulsing activity halo");
            await animation.ready;
            animation.pause();
            animation.currentTime = time;
            return Number(getComputedStyle(element).opacity);
          }, phase);
          opacities.push(opacity);
          expect(await centerPixels(page, marker), `${state} at ${phase} ms`).toEqual(baseline);
        }
        // Ensure the screenshots sampled distinct animation phases.
        expect(Math.min(...opacities)).toBeLessThan(Math.max(...opacities));
      }
    });
  }
}

test("stopped markers have a subtle outline while running idle markers have no halo", async ({
  page,
}) => {
  for (const shape of ["circle", "square"]) {
    for (const identity of ["", "neutral-"]) {
      const stopped = page
        .getByTestId(`${shape}-${identity}inactive`)
        .getByTestId("environment-status-ring");
      const idle = page
        .getByTestId(`${shape}-${identity}idle`)
        .getByTestId("environment-status-ring");
      await expect(stopped).toHaveCSS("border-top-width", "1px");
      await expect(stopped).toHaveCSS("opacity", "1");
      await expect(idle).toHaveCSS("opacity", "0");
    }
  }
});

test("forced colors keep static system-color activity outlines and machine or neutral centers visible in both shapes", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  for (const shape of ["circle", "square"]) {
    for (const identity of ["", "neutral-"]) {
      for (const state of ["inactive", "idle", "working", "waiting"]) {
        const marker = page
          .getByTestId(`${shape}-${identity}${state}`)
          .getByTestId("environment-status-marker");
        const styles = await marker.evaluate((element) => {
          const halo = getComputedStyle(element.firstElementChild!);
          const dot = getComputedStyle(element.lastElementChild!);
          const probe = document.createElement("span");
          probe.style.color = "CanvasText";
          element.append(probe);
          const canvasText = getComputedStyle(probe).color;
          probe.remove();
          return {
            active: matchMedia("(forced-colors: active)").matches,
            display: halo.display,
            borderColor: halo.borderTopColor,
            borderWidth: halo.borderTopWidth,
            borderStyle: halo.borderTopStyle,
            animation: halo.animationName,
            opacity: halo.opacity,
            fill: dot.backgroundColor,
            canvasText,
          };
        });
        expect(styles.active).toBe(true);
        if (state === "working" || state === "waiting") {
          await expect(marker.getByTestId("environment-status-ring")).toBeVisible();
          expect(styles.display).not.toBe("none");
          expect(styles.borderColor).toBe(styles.canvasText);
          expect(styles.borderWidth).toBe("2px");
          expect(styles.borderStyle).toBe(state === "working" ? "solid" : "dashed");
          expect(styles.animation).toBe("none");
          expect(styles.opacity).toBe("1");
        } else {
          expect(styles.display).toBe("none");
        }
        expect(styles.fill).toBe(styles.canvasText);
      }
    }
  }
});
