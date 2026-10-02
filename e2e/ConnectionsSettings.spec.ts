import { expect, test } from "@playwright/test";

const nickname = "🖥️".repeat(32); // 64 code points, 96 UTF-16 code units.

for (const width of [390, 639, 640, 1024]) {
  for (const { trigger, title } of [
    { trigger: "Add connection", title: "Add connection" },
    { trigger: "Replace token", title: "Replace gateway token" },
    { trigger: "Rename desk.example", title: "Rename connection" },
  ]) {
    test(`${title} preserves the viewport gutter and responsive cap at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/connections-settings");
      await page.getByRole("button", { name: trigger, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();

      // Poll the real bounding box until the opening zoom animation settles.
      // Below sm, inherit DialogContent's 8px gutters; at sm, cap at 28rem.
      const expectedWidth = width < 640 ? width - 16 : 448;
      await expect
        .poll(async () => (await dialog.boundingBox())?.width)
        .toBeCloseTo(expectedWidth, 0);
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(8);
      expect(width - box.x - box.width).toBeGreaterThanOrEqual(8);
      if (width >= 640) expect(box.width).toBeLessThanOrEqual(448);

      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
    });
  }
}

for (const flow of ["add", "rename"] as const) {
  for (const inputMethod of ["typing", "paste"] as const) {
    test(`${flow} accepts the Unicode nickname boundary through ${inputMethod}`, async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/connections-settings");
      if (flow === "add") {
        await page.getByRole("button", { name: "Add connection" }).click();
        await page.getByLabel("Machine name or HTTPS address").fill("workstation");
        await page.getByLabel("Gateway token", { exact: true }).fill("gateway-token-123456");
      } else {
        await page.getByRole("button", { name: "Rename desk.example" }).click();
      }
      const input = page.getByLabel(/Nickname/);
      await input.focus();
      if (inputMethod === "typing") {
        await input.pressSequentially(nickname);
      } else {
        await page.evaluate((value) => navigator.clipboard.writeText(value), nickname);
        await page.keyboard.press("ControlOrMeta+V");
      }
      await expect(input).toHaveValue(nickname);
      // An over-limit name stays editable and reports an error before dispatch.
      await input.pressSequentially("x");
      const submit = page.getByRole("button", {
        name: flow === "add" ? "Connect" : "Save",
        exact: true,
      });
      await submit.click();
      await expect(page.getByText("Use a nickname of 64 characters or fewer.")).toBeVisible();
      expect(
        await page.evaluate(
          (key) => localStorage.getItem(key),
          `nickname-fixture-${flow === "add" ? "connect" : "rename"}`,
        ),
      ).toBeNull();
      await input.press("End");
      await input.press("Backspace");
      await expect(input).toHaveValue(nickname);
      await submit.click();
      await expect
        .poll(() =>
          page.evaluate(
            (key) => localStorage.getItem(key),
            `nickname-fixture-${flow === "add" ? "connect" : "rename"}`,
          ),
        )
        .not.toBeNull();
      const received = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        `nickname-fixture-${flow === "add" ? "connect" : "rename"}`,
      );
      expect(flow === "add" ? received.nickname : received).toBe(nickname);
      if (flow === "rename") {
        await page.reload();
        await expect(page.getByText(nickname, { exact: true })).toBeVisible();
      }
    });
  }
}
