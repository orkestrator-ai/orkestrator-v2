import { expect, test } from "@playwright/test";
import { startChangeTrackingHost } from "./change-tracking-client";

const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const BLUE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";

test("live images decode, refresh, recover after missed edits, and fall back on deletion or corrupt bytes", async ({
  page,
}) => {
  const host = await startChangeTrackingHost();
  try {
    await host.invoke("fixture_image", { base64: RED_PNG });
    await page.exposeFunction("changesInvoke", (command: string, args: Record<string, unknown>) =>
      host.invoke(command, args),
    );
    await page.goto("/change-tracking?image=image.png");
    const image = page.getByRole("img", { name: "image.png", exact: true });
    const expectDecoded = async (base64: string) => {
      await expect(image).toHaveAttribute("src", `data:image/png;base64,${base64}`);
      await expect
        .poll(() =>
          image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth === 1),
        )
        .toBe(true);
    };
    await expectDecoded(RED_PNG);
    await host.invoke("fixture_image", { base64: BLUE_PNG });
    await page.evaluate(() => window.changesInvalidate?.(1));
    await expectDecoded(BLUE_PNG);

    await page.getByRole("button", { name: "Switch away" }).click();
    await host.invoke("fixture_image", { base64: RED_PNG });
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await expectDecoded(RED_PNG);
    await page.reload();
    await expectDecoded(RED_PNG);

    await host.invoke("fixture_image", { base64: BLUE_PNG });
    await page.evaluate(() => window.changesReconnect?.());
    await expectDecoded(BLUE_PNG);
    await host.invoke("fixture_image", { deleted: true });
    await page.evaluate(() => window.changesInvalidate?.(2));
    await expect(page.getByTestId("diff-viewer-header")).toBeVisible();
    await expect(image).toHaveCount(0);

    await host.invoke("fixture_image", { base64: "bm90IGFuIGltYWdl" });
    await page.evaluate(() => window.changesInvalidate?.(3));
    await expect(page.getByTestId("change-hunks")).toContainText("not an image");
    await expect(image).toHaveCount(0);
    await host.invoke("fixture_image", { base64: RED_PNG });
    await page.evaluate(() => window.changesInvalidate?.(4));
    await expectDecoded(RED_PNG);
  } finally {
    await host.close();
  }
});

test("live SVG targets expose source hunks", async ({ page }) => {
  const host = await startChangeTrackingHost();
  try {
    await host.invoke("fixture_image", {
      svg: true,
      base64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><title>Source change</title></svg>\n',
      ).toString("base64"),
    });
    await page.exposeFunction("changesInvoke", (command: string, args: Record<string, unknown>) =>
      host.invoke(command, args),
    );
    await page.goto("/change-tracking?image=image.svg");
    await expect(page.getByTestId("change-hunks")).toContainText("Source change");
    await expect(page.getByRole("img", { name: "image.svg", exact: true })).toHaveCount(0);
  } finally {
    await host.close();
  }
});

test("real change commands retain history and tool evidence, replay restore, and recover missed live edits", async ({
  page,
}) => {
  const host = await startChangeTrackingHost();
  let lostApply = false;
  try {
    await page.exposeFunction(
      "changesInvoke",
      async (command: string, args: Record<string, unknown>) => {
        const result = await host.invoke(command, args);
        if (command === "changes_apply_restore" && !lostApply) {
          lostApply = true;
          throw new Error("fixture response lost");
        }
        return result;
      },
    );
    await page.goto("/change-tracking");
    await expect(
      page.getByTestId("fixture-tool-changes").getByTestId("change-count-badge"),
    ).toBeVisible();
    await expect(
      page.getByTestId("change-hunks").getByText("+FIRST", { exact: true }),
    ).toBeVisible();
    await page.getByTestId("turn-changes-toggle").click();
    const history = page.getByTestId("turn-changes-history");
    await expect(history.getByTestId("turn-changes-entry")).toHaveCount(1);
    await history.getByTestId("restore-changes-button").click();
    const dialog = page.getByTestId("restore-preview");
    await dialog.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("result is unknown");
    await dialog.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await host.invoke("fixture_content")).toBe("one\ntwo\n");
    await host.invoke("fixture_edit");
    await page.getByRole("button", { name: "Switch away" }).click();
    await host.invoke("fixture_edit", { version: "second" });
    // Both content invalidations were missed while this environment was hidden.
    await page.evaluate(() => window.changesReconnect?.());
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await expect(
      page.getByTestId("change-hunks").getByText("+SECOND", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByTestId("change-hunks").getByText("+SECOND", { exact: true }),
    ).toBeVisible();
    await page.getByTestId("turn-changes-toggle").click();
    await expect(page.getByTestId("turn-changes-entry")).toHaveCount(1);
    await expect(
      page.getByTestId("fixture-tool-changes").getByTestId("change-count-badge"),
    ).toBeVisible();
  } finally {
    await host.close();
  }
});
