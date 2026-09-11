import { expect, test } from "@playwright/test";

const longValidationCommand =
  "mise run test:logged -- --name review-validation-output -- bun test ./apps/web/src/components/review/ReviewValidationStatus.test.tsx --parallel=1 --only-failures";

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

  const list = page.getByRole("list", { name: "Validation commands" });
  await expect(list).toBeVisible();

  const alignment = await list.evaluate((element) => {
    const rows = Array.from(element.querySelectorAll("button"));
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

test("limited rows keep their column alignment and visible separation", async ({ page }) => {
  await page.goto("/review-validation-output");

  const row = page.getByRole("button", { name: "View terminal output for mise run buildworld" });
  const limitation = row.locator("[data-slot='validation-limitation']");
  await expect(limitation).toContainText("Build runner was unavailable.");

  const layout = await row.evaluate((element) => {
    const command = element.querySelector("code");
    const limitationElement = element.querySelector("[data-slot='validation-limitation']");
    if (!(command instanceof HTMLElement) || !(limitationElement instanceof HTMLElement)) {
      throw new Error("Missing limited validation row content");
    }

    const commandRowElements = Array.from(element.children).filter(
      (child) => child !== limitationElement,
    );
    const commandRowBottom = Math.max(
      ...commandRowElements.map((child) => child.getBoundingClientRect().bottom),
    );
    const commandRect = command.getBoundingClientRect();
    const limitationRect = limitationElement.getBoundingClientRect();
    return {
      leftOffset: Math.abs(limitationRect.left - commandRect.left),
      verticalGap: limitationRect.top - commandRowBottom,
    };
  });

  expect(layout.leftOffset).toBeLessThan(1);
  expect(layout.verticalGap).toBeGreaterThanOrEqual(3);
});

test("the widest queued status and long commands fit the mobile validation grid", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/review-validation-output");

  const list = page.getByRole("list", { name: "Validation commands" });
  const queuedRow = page.getByRole("button", {
    name: "View terminal output for mise run typecheck",
  });
  await expect(queuedRow.locator("[data-slot='validation-status']")).toHaveText(
    "waiting for capacity",
  );

  const containment = await list.evaluate((element) => {
    const listRect = element.getBoundingClientRect();
    const rows = Array.from(element.querySelectorAll("button"));
    const commands = rows.map((row) => row.querySelector("code"));
    if (commands.some((command) => !(command instanceof HTMLElement))) {
      throw new Error("Missing validation command cells");
    }

    return {
      listInsideViewport: listRect.left >= 0 && listRect.right <= window.innerWidth,
      rowsInsideList: rows.every((row) => {
        const rect = row.getBoundingClientRect();
        return rect.left >= listRect.left && rect.right <= listRect.right;
      }),
      commandWidths: commands.map((command) => command?.getBoundingClientRect().width ?? 0),
      overflowWidths: [element, ...rows].map((target) => target.scrollWidth - target.clientWidth),
    };
  });

  expect(containment.listInsideViewport).toBe(true);
  expect(containment.rowsInsideList).toBe(true);
  expect(Math.min(...containment.commandWidths)).toBeGreaterThan(0);
  expect(Math.max(...containment.overflowWidths)).toBeLessThanOrEqual(1);
});
