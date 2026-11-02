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

/** Decode browser pixels without adding a PNG dependency to the test runner. */
async function paintedPixels(page: Page, marker: Locator) {
  const screenshot = await marker.screenshot({ animations: "allow", scale: "css" });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      width: image.width,
      height: image.height,
      pixels: Array.from(context.getImageData(0, 0, image.width, image.height).data),
    };
  }, screenshot.toString("base64"));
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
      await expect(ring).toHaveCSS(
        "animation-name",
        state === "idle"
          ? "none"
          : state === "waiting"
            ? "pulse"
            : shape === "circle"
              ? "environment-working-turn"
              : "environment-working-sweep",
      );
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
    test(`${shape} ${identity || "machine-"}center pixels stay unchanged throughout the working spinner and waiting pulse`, async ({
      page,
    }) => {
      const baseline = await centerPixels(page, page.getByTestId(`${shape}-${identity}idle`));
      for (const state of ["working", "waiting"]) {
        const marker = page.getByTestId(`${shape}-${identity}${state}`);
        const halo = marker.getByTestId("environment-status-ring");
        const appearances = new Set<string>();
        for (const phase of [0, 300, 600, 900]) {
          const appearance = await halo.evaluate(async (element, time) => {
            const animation = element.getAnimations()[0];
            if (!animation) throw new Error("Expected an animated activity ring");
            await animation.ready;
            animation.pause();
            animation.currentTime = time;
            const style = getComputedStyle(element);
            return [
              style.opacity,
              style.transform,
              style.getPropertyValue("--environment-working-angle"),
            ].join();
          }, phase);
          appearances.add(appearance);
          expect(await centerPixels(page, marker), `${state} at ${phase} ms`).toEqual(baseline);
        }
        // Ensure the screenshots sampled distinct animation phases.
        expect(appearances.size).toBeGreaterThan(1);
      }
    });
  }
}

for (const shape of ["circle", "square"]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`${shape} working ring paints a hollow ${shape} under ${reducedMotion} motion`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion });
      const marker = page.getByTestId(`${shape}-working`).getByTestId("environment-status-marker");
      const ring = marker.getByTestId("environment-status-ring");
      // Same position and machine dot in both images; only the ring changes.
      await ring.evaluate((element) => (element.style.visibility = "hidden"));
      const baseline = await paintedPixels(page, marker);
      await ring.evaluate((element) => (element.style.visibility = "visible"));
      const cornerPixels = new Set<number>();
      for (const phase of reducedMotion === "reduce" ? [0] : [0, 300, 600, 900]) {
        await ring.evaluate(async (element, time) => {
          const animation = element.getAnimations()[0];
          if (animation) {
            await animation.ready;
            animation.pause();
            animation.currentTime = time;
          }
        }, phase);
        const actual = await paintedPixels(page, marker);
        expect(actual.width).toBe(16);
        expect(actual.height).toBe(16);
        let painted = 0;
        let interior = 0;
        let exterior = 0;
        for (let y = 0; y < actual.height; y++) {
          for (let x = 0; x < actual.width; x++) {
            const offset = (y * actual.width + x) * 4;
            const changed = [0, 1, 2].some(
              (channel) =>
                Math.abs(actual.pixels[offset + channel]! - baseline.pixels[offset + channel]!) > 8,
            );
            if (!changed) continue;
            painted++;
            const dx = Math.abs(x + 0.5 - actual.width / 2);
            const dy = Math.abs(y + 0.5 - actual.height / 2);
            // Signed distance from the actual 8px circle / 4px-rounded square.
            // Permit antialiasing at the outer edge but no paint in the hole.
            const roundedSquareDistance = (halfSize: number) => {
              const qx = dx - (halfSize - 4);
              const qy = dy - (halfSize - 4);
              return (
                Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 4
              );
            };
            const distance = shape === "circle" ? Math.hypot(dx, dy) - 8 : roundedSquareDistance(8);
            // The square's content-box mask keeps its 4px corner radius.
            const holeDistance =
              shape === "circle" ? Math.hypot(dx, dy) - 6.5 : roundedSquareDistance(6.5);
            if (holeDistance < -0.75) interior++;
            if (distance > 0.75) exterior++;
            if (dx >= 6.5 && dy >= 6.5) cornerPixels.add(offset);
          }
        }
        expect(painted, `visible ring at ${phase}ms`).toBeGreaterThan(10);
        expect(interior, `hollow center at ${phase}ms`).toBe(0);
        expect(exterior, `shape boundary at ${phase}ms`).toBe(0);
      }
      // Rounded square corners extend beyond the circle's circumference.
      if (shape === "square") expect(cornerPixels.size).toBeGreaterThan(0);
      else expect(cornerPixels.size).toBe(0);
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

test("the working spinner stops turning but stays visible under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const shape of ["circle", "square"]) {
    const ring = page.getByTestId(`${shape}-working`).getByTestId("environment-status-ring");
    await expect(ring).toHaveCSS("animation-name", "none");
    const sweep = await ring.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return { content: style.content, image: style.backgroundImage };
    });
    expect(sweep.content).not.toBe("none");
    expect(sweep.image).toContain("conic-gradient");
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
            pseudoDisplays: ["::before", "::after"].map(
              (pseudo) => getComputedStyle(element.firstElementChild!, pseudo).display,
            ),
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
        if (state === "working") expect(styles.pseudoDisplays).toEqual(["none", "none"]);
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
