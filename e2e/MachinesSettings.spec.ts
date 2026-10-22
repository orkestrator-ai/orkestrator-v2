import { expect, test } from "@playwright/test";

const name = "🖥️".repeat(32); // 64 code points, 96 UTF-16 code units.

for (const width of [390, 639, 640, 1024]) {
  test(`every machine keeps its actions on screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/machines-settings");
    const rows = page.getByTestId("machine-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Studio");
    for (const label of ["Settings for", "Open", "Updates for"]) {
      for (const index of [0, 1]) {
        const button = rows.nth(index).getByRole("button", { name: new RegExp(`^${label}`) });
        const box = (await button.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    }
    // The machine with an Orkestrator update has a red Updates button.
    await expect(rows.nth(1).getByRole("button", { name: /^Updates for/ })).toHaveAttribute(
      "data-outdated",
      "true",
    );
  });

  for (const { trigger, title, cap } of [
    { trigger: /^Add machine$/, title: "Add machine", cap: 512 },
    { trigger: /^Settings for Desk/, title: /^Desk with/, cap: 672 },
    { trigger: /^Updates for Desk/, title: /^Updates for Desk/, cap: 672 },
  ]) {
    test(`${trigger.source} keeps the viewport gutter and responsive cap at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/machines-settings");
      await page.getByRole("button", { name: trigger }).click();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();

      // Poll the real bounding box until the opening zoom animation settles.
      // Below sm, inherit DialogContent's 8px gutters; at sm, its 16px ones and the cap.
      const expectedWidth = width < 640 ? width - 16 : Math.min(cap, width - 32);
      await expect
        .poll(async () => (await dialog.boundingBox())?.width)
        .toBeCloseTo(expectedWidth, 0);
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(8);
      expect(width - box.x - box.width).toBeGreaterThanOrEqual(8);

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  }
}

for (const inputMethod of ["typing", "paste"] as const) {
  test(`adding a machine accepts the Unicode name boundary through ${inputMethod}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/machines-settings");
    await page.getByRole("button", { name: "Add machine", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add machine" });
    await dialog.getByLabel("Machine name or HTTPS address").fill("workstation");
    await dialog.getByLabel("Gateway token of that machine").fill("gateway-token-123456");
    const input = dialog.getByLabel(/^Name/);
    await input.focus();
    if (inputMethod === "typing") {
      await input.pressSequentially(name);
    } else {
      await page.evaluate((value) => navigator.clipboard.writeText(value), name);
      await page.keyboard.press("ControlOrMeta+V");
    }
    await expect(input).toHaveValue(name);
    // An over-limit name stays editable and reports an error before dispatch.
    await input.pressSequentially("x");
    const submit = dialog.getByRole("button", { name: "Add machine", exact: true });
    await submit.click();
    await expect(dialog.getByText("Use a machine name of 64 characters or fewer.")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("machines-fixture-add-node"))).toBeNull();
    await input.press("End");
    await input.press("Backspace");
    await expect(input).toHaveValue(name);
    await submit.click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("machines-fixture-add-node")))
      .not.toBeNull();
    const added = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("machines-fixture-add-node")!),
    );
    // The bare name takes the tailnet of the machine already known.
    expect(added).toEqual({
      routes: [
        {
          id: "https",
          kind: "https",
          enabled: true,
          origin: "https://workstation.tailnet.ts.net",
        },
      ],
      token: "gateway-token-123456",
      displayName: name,
    });
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("machines-fixture-connect")))
      .not.toBeNull();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("machines-fixture-connect")!),
    );
    expect(saved).toMatchObject({ nickname: name, select: false });
  });
}
