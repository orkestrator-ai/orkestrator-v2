import { expect, test, type Locator } from "@playwright/test";

const name = "🖥️".repeat(32); // 64 code points, 96 UTF-16 code units.
const unbreakableName = "W".repeat(64);

async function expectNoHorizontalOverflow(dialog: Locator) {
  expect(
    await dialog.evaluate((element) =>
      [element, ...element.querySelectorAll("*")].some(
        (node) =>
          (node === element ||
            ["dialog-header", "dialog-title"].includes(node.getAttribute("data-slot") ?? "") ||
            ["auto", "scroll"].includes(getComputedStyle(node).overflowX)) &&
          node.scrollWidth > node.clientWidth + 1,
      ),
    ),
  ).toBe(false);
}

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

  for (const { trigger, title, cap, machineName } of [
    { trigger: /^Add machine$/, title: "Add machine", cap: 512 },
    { trigger: /^Settings for Desk/, title: /^Desk with/, cap: 672 },
    { trigger: /^Updates for Desk/, title: /^Updates for Desk/, cap: 672 },
    {
      trigger: new RegExp(`^Settings for ${unbreakableName}$`),
      title: unbreakableName,
      cap: 672,
      machineName: unbreakableName,
    },
    {
      trigger: new RegExp(`^Updates for ${unbreakableName}`),
      title: `Updates for ${unbreakableName}`,
      cap: 672,
      machineName: unbreakableName,
    },
  ]) {
    test(`${trigger.source} keeps the viewport gutter and responsive cap at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        machineName ? `/machines-settings?machineName=${machineName}` : "/machines-settings",
      );
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

      // The header keeps its inset and nothing in the dialog scrolls sideways.
      const heading = (await dialog.getByRole("heading", { name: title }).boundingBox())!;
      expect(heading.x - box.x).toBeGreaterThanOrEqual(16);
      expect(heading.y - box.y).toBeGreaterThanOrEqual(16);
      await expectNoHorizontalOverflow(dialog);

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  }
}

for (const width of [390, 1024]) {
  for (const height of [300, 400]) {
    for (const kind of ["settings", "updates"] as const) {
      test(`${kind} pins its header and scrolls to the end at ${width}x${height}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await page.goto(`/machines-settings?machineName=${unbreakableName}`);
        const title = kind === "settings" ? unbreakableName : `Updates for ${unbreakableName}`;
        await page
          .getByRole("button", {
            name: new RegExp(
              `^${kind === "settings" ? "Settings" : "Updates"} for ${unbreakableName}`,
            ),
          })
          .click();
        const dialog = page.getByRole("dialog", { name: title, exact: true });
        const header = dialog.locator('[data-slot="dialog-header"]');
        const body = dialog.getByTestId(`machine-${kind}`);
        const lastControl =
          kind === "settings"
            ? body.getByRole("button", { name: `Remove ${unbreakableName}`, exact: true })
            : body.getByRole("button", { name: "Pull the release image", exact: true });
        await expect(lastControl).toBeAttached();
        // Wait for the opening animation before comparing header positions.
        await expect
          .poll(async () => (await dialog.boundingBox())?.height)
          .toBeCloseTo(height * 0.88, 0);
        const box = (await dialog.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        await expectNoHorizontalOverflow(dialog);
        const headerBefore = (await header.boundingBox())!;
        await expect(body).toBeInViewport({ ratio: 1 });
        await expect(lastControl).not.toBeInViewport();

        await body.hover();
        await page.mouse.wheel(0, 10_000);
        await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expect(lastControl).toBeInViewport({ ratio: 1 });
        const headerAfter = (await header.boundingBox())!;
        expect(headerAfter.y).toBeCloseTo(headerBefore.y, 1);
        expect(headerAfter.height).toBeCloseTo(headerBefore.height, 1);
        await expect(header).toBeInViewport({ ratio: 1 });
        expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
        // The final control must fit inside the body, below the pinned header.
        const bodyBox = (await body.boundingBox())!;
        const controlBox = (await lastControl.boundingBox())!;
        expect(controlBox.y).toBeGreaterThanOrEqual(bodyBox.y);
        expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height);
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await expect(dialog).toBeHidden();
      });
    }
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
    // On macOS End scrolls the dialog; explicitly move the caret to the line end.
    await input.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
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

test("self Rebuild with no node id waits for its snapshot and repeated requests return to Container", async ({
  page,
}, testInfo) => {
  await page.goto("/machines-settings?rebuild");
  await page.getByRole("button", { name: /^Updates for Studio/ }).click();
  await page.getByRole("button", { name: "Rebuild Old environment", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /^Updates for Studio/ })).toHaveCount(0);
  const settings = page.getByRole("dialog", { name: "Environment Settings" });
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("machine-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Load environment snapshot" }).click();
  await expect(
    settings.getByRole("button", { name: "Rebuild (keeps files)…", exact: true }),
  ).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    await settings.getByRole("combobox", { name: "Settings section" }).click();
    await page.getByRole("option", { name: "Ports", exact: true }).click();
  } else await settings.getByRole("button", { name: "Ports", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Rebuild (keeps files)…", exact: true }),
  ).toHaveCount(0);
  // Exercise another request without closing the already mounted dialog.
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (entry) => entry.textContent === "Request Rebuild again",
    );
    if (!button) throw new Error("Missing fixture request control");
    button.click();
  });
  await expect(
    settings.getByRole("button", { name: "Rebuild (keeps files)…", exact: true }),
  ).toBeVisible();
});
