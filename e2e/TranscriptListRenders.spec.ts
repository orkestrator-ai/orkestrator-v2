import { expect, test, type Page } from "@playwright/test";

/**
 * Whether a render of the native tab reaches `<Virtuoso>`. The library
 * republishes every prop from a layout effect with no dependency list, which
 * shows up as a `nested-update` commit, so counting them here says what a mocked
 * list in happy-dom cannot. Rows must still follow each input that changes them:
 * a dependency left out of the memoised inputs leaves a row showing stale
 * content, and only these checks would catch it.
 */

const WRITES = 25;
const row = (page: Page, key: string) => page.locator(`[data-chat-message-key="${key}"]`);

/** Waits out start-up: the tab has stopped committing on its own. */
async function settle(page: Page) {
  await expect(async () => {
    await page.evaluate(() => window.transcriptListFixture!.resetCommits());
    await page.waitForTimeout(400);
    const { commits, caughtUp } = await page.evaluate(() => ({
      commits: window.transcriptListFixture!.commits(),
      caughtUp: window.transcriptListFixture!.caughtUp(),
    }));
    expect(caughtUp).toBe(true);
    expect(commits.every((tab) => tab.update === 0 && tab.nested === 0)).toBe(true);
  }).toPass({ timeout: 15_000 });
}

async function openTranscript(page: Page, query = "") {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/transcript-list-renders${query}`);
  await page.waitForFunction(() => window.transcriptListFixture?.ready() === true);
  if (query.includes("platform=claude")) {
    await expect(page.locator('[data-background-task-id="fixture-background"]')).toBeVisible();
  } else {
    await expect(row(page, "row-99").first()).toBeVisible();
  }
  await settle(page);
}

async function openFind(page: Page) {
  await page.keyboard.press("ControlOrMeta+f");
  return page.getByRole("textbox", { name: "Find in chat" });
}

/** Renders the tab without changing anything the list shows, and counts the commits. */
async function expectNoNestedUpdates(page: Page) {
  await settle(page);
  await page.evaluate(() => window.transcriptListFixture!.resetCommits());
  await page.evaluate((writes) => window.transcriptListFixture!.writeUnrelated(writes), WRITES);
  await page.waitForTimeout(200);
  const commits = await page.evaluate(() => window.transcriptListFixture!.commits());
  for (const tab of commits) {
    // The writes did render the tab, so a clean count means something.
    expect(tab.update).toBeGreaterThanOrEqual(WRITES);
    expect(tab.nested).toBe(0);
  }
}

test.skip(({ hasTouch }) => hasTouch, "render counts need the one layout");

test("a render that changes nothing the list shows causes no nested update", async ({ page }) => {
  await openTranscript(page);
  await expectNoNestedUpdates(page);
});

test("Claude background-task rows avoid unrelated updates and follow task snapshots", async ({
  page,
}) => {
  await openTranscript(page, "?platform=claude");
  const task = page.locator('[data-background-task-id="fixture-background"]');
  await expect(task).toHaveCount(1);
  await expect(task).toHaveAttribute("data-background-task-status", "running");
  await expect(task).toContainText("Reading fixture files");
  await expectNoNestedUpdates(page);

  // Only session state changes: the launch message and transcript token stay put.
  await page.evaluate(() =>
    window.transcriptListFixture!.setBackgroundTask({
      status: "completed",
      summary: "Fixture background work finished",
    }),
  );
  await expect(task).toHaveCount(1);
  await expect(task).toHaveAttribute("data-background-task-status", "completed");
  await expect(task).toContainText("Fixture background work finished");
  await expectNoNestedUpdates(page);
});

test("Subork dialog list skips unrelated parent renders and follows a transcript revision", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/transcript-list-renders?subork=1");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(row(page, "row-99")).toContainText("Fixture row 99");
  // The dialog reads stored transcripts, so it does not poll native-tab tokens.
  await expect(async () => {
    await page.evaluate(() => window.transcriptListFixture!.resetCommits());
    await page.waitForTimeout(400);
    expect((await page.evaluate(() => window.transcriptListFixture!.commits()))[0]!.nested).toBe(0);
  }).toPass();
  await page.evaluate(() => window.transcriptListFixture!.resetCommits());
  await page.evaluate((writes) => window.transcriptListFixture!.writeUnrelated(writes), WRITES);
  const [counts] = await page.evaluate(() => window.transcriptListFixture!.commits());
  expect(counts!.update).toBeGreaterThanOrEqual(WRITES);
  expect(counts!.nested).toBe(0);
  await expect(page.getByRole("dialog")).toContainText(`unrelated write ${WRITES}`);

  await page.evaluate(async () => {
    window.transcriptListFixture!.stream("revised subork answer");
    await window.transcriptListFixture!.writeUnrelated(1);
  });
  await expect(row(page, "row-99")).toContainText("revised subork answer");
});

test("neither of two visible tabs gets a nested update", async ({ page }) => {
  await openTranscript(page, "?tabs=2");
  await expectNoNestedUpdates(page);
});

test("rows hold still whatever else the list is showing", async ({ page }) => {
  test.setTimeout(120_000);
  await openTranscript(page, "?earlier=1");
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeVisible();
  await expectNoNestedUpdates(page);

  await page.evaluate(() =>
    window.transcriptListFixture!.setTurn({
      phase: "running",
      startedAt: Date.now(),
      activity: { thinkingTokens: 1200 },
    }),
  );
  await expectNoNestedUpdates(page);

  await page.evaluate(() => window.transcriptListFixture!.setTurn({ phase: "cancelling" }));
  await expectNoNestedUpdates(page);

  await page.evaluate(() => window.transcriptListFixture!.setTurn({ phase: "idle" }));
  await page.evaluate(() => window.transcriptListFixture!.setQuestion("Carry on with the plan?"));
  await expect(page.getByTestId("transcript-cards")).toContainText("Carry on with the plan?");
  await expectNoNestedUpdates(page);
  await page.evaluate(() => window.transcriptListFixture!.setQuestion(null));

  // A find session, and a focused row, whose overscan is a fresh value each render.
  const input = await openFind(page);
  await input.fill("Fixture row 92");
  await expect(page.locator("[data-chat-message-index].outline-amber-400\\/35")).toHaveCount(1);
  await expectNoNestedUpdates(page);
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: /Fork Codex session/ })
    .last()
    .focus();
  await expectNoNestedUpdates(page);
});

test("streaming still updates rows, through the nested update it needs", async ({ page }) => {
  await openTranscript(page);
  await page.evaluate(() => window.transcriptListFixture!.resetCommits());

  await page.evaluate(() => window.transcriptListFixture!.stream("streamed-frame-one"));
  await expect(row(page, "row-99")).toContainText("streamed-frame-one");
  await page.evaluate(() => window.transcriptListFixture!.stream("streamed-frame-two"));
  await expect(row(page, "row-99")).toContainText("streamed-frame-two");
  expect(
    (await page.evaluate(() => window.transcriptListFixture!.commits()))[0]!.nested,
  ).toBeGreaterThan(0);

  await page.evaluate(() =>
    window.transcriptListFixture!.stream("a brand new row", { newRow: true }),
  );
  await expect(page.getByText("a brand new row", { exact: true })).toBeInViewport();
  await expectNoNestedUpdates(page);
  await expect(page.getByText("a brand new row", { exact: true })).toBeVisible();
});

// Codex's fork plan changes with the messages, which would hide a row that had
// lost sight of them. Cursor has no fork action.
for (const query of ["", "?platform=cursor"]) {
  test(`a row follows the message before it${query}`, async ({ page }) => {
    await openTranscript(page, query);
    await expect(row(page, "row-97")).toContainText("responded in 1m 0s");

    // Nothing about row 97 itself changes: only the list's view of its predecessor.
    await page.evaluate(() =>
      window.transcriptListFixture!.moveRowTime("row-96", "2026-11-05T01:30:00.000Z"),
    );
    await expect(row(page, "row-97")).toContainText("responded in 7m 0s");
  });
}

test("the current row follows find", async ({ page }) => {
  await openTranscript(page);
  const current = page.locator("[data-chat-message-index].outline-amber-400\\/35");

  const input = await openFind(page);
  await input.fill("Fixture row 91");
  await expect(current).toHaveAttribute("data-chat-message-key", "row-91");

  await input.fill("Fixture row 92");
  await expect(current).toHaveAttribute("data-chat-message-key", "row-92");

  await input.fill("Fixture row 9");
  await expect(current).toHaveCount(1);
  const first = await current.getAttribute("data-chat-message-key");
  await input.press("Enter");
  await expect(current).not.toHaveAttribute("data-chat-message-key", first!);

  await page.keyboard.press("Escape");
  await expect(current).toHaveCount(0);
});

test("the highlight lands on its row and clears", async ({ page }) => {
  await openTranscript(page);
  const target = page.locator('[data-conversation-target="true"]');
  await expect(target).toHaveCount(0);

  await page.evaluate(() => window.transcriptListFixture!.highlight("row-97"));
  await expect(target).toHaveAttribute("data-chat-message-key", "row-97");
  await page.evaluate(() => window.transcriptListFixture!.highlight("row-96"));
  await expect(target).toHaveAttribute("data-chat-message-key", "row-96");
  await expect(target).toHaveCount(0, { timeout: 6_000 });
});

test("an expanded tool stays expanded and can be collapsed", async ({ page }) => {
  await openTranscript(page);
  // A tool in a row with text is its own display row.
  const tool = row(page, "row-94:text-block:1");
  const output = tool.getByText("Fixture output 94");
  await expect(output).toHaveCount(0);

  await tool.getByRole("button", { name: /Read/ }).first().click();
  await expect(output).toBeVisible();

  await page.evaluate(() => window.transcriptListFixture!.writeUnrelated(5));
  await page.evaluate(() => window.transcriptListFixture!.stream("while it is open"));
  await expect(row(page, "row-99")).toContainText("while it is open");
  await expect(output).toBeVisible();

  await tool.getByRole("button", { name: /Read/ }).first().click();
  await expect(output).toHaveCount(0);
});

test("message actions follow the turn", async ({ page }) => {
  await openTranscript(page);
  const fork = row(page, "row-96").getByRole("button", { name: /Fork Codex session/ });
  await expect(fork).toBeEnabled();

  await page.evaluate(() =>
    window.transcriptListFixture!.setTurn({ phase: "running", startedAt: Date.now() }),
  );
  await expect(fork).toBeDisabled();

  await page.evaluate(() => window.transcriptListFixture!.setTurn({ phase: "idle" }));
  await expect(fork).toBeEnabled();
});

test("the footer follows the turn's status and the cards it is waiting on", async ({ page }) => {
  await openTranscript(page);
  const set = (turn: Parameters<NonNullable<typeof window.transcriptListFixture>["setTurn"]>[0]) =>
    page.evaluate((next) => window.transcriptListFixture!.setTurn(next), turn);

  const thinking = page.getByText("Codex is thinking", { exact: false });

  await set({ phase: "running", startedAt: Date.now() });
  await expect(thinking).toBeVisible();
  await set({ phase: "running", startedAt: Date.now(), activity: { compacting: true } });
  await expect(page.getByText("Compacting conversation…")).toBeVisible();
  await set({ phase: "running", startedAt: Date.now(), activity: { thinkingTokens: 1200 } });
  await expect(page.getByText("~1.2k", { exact: false })).toBeVisible();
  await set({ phase: "cancelling" });
  await expect(page.getByText("Stopping…")).toBeVisible();
  await set({ phase: "recovering" });
  await expect(page.getByText("Reconnecting to Codex…")).toBeVisible();
  await set({ phase: "idle" });
  await expect(page.getByText("Reconnecting to Codex…")).toHaveCount(0);

  await page.evaluate(() => window.transcriptListFixture!.setQuestion("First question?"));
  await expect(page.getByTestId("transcript-cards")).toContainText("First question?");
  await page.evaluate(() => window.transcriptListFixture!.setQuestion("Second question?"));
  await expect(page.getByTestId("transcript-cards")).toContainText("Second question?");
  await page.evaluate(() => window.transcriptListFixture!.setQuestion(null));
  await expect(page.getByTestId("transcript-cards")).toHaveCount(0);
});

test("the header follows a page of earlier messages", async ({ page }) => {
  await openTranscript(page, "?earlier=1");
  const scroller = page.locator("[data-transcript-scroller]");
  await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
  const load = page.getByRole("button", { name: "Load earlier messages" });
  await expect(load).toBeVisible();

  await load.click();
  await expect(page.getByRole("button", { name: "Loading…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Load(ing)? earlier|Loading…/ })).toHaveCount(0);
  await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(row(page, "row-0")).toBeVisible();
});

test("a hidden tab keeps its work and shows it on return", async ({ page }) => {
  await openTranscript(page);
  await page.getByRole("button", { name: "Switch environment" }).click();
  await expect(page.getByText("Another environment")).toBeVisible();

  await page.evaluate(() => {
    window.transcriptListFixture!.stream("written while hidden");
    window.transcriptListFixture!.setTurn({ phase: "cancelling" });
  });

  await page.getByRole("button", { name: "Return to transcript" }).click();
  await expect(row(page, "row-99")).toContainText("written while hidden");
  await expect(page.getByText("Stopping…")).toBeVisible();
  await page.evaluate(() => window.transcriptListFixture!.setTurn({ phase: "idle" }));
  await expectNoNestedUpdates(page);
});

test("a caret move does not render the list", async ({ page }) => {
  await openTranscript(page);
  const composer = page
    .getByTestId("shared-native-compose-bar")
    .locator('[contenteditable="true"], textarea')
    .first();
  await composer.click();
  await page.keyboard.type("the quick brown fox");
  await settle(page);

  for (let move = 0; move < 20; move += 1) {
    await page.keyboard.press(move % 3 === 2 ? "ArrowRight" : "ArrowLeft");
    await page.waitForTimeout(20);
  }
  const box = (await composer.boundingBox())!;
  for (let click = 0; click < 10; click += 1) {
    await page.mouse.click(box.x + 10 + click * 12, box.y + box.height / 2);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(200);

  const [commits] = await page.evaluate(() => window.transcriptListFixture!.commits());
  expect(commits!.nested).toBe(0);
  // The menu state is written on every move and must not commit on every move.
  expect(commits!.update).toBeLessThan(5);
});
