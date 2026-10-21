import { expect, test, type Locator } from "@playwright/test";

function sectionList(article: Locator, heading: string) {
  return article
    .locator("section")
    .filter({ has: article.page().getByRole("heading", { name: heading, exact: true }) })
    .locator(":scope > ul, :scope > ol");
}

async function columns(list: Locator) {
  return list.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
}

for (const paneName of ["report-pane", "findings-pane"]) {
  test(`${paneName} changes columns at the card's 64rem boundary`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/structured-review-layout");
    const pane = page.getByTestId(paneName);
    const article = pane.getByRole("article");
    await expect(article).toBeVisible();
    const lists = [
      sectionList(article, "Issues · 2"),
      sectionList(article, "Test Coverage Gaps · 2"),
    ];
    if (paneName === "report-pane") lists.push(sectionList(article, "Strengths"));

    for (const contentWidth of [1023, 1024, 400]) {
      // Account for padding and border so this tests the query's content-box threshold.
      await pane.evaluate((element, width) => {
        const style = getComputedStyle(element.querySelector("article")!);
        element.style.width = `${width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
      }, contentWidth);
      for (const list of lists)
        await expect.poll(() => columns(list)).toBe(contentWidth >= 1024 ? 2 : 1);
    }
  });

  test(`${paneName} contains items and wrapping prose with long tokens in a narrow pane`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: testInfo.project.name === "mobile-chromium" ? 400 : 1600,
      height: 900,
    });
    await page.goto("/structured-review-layout");
    const pane = page.getByTestId(paneName);
    const article = pane.getByRole("article");
    await expect(article).toBeVisible();
    const geometry = await article.evaluate((element) => {
      const card = element.getBoundingClientRect();
      const items = Array.from(element.querySelectorAll("ul > li, ol > li"));
      const evidenceBlock = element.querySelector("ol > li:first-child dl > div:nth-child(2)");
      if (!(evidenceBlock instanceof HTMLElement)) throw new Error("Missing issue evidence");
      const evidenceRect = evidenceBlock.getBoundingClientRect();
      const evidenceText = evidenceBlock.querySelector("dd")!.firstChild!;
      const prose = document.createRange();
      // Skip the unbreakable token; the surrounding prose must remain readable.
      prose.setStart(evidenceText, 81);
      prose.setEnd(evidenceText, evidenceText.textContent!.length);
      const proseRects = Array.from(prose.getClientRects());
      const command = element.querySelector("ul code");
      const commandItem = command?.closest("li");
      const commandText = command?.parentElement;
      return {
        cardWidth: card.width,
        itemsInsideCard: items.every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left >= card.left && rect.right <= card.right;
        }),
        evidenceInsideCard: evidenceRect.left >= card.left && evidenceRect.right <= card.right,
        proseInsideCard:
          proseRects.length > 0 &&
          proseRects.every((rect) => rect.left >= card.left && rect.right <= card.right),
        evidenceWraps: evidenceRect.height > parseFloat(getComputedStyle(evidenceBlock).lineHeight),
        commandWraps:
          commandText && commandItem
            ? commandText.getBoundingClientRect().height >
              parseFloat(getComputedStyle(commandItem).lineHeight)
            : null,
      };
    });
    expect(geometry.cardWidth).toBe(400);
    expect(geometry.itemsInsideCard).toBe(true);
    expect(geometry.evidenceInsideCard).toBe(true);
    expect(geometry.proseInsideCard).toBe(true);
    expect(geometry.evidenceWraps).toBe(true);
    if (paneName === "report-pane") expect(geometry.commandWraps).toBe(true);
  });
}
