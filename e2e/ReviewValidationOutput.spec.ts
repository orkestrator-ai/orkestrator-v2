import { expect, test } from "@playwright/test";

test("terminal output title stays inside the dialog and is centered", async ({ page }) => {
  await page.goto("/review-validation-output");
  await page.getByRole("button", { name: "View terminal output for cargo test --workspace" }).click();

  const dialog = page.getByRole("dialog", { name: "Terminal output" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("cargo test --workspace")).toBeVisible();

  const layout = await dialog.evaluate((element) => {
    const dialogElement = element as HTMLElement;
    const header = dialogElement.querySelector("[data-slot='dialog-header']");
    const title = dialogElement.querySelector("[data-slot='dialog-title']");
    const command = dialogElement.querySelector("[data-slot='dialog-description']");
    const close = dialogElement.querySelector('[data-slot="dialog-close"]');
    const refresh = dialogElement.querySelector('[aria-label="Refresh terminal output"]');
    const copy = dialogElement.querySelector('[aria-label="Copy terminal output"]');
    if (
      !(header instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(command instanceof HTMLElement) ||
      !(close instanceof HTMLElement) ||
      !(refresh instanceof HTMLElement) ||
      !(copy instanceof HTMLElement)
    ) {
      throw new Error("Missing terminal output chrome");
    }

    const dialogRect = dialogElement.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const commandRect = command.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const refreshRect = refresh.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    const overlaps = (left: DOMRect, right: DOMRect) =>
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;

    return {
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
      headerTop: headerRect.top,
      dialogLeft: dialogRect.left,
      dialogRight: dialogRect.right,
      dialogTop: dialogRect.top,
      titleCenterOffset: Math.abs((titleRect.left + titleRect.right) / 2 - (dialogRect.left + dialogRect.right) / 2),
      commandCenterOffset: Math.abs(
        (commandRect.left + commandRect.right) / 2 - (dialogRect.left + dialogRect.right) / 2,
      ),
      commandFullyVisible: command.scrollWidth <= command.clientWidth + 1,
      commandText: command.textContent,
      closeOverlapsTitle: overlaps(closeRect, titleRect),
      closeOverlapsCommand: overlaps(closeRect, commandRect),
      closeOverlapsRefresh: overlaps(closeRect, refreshRect),
      closeOverlapsCopy: overlaps(closeRect, copyRect),
    };
  });

  expect(layout.headerLeft).toBeGreaterThanOrEqual(layout.dialogLeft);
  expect(layout.headerRight).toBeLessThanOrEqual(layout.dialogRight);
  expect(layout.headerTop).toBeGreaterThanOrEqual(layout.dialogTop);
  expect(layout.titleCenterOffset).toBeLessThan(12);
  expect(layout.commandCenterOffset).toBeLessThan(12);
  expect(layout.commandFullyVisible).toBe(true);
  expect(layout.commandText).toBe("cargo test --workspace");
  expect(layout.closeOverlapsTitle).toBe(false);
  expect(layout.closeOverlapsCommand).toBe(false);
  expect(layout.closeOverlapsRefresh).toBe(false);
  expect(layout.closeOverlapsCopy).toBe(false);
});

test("validation run and queue times share columns across mixed rows", async ({ page }) => {
  await page.goto("/review-validation-output");

  const list = page.getByRole("list", { name: "Validation commands" });
  await expect(list).toBeVisible();

  const alignment = await list.evaluate((element) => {
    const rows = [...element.querySelectorAll("button")];
    const elapsed = rows.map((row) => row.querySelector("[data-slot='validation-elapsed']"));
    const queued = rows.map((row) => row.querySelector("[data-slot='validation-queued']"));
    if (elapsed.some((cell) => !(cell instanceof HTMLElement)) || queued.some((cell) => !(cell instanceof HTMLElement))) {
      throw new Error("Missing validation time cells");
    }

    const lefts = (cells: HTMLElement[]) => [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left)))];
    const rights = (cells: HTMLElement[]) => [
      ...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().right))),
    ];

    return {
      rowCount: rows.length,
      elapsedLefts: lefts(elapsed as HTMLElement[]),
      elapsedRights: rights(elapsed as HTMLElement[]),
      queuedLefts: lefts(queued as HTMLElement[]),
      queuedRights: rights(queued as HTMLElement[]),
      elapsedValues: elapsed.map((cell) => cell?.textContent ?? ""),
      queuedValues: queued.map((cell) => cell?.textContent ?? ""),
    };
  });

  expect(alignment.rowCount).toBeGreaterThan(1);
  expect(alignment.elapsedValues).toContain("46.2s");
  expect(alignment.elapsedValues).toContain("2.3s");
  expect(alignment.queuedValues).toContain("2.0s");
  expect(alignment.queuedValues).toContain("");
  expect(alignment.elapsedLefts).toEqual([alignment.elapsedLefts[0]]);
  expect(alignment.elapsedRights).toEqual([alignment.elapsedRights[0]]);
  expect(alignment.queuedLefts).toEqual([alignment.queuedLefts[0]]);
  expect(alignment.queuedRights).toEqual([alignment.queuedRights[0]]);
});
