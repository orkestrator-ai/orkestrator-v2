import { expect, test } from "@playwright/test";

for (const modifier of ["Control", "Meta"] as const) {
  test(`OSC 8 primary ${modifier} clicks route through the persistent terminal handler`, async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.dismiss();
    });
    await page.goto("/terminal-links");
    await expect(page.getByTestId("osc-ready")).toHaveText("true");
    const screen = page.getByTestId("osc-terminal").locator(".xterm-screen");
    const bounds = await screen.boundingBox();
    if (!bounds) throw new Error("Missing terminal screen");
    const position = { x: 15, y: 10 };
    // Move first so xterm resolves the OSC provider before mousedown/up.
    await page.mouse.move(bounds.x + position.x, bounds.y + position.y);
    await expect(screen).toHaveClass(/xterm-cursor-pointer/);
    await screen.click({ position });
    for (const button of ["right", "middle"] as const) {
      for (const modifiers of [[modifier], [modifier, "Shift"]] as Array<
        Array<typeof modifier | "Shift">
      >) {
        await screen.click({ position, button, modifiers });
      }
    }
    await expect(page.getByTestId("external-opens")).toHaveText("[]");
    await expect(page.getByTestId("internal-opens")).toHaveText("[]");

    await screen.click({ position, modifiers: [modifier] });
    await expect(page.getByTestId("external-opens")).toHaveText(
      '["https://example.com/osc-target"]',
    );
    await screen.click({ position, modifiers: [modifier, "Shift"] });
    await expect(page.getByTestId("internal-opens")).toHaveText(
      JSON.stringify([
        {
          environmentId: "osc-environment",
          sourceTabId: "osc-source-tab",
          url: "https://example.com/osc-target",
        },
      ]),
    );
    expect(dialogs).toEqual([]);
    await page.reload();
    await expect(page.getByTestId("osc-ready")).toHaveText("true");
    await expect(page.getByTestId("external-opens")).toHaveText("[]");
    await expect(page.getByTestId("internal-opens")).toHaveText("[]");
  });
}
