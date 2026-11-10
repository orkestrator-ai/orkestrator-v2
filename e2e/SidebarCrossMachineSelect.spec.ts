import { expect, test, type Page } from "@playwright/test";

const row = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^${name}, on `) });

/** The Cmd/Ctrl modifier a real mouse click carries on the browser's platform. */
const toggle = { modifiers: ["ControlOrMeta" as const] };

const writes = async (page: Page) =>
  JSON.parse((await page.getByTestId("sidebar-writes").textContent()) ?? "[]") as Array<{
    args: { nodeId: string; command: string; args: { environmentId: string } };
  }>;

test.describe("multi-select across machines", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/sidebar-drag?cross-machine");
    await expect(row(page, "remote-feature")).toBeVisible();
    await expect(row(page, "spare-feature")).toBeVisible();
    await expect(row(page, "p-env-1")).toBeVisible();
  });

  test("Cmd/Ctrl-click selects rows on any machine without opening them", async ({ page }) => {
    await row(page, "remote-feature").click(toggle);
    await row(page, "p-env-1").click(toggle);
    await row(page, "spare-feature").click(toggle);

    await expect(page.getByText("3 selected")).toBeVisible();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(3);
    // Nothing opened: no other machine's row is marked as the one on show.
    await expect(
      page.locator('[data-testid="federated-environment-row"][data-selected]'),
    ).toHaveCount(0);
  });

  test("Shift-click selects the rows between, across machines, without selecting text", async ({
    page,
  }) => {
    // Click the names, rather than empty row space, so the browser establishes
    // a text-selection anchor and would extend it on the Shift mousedown.
    await row(page, "p-env-1").getByText("p-env-1", { exact: true }).click();
    await row(page, "spare-fix")
      .getByText("spare-fix", { exact: true })
      .click({ modifiers: ["Shift"] });

    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");

    const ids = await page
      .locator("[data-sidebar-scroll] [data-environment-selection-id]")
      .evaluateAll((rows) =>
        rows.map((element) => element.getAttribute("data-environment-selection-id")!),
      );
    const [from, to] = [
      ids.indexOf("p-env-1"),
      ids.indexOf(JSON.stringify(["bk_spare", "environment", "spare-env"])),
    ];
    const count = Math.abs(to - from) + 1;
    expect(count).toBeGreaterThan(1);
    await expect(page.getByText(`${count} selected`)).toBeVisible();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(count);
  });

  test("the same environment ID on two machines is two selections", async ({ page }) => {
    await row(page, "remote-feature").click(toggle);
    await expect(page.getByText("1 selected")).toBeVisible();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(1);
  });

  test("Stop goes to each row's own machine and skips one that is down", async ({ page }) => {
    await row(page, "remote-feature").click(toggle);
    await row(page, "spare-fix").click(toggle);
    await row(page, "down-feature").click(toggle);
    await page.getByTitle("Stop selected").click();

    await expect
      .poll(async () =>
        (await writes(page))
          // Rows also read their details from their machines.
          .filter(({ args }) => args.command === "stop_environment")
          .map(({ args }) => [args.nodeId, args.command, args.args.environmentId]),
      )
      .toEqual([
        ["bk_remote", "stop_environment", "r-env"],
        ["bk_spare", "stop_environment", "spare-env"],
      ]);
  });

  test("the delete confirmation names each machine", async ({ page }) => {
    await row(page, "p-env-1").click(toggle);
    await row(page, "remote-feature").click(toggle);
    await row(page, "down-feature").click(toggle);
    await page.getByTitle("Delete selected").click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("listitem").filter({ hasText: "remote-feature" })).toContainText(
      "on Remote",
    );
    await expect(dialog.getByRole("listitem").filter({ hasText: "down-feature" })).toContainText(
      "(unavailable, skipped)",
    );
  });
});

test("pending restart disables bulk controls and marks its row busy", async ({
  page,
}, testInfo) => {
  await page.goto("/sidebar-drag?cross-machine");
  const target = row(page, "remote-feature");
  await target.click(toggle);
  await page.getByTestId("sidebar-writes").evaluate((element) => {
    (element as HTMLElement).style.display = "none";
  });
  await page.screenshot({
    path: `output/visual-previews/bulk-actions-before-${testInfo.project.name}.png`,
  });
  await page.evaluate(() => {
    const original = window.orkestrator!.invoke;
    window.orkestrator!.invoke = async <T = unknown>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      const result = await original<T>(command, args);
      if (command === "invoke_on_node" && args?.command === "stop_environment") {
        await new Promise<void>((resolve) =>
          window.addEventListener("release-test-stop", () => resolve(), { once: true }),
        );
      }
      return result;
    };
  });
  await page.getByTitle("Restart selected").click();
  await expect(target).toHaveAttribute("aria-busy", "true");
  await expect(target.locator(".animate-spin")).toBeVisible();
  await expect(page.getByTitle("Stop selected")).toBeDisabled();
  await expect(page.getByTitle("Restart selected")).toBeDisabled();
  await expect(page.getByTitle("Delete selected")).toBeDisabled();
  await page.screenshot({
    path: `output/visual-previews/bulk-actions-pending-${testInfo.project.name}.png`,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("release-test-stop")));
  await expect(target).not.toHaveAttribute("aria-busy");
  await expect(page.getByTitle("Stop selected")).toBeEnabled();
  expect(
    (await writes(page)).filter(({ args }) => args.command === "stop_environment"),
  ).toHaveLength(1);
  expect(
    (await writes(page)).filter(({ args }) => args.command === "start_environment_background"),
  ).toHaveLength(1);
});

test("remote row arming expires and child-frame focus revokes it", async ({ page }, testInfo) => {
  await page.goto("/sidebar-drag?cross-machine");
  const remote = row(page, "remote-feature");
  await expect(remote).toBeVisible();
  await page.evaluate(() => {
    const field = document.createElement("textarea");
    field.setAttribute("aria-label", "Editing surface");
    field.value = "existing text";
    document.body.append(field);
    const frame = document.createElement("iframe");
    frame.title = "Child workspace";
    frame.srcdoc = '<textarea aria-label="Child terminal">existing text</textarea>';
    document.body.append(frame);
  });
  await page.screenshot({
    path: `output/visual-previews/delete-arm-before-${testInfo.project.name}.png`,
  });
  // Leaving multi-select through a plain click must still arm the remote row.
  await row(page, "p-env-1").click(toggle);
  await remote.click();
  await page.getByRole("textbox", { name: "Editing surface" }).focus();
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.screenshot({
    path: `output/visual-previews/delete-arm-confirmation-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.clock.install();
  await remote.click();
  await page.getByRole("textbox", { name: "Editing surface" }).focus();
  // Advance the browser clock past the short arming window without a wall-clock sleep.
  await page.clock.fastForward(1600);
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  // Control+Backspace is the app shortcut on every OS; when it expires,
  // Chromium's native editor deletes one character on macOS, a word elsewhere.
  await expect(page.getByRole("textbox", { name: "Editing surface" })).toHaveValue(
    process.platform === "darwin" ? "existing tex" : "existing ",
  );
  await remote.click();
  await page.frameLocator('iframe[title="Child workspace"]').getByRole("textbox").focus();
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Editing surface" }).focus();
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
