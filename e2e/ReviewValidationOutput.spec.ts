import { expect, test, type Page } from "@playwright/test";

const longValidationCommand =
  "mise run test:logged -- --name review-validation-output -- bun test ./apps/web/src/components/review/ReviewValidationStatus.test.tsx --parallel=1 --only-failures";

function validationRow(page: Page, command: string) {
  return page.getByRole("button", { name: `View terminal output for ${command}` });
}

test("terminal output title and long command stay inside the dialog and are centered", async ({
  page,
}) => {
  await page.goto("/review-validation-output");
  await page
    .getByRole("button", { name: `View terminal output for ${longValidationCommand}` })
    .click();

  const dialog = page.getByRole("dialog", { name: "Terminal output" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(longValidationCommand)).toBeVisible();

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

    const textRects = (target: Node) => {
      const range = document.createRange();
      range.selectNodeContents(target);
      return Array.from(range.getClientRects());
    };
    const centerOffset = (left: number, right: number, container: DOMRect) =>
      Math.abs((left + right) / 2 - (container.left + container.right) / 2);
    const overlaps = (left: DOMRect, right: DOMRect) =>
      left.left < right.right &&
      left.right > right.left &&
      left.top < right.bottom &&
      left.bottom > right.top;

    const dialogRect = dialogElement.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const titleTextNode = Array.from(title.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
    const titleTextRect = titleTextNode ? textRects(titleTextNode)[0] : undefined;
    const titleIconRect = title.querySelector("svg")?.getBoundingClientRect();
    const commandRects = textRects(command);
    const closeRect = close.getBoundingClientRect();
    const refreshRect = refresh.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    if (!titleTextRect || !titleIconRect || commandRects.length === 0) {
      throw new Error("Missing terminal output text fragments");
    }

    const titleRun = {
      left: Math.min(titleIconRect.left, titleTextRect.left),
      right: Math.max(titleIconRect.right, titleTextRect.right),
      top: Math.min(titleIconRect.top, titleTextRect.top),
      bottom: Math.max(titleIconRect.bottom, titleTextRect.bottom),
    } as DOMRect;

    return {
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
      headerTop: headerRect.top,
      dialogLeft: dialogRect.left,
      dialogRight: dialogRect.right,
      dialogTop: dialogRect.top,
      titleCenterOffset: centerOffset(titleRun.left, titleRun.right, dialogRect),
      commandLineCenterOffsets: commandRects.map((rect) =>
        centerOffset(rect.left, rect.right, dialogRect),
      ),
      commandLinesInsideDialog: commandRects.every(
        (rect) => rect.left >= dialogRect.left && rect.right <= dialogRect.right,
      ),
      commandText: command.textContent,
      closeOverlapsTitle: overlaps(closeRect, titleRun),
      closeOverlapsCommand: commandRects.some((rect) => overlaps(closeRect, rect)),
      closeOverlapsRefresh: overlaps(closeRect, refreshRect),
      closeOverlapsCopy: overlaps(closeRect, copyRect),
    };
  });

  expect(layout.headerLeft).toBeGreaterThanOrEqual(layout.dialogLeft);
  expect(layout.headerRight).toBeLessThanOrEqual(layout.dialogRight);
  expect(layout.headerTop).toBeGreaterThanOrEqual(layout.dialogTop);
  expect(layout.titleCenterOffset).toBeLessThan(12);
  expect(Math.max(...layout.commandLineCenterOffsets)).toBeLessThan(12);
  expect(layout.commandLinesInsideDialog).toBe(true);
  expect(layout.commandText).toBe(longValidationCommand);
  expect(layout.closeOverlapsTitle).toBe(false);
  expect(layout.closeOverlapsCommand).toBe(false);
  expect(layout.closeOverlapsRefresh).toBe(false);
  expect(layout.closeOverlapsCopy).toBe(false);
});

test("validation run and queue times share columns across mixed rows", async ({ page }) => {
  await page.goto("/review-validation-output");

  const list = page.getByRole("table", { name: "Validation commands" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("columnheader")).toHaveText([
    "Command",
    "Status",
    "Duration",
    "Queued",
    "Output",
  ]);

  const alignment = await list.evaluate((element) => {
    const rows = Array.from(element.querySelectorAll("tbody tr"));
    const elapsed = rows.map((row) => row.querySelector("[data-slot='validation-elapsed']"));
    const queued = rows.map((row) => row.querySelector("[data-slot='validation-queued']"));
    if (
      elapsed.some((cell) => !(cell instanceof HTMLElement)) ||
      queued.some((cell) => !(cell instanceof HTMLElement))
    ) {
      throw new Error("Missing validation time cells");
    }

    const lefts = (cells: HTMLElement[]) =>
      Array.from(new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left))));
    const rights = (cells: HTMLElement[]) =>
      Array.from(new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().right))));

    return {
      rowCount: rows.length,
      rowBorders: rows.slice(0, -1).map((row) => getComputedStyle(row).borderBottomWidth),
      columnBorders: Array.from(rows[0]!.querySelectorAll("td"))
        .slice(0, -1)
        .map((cell) => getComputedStyle(cell).borderRightWidth),
      elapsedLefts: lefts(elapsed as HTMLElement[]),
      elapsedRights: rights(elapsed as HTMLElement[]),
      queuedLefts: lefts(queued as HTMLElement[]),
      queuedRights: rights(queued as HTMLElement[]),
      elapsedValues: elapsed.map((cell) => cell?.textContent ?? ""),
      queuedValues: queued.map((cell) => cell?.textContent ?? ""),
    };
  });

  expect(alignment.rowCount).toBeGreaterThan(1);
  expect(alignment.rowBorders.every((width) => parseFloat(width) > 0)).toBe(true);
  expect(alignment.columnBorders.every((width) => parseFloat(width) > 0)).toBe(true);
  expect(alignment.elapsedValues).toContain("46.2s");
  expect(alignment.elapsedValues).toContain("2.3s");
  expect(alignment.queuedValues).toContain("2.0s");
  expect(alignment.queuedValues).toContain("");
  expect(alignment.elapsedLefts).toEqual([alignment.elapsedLefts[0]]);
  expect(alignment.elapsedRights).toEqual([alignment.elapsedRights[0]]);
  expect(alignment.queuedLefts).toEqual([alignment.queuedLefts[0]]);
  expect(alignment.queuedRights).toEqual([alignment.queuedRights[0]]);
});

test("limited rows keep their column alignment and visible separation", async ({ page }) => {
  await page.goto("/review-validation-output");

  const row = validationRow(page, "mise run buildworld");
  const limitation = row.locator("[data-slot='validation-limitation']");
  await expect(limitation).toContainText("Build runner was unavailable.");

  const layout = await row.evaluate((element) => {
    const command = element.querySelector("code");
    const limitationElement = element.querySelector("[data-slot='validation-limitation']");
    if (!(command instanceof HTMLElement) || !(limitationElement instanceof HTMLElement)) {
      throw new Error("Missing limited validation row content");
    }

    const commandRect = command.getBoundingClientRect();
    const limitationRect = limitationElement.getBoundingClientRect();
    return {
      leftOffset: Math.abs(limitationRect.left - commandRect.left),
      verticalGap: limitationRect.top - commandRect.bottom,
    };
  });

  expect(layout.leftOffset).toBeLessThan(1);
  expect(layout.verticalGap).toBeGreaterThanOrEqual(3);
});

test("the mobile validation table scrolls within its container and keeps commands readable", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/review-validation-output");

  const list = page.getByRole("table", { name: "Validation commands" });
  const queuedRow = validationRow(page, "mise run typecheck");
  const queuedStatus = queuedRow.locator("[data-slot='validation-status']");
  await expect(queuedStatus).toHaveText("waiting for capacity");

  const statusLayout = await queuedStatus.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const textRects = Array.from(range.getClientRects());
    const style = getComputedStyle(element);
    const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return {
      contentWidth: element.getBoundingClientRect().width - horizontalPadding,
      lineCount: textRects.length,
      textWidth: Math.max(...textRects.map((rect) => rect.width)),
      whiteSpace: style.whiteSpace,
    };
  });

  const containment = await list.evaluate((element) => {
    const listRect = element.getBoundingClientRect();
    const rows = Array.from(element.querySelectorAll("tbody tr"));
    const commands = rows.map((row) => row.querySelector("code"));
    if (commands.some((command) => !(command instanceof HTMLElement))) {
      throw new Error("Missing validation command cells");
    }

    return {
      containerInsideViewport:
        element.parentElement!.getBoundingClientRect().left >= 0 &&
        element.parentElement!.getBoundingClientRect().right <= window.innerWidth,
      scrollable:
        getComputedStyle(element.parentElement!).overflowX === "auto" &&
        element.parentElement!.scrollWidth > element.parentElement!.clientWidth,
      rowsInsideList: rows.every((row) => {
        const rect = row.getBoundingClientRect();
        return rect.left >= listRect.left && rect.right <= listRect.right;
      }),
      commandWidths: commands.map(
        (command) => command?.parentElement?.getBoundingClientRect().width ?? 0,
      ),
      overflowWidths: [element, ...rows].map((target) => target.scrollWidth - target.clientWidth),
    };
  });

  expect(containment.containerInsideViewport).toBe(true);
  expect(containment.scrollable).toBe(true);
  expect(containment.rowsInsideList).toBe(true);
  expect(Math.min(...containment.commandWidths)).toBeGreaterThan(100);
  expect(Math.max(...containment.overflowWidths)).toBeLessThanOrEqual(1);
  expect(statusLayout.whiteSpace).toBe("nowrap");
  expect(statusLayout.lineCount).toBe(1);
  expect(statusLayout.contentWidth).toBeGreaterThanOrEqual(statusLayout.textWidth);
});

test("queue diagnostics rehydrate after an inactive view and clear on completion", async ({
  page,
}) => {
  await page.goto("/review-validation-output");
  const row = validationRow(page, "mise run typecheck");
  await expect(row.locator("[data-slot='validation-queue-reason']")).toContainText("2/8 slots");
  await page.getByRole("button", { name: "Hide validation", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Show validation", exact: true }).click();
  await expect(row.locator("[data-slot='validation-queue-reason']")).toContainText(
    "exclusive resource",
  );
  await page.getByRole("button", { name: "Hide validation", exact: true }).click();
  await page.getByRole("button", { name: "Complete background validation" }).click();
  await page.getByRole("button", { name: "Show validation", exact: true }).click();
  await expect(row.locator("[data-slot='validation-status']")).toHaveText("passed");
  await expect(row.locator("[data-slot='validation-queue-reason']")).toHaveCount(0);
  await expect(row.locator("[data-slot='validation-queued']")).toHaveText("4.0s");
});
