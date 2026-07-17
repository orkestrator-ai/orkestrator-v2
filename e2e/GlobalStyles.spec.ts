import { expect, test } from "@playwright/test";

test("global dark surfaces, fonts, terminal, and scrollbar rules compile into browser styles", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop baseline; mobile overrides have a separate test");
  await page.goto("/styles");

  const styles = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px "FiraCode Nerd Font"'),
      document.fonts.load('700 16px "FiraCode Nerd Font"'),
    ]);
    const root = getComputedStyle(document.documentElement);
    const appRoot = getComputedStyle(document.getElementById("root")!);
    const read = (testId: string) => getComputedStyle(
      document.querySelector(`[data-testid="${testId}"]`)!,
    );
    const scrollHost = document.querySelector('[data-testid="scroll-host"]')!;
    const scrollbar = getComputedStyle(scrollHost, "::-webkit-scrollbar");
    const track = getComputedStyle(scrollHost, "::-webkit-scrollbar-track");
    const thumb = getComputedStyle(scrollHost, "::-webkit-scrollbar-thumb");
    const xtermTrack = getComputedStyle(
      document.querySelector('[data-testid="xterm-viewport"]')!,
      "::-webkit-scrollbar-track",
    );
    const compiledRules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText);

    return {
      colorScheme: root.colorScheme,
      scrollbarColor: root.scrollbarColor,
      theme: {
        background: root.getPropertyValue("--color-background").trim(),
        foreground: root.getPropertyValue("--color-foreground").trim(),
        muted: root.getPropertyValue("--color-muted").trim(),
        mutedForeground: root.getPropertyValue("--color-muted-foreground").trim(),
        card: root.getPropertyValue("--color-card").trim(),
        cardForeground: root.getPropertyValue("--color-card-foreground").trim(),
        popover: root.getPropertyValue("--color-popover").trim(),
        popoverForeground: root.getPropertyValue("--color-popover-foreground").trim(),
        border: root.getPropertyValue("--color-border").trim(),
        input: root.getPropertyValue("--color-input").trim(),
        primary: root.getPropertyValue("--color-primary").trim(),
        primaryForeground: root.getPropertyValue("--color-primary-foreground").trim(),
        secondary: root.getPropertyValue("--color-secondary").trim(),
        secondaryForeground: root.getPropertyValue("--color-secondary-foreground").trim(),
        accent: root.getPropertyValue("--color-accent").trim(),
        accentForeground: root.getPropertyValue("--color-accent-foreground").trim(),
        destructive: root.getPropertyValue("--color-destructive").trim(),
        destructiveForeground: root.getPropertyValue("--color-destructive-foreground").trim(),
        ring: root.getPropertyValue("--color-ring").trim(),
        radiusLg: root.getPropertyValue("--radius-lg").trim(),
        radiusMd: root.getPropertyValue("--radius-md").trim(),
        radiusSm: root.getPropertyValue("--radius-sm").trim(),
      },
      fontsReady: document.fonts.check('400 16px "FiraCode Nerd Font"')
        && document.fonts.check('700 16px "FiraCode Nerd Font"'),
      sidebarBackground: read("sidebar-glass").backgroundColor,
      panelBackground: read("panel-surface").backgroundColor,
      dragRegion: read("drag-region").getPropertyValue("-webkit-app-region"),
      userSelect: read("no-select").userSelect,
      terminalBackground: read("terminal-container").backgroundColor,
      xterm: {
        display: read("xterm").display,
        height: read("xterm").height,
        width: read("xterm").width,
        boxSizing: read("xterm").boxSizing,
        padding: read("xterm").padding,
        background: read("xterm").backgroundColor,
        viewportHeight: read("xterm-viewport").height,
        viewportBackground: read("xterm-viewport").backgroundColor,
        viewportTrackBackground: xtermTrack.backgroundColor,
        screenBackground: read("xterm-screen").backgroundColor,
        canvasBackground: read("xterm-canvas").backgroundColor,
        scrollablePointerEvents: read("xterm-scrollable").pointerEvents,
        scrollableZIndex: read("xterm-scrollable").zIndex,
      },
      scrollbar: {
        width: scrollbar.width,
        height: scrollbar.height,
        trackBackground: track.backgroundColor,
        thumbBackground: thumb.backgroundColor,
        thumbRadius: thumb.borderRadius,
        hoverRule: compiledRules.find((rule) => rule.includes("::-webkit-scrollbar-thumb:hover")) ?? "",
      },
      documentContainment: {
        htmlHeight: root.height,
        htmlOverflow: root.overflow,
        bodyHeight: getComputedStyle(document.body).height,
        bodyOverflow: getComputedStyle(document.body).overflow,
        bodyOverscroll: getComputedStyle(document.body).overscrollBehavior,
        bodyTouchAction: getComputedStyle(document.body).touchAction,
        rootHeight: appRoot.height,
        rootOverflow: appRoot.overflow,
      },
    };
  });

  expect(styles.colorScheme).toBe("dark");
  expect(styles.scrollbarColor).toBe("rgb(63, 63, 70) rgb(0, 0, 0)");
  expect(styles.theme).toEqual({
    background: "#000000",
    foreground: "#e4e4e7",
    muted: "#27272a",
    mutedForeground: "#a1a1aa",
    card: "#18181b",
    cardForeground: "#e4e4e7",
    popover: "#27272a",
    popoverForeground: "#e4e4e7",
    border: "#3f3f46",
    input: "#3f3f46",
    primary: "#3b82f6",
    primaryForeground: "#ffffff",
    secondary: "#3f3f46",
    secondaryForeground: "#e4e4e7",
    accent: "#3f3f46",
    accentForeground: "#e4e4e7",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    ring: "#3b82f6",
    radiusLg: "0.5rem",
    radiusMd: "0.375rem",
    radiusSm: "0.25rem",
  });
  expect(styles.fontsReady).toBe(true);
  expect(styles.sidebarBackground).toBe("rgb(24, 25, 28)");
  expect(styles.panelBackground).toBe("rgba(24, 24, 27, 0.8)");
  expect(styles.dragRegion).toBe("drag");
  expect(styles.userSelect).toBe("none");
  expect(styles.terminalBackground).toBe("rgb(0, 0, 0)");
  expect(styles.xterm).toEqual({
    display: "block",
    height: "120px",
    width: "220px",
    boxSizing: "border-box",
    padding: "4px",
    background: "rgb(0, 0, 0)",
    viewportHeight: "112px",
    viewportBackground: "rgb(0, 0, 0)",
    viewportTrackBackground: "rgb(0, 0, 0)",
    screenBackground: "rgba(0, 0, 0, 0)",
    canvasBackground: "rgb(0, 0, 0)",
    scrollablePointerEvents: "auto",
    scrollableZIndex: "12",
  });
  expect(styles.scrollbar).toEqual({
    width: "8px",
    height: "8px",
    trackBackground: "rgb(0, 0, 0)",
    thumbBackground: "rgb(63, 63, 70)",
    thumbRadius: "6px",
    hoverRule: expect.stringContaining("background-color: var(--color-muted-foreground)"),
  });
  expect(styles.documentContainment).toEqual({
    htmlHeight: "900px",
    htmlOverflow: "hidden",
    bodyHeight: "900px",
    bodyOverflow: "hidden",
    bodyOverscroll: "none",
    bodyTouchAction: "manipulation",
    rootHeight: "900px",
    rootOverflow: "hidden",
  });
});

test("mobile global rules resize controls, sidebar spacing, and terminal padding", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile project only");
  await page.goto("/styles");

  const toolbarButton = page.getByTestId("mobile-toolbar-button");
  await expect(toolbarButton).toHaveCSS("min-height", "40px");
  await expect(toolbarButton).toHaveCSS("min-width", "40px");
  await expect(page.getByTestId("mobile-sidebar-header")).toHaveCSS("padding-right", "52px");
  await expect(page.getByTestId("xterm")).toHaveCSS("padding", "2px");
  for (const testId of ["mobile-input", "mobile-textarea", "mobile-select"]) {
    await expect(page.getByTestId(testId)).toHaveCSS("font-size", "16px");
  }
  for (const testId of ["dropdown-content", "context-content"]) {
    await expect(page.getByTestId(testId)).toHaveCSS("max-width", "374px");
  }
  for (const testId of ["dropdown-item", "context-item"]) {
    await expect(page.getByTestId(testId)).toHaveCSS("min-height", "44px");
  }

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(toolbarButton).toHaveCSS("min-height", "0px");
  await expect(page.getByTestId("mobile-sidebar-header")).toHaveCSS("padding-right", "0px");
  await expect(page.getByTestId("xterm")).toHaveCSS("padding", "4px");
});
