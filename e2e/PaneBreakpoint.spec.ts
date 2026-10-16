import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A window can cross the 768px breakpoint at any time: narrowed, rotated, or
 * put into split screen. These cases cross it both ways with live pane state and
 * check that nothing remounts or forgets where it was.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1024, height: 900 };

const TERMINAL_ROWS = 200;
const TERMINAL_TOP_LINE = 50;

function panes(page: Page) {
  const terminalPane = page.locator("[data-pane-leaf]").filter({ has: page.locator(".xterm") });
  const agentPane = page
    .locator("[data-pane-leaf]")
    .filter({ has: page.getByRole("textbox", { name: "Message Codex" }) });
  return {
    terminalPane,
    agentPane,
    terminal: terminalPane.locator(".xterm"),
    terminalRows: terminalPane.locator(".xterm-rows"),
    transcript: agentPane.getByTestId("virtuoso-scroller"),
    composer: agentPane.getByRole("textbox", { name: "Message Codex" }),
  };
}

async function firstVisibleMessage(transcript: Locator): Promise<string | null> {
  return transcript.evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    for (const element of Array.from(scroller.querySelectorAll("[data-item-index]"))) {
      if (element.getBoundingClientRect().bottom > top + 1) {
        return element.textContent?.match(/Transcript message \d+\./)?.[0] ?? null;
      }
    }
    return null;
  });
}

/**
 * Scrolls the transcript away from its end the way a user does, and returns the
 * message it settles on at the top. A transcript that remounted or lost its
 * offset would show its first or its last messages instead.
 */
async function scrollTranscriptUp(page: Page, transcript: Locator): Promise<string> {
  // Opening a transcript follows it to the end; scroll only once it got there.
  await expect(transcript.getByText("Transcript message 59.")).toBeVisible();
  const box = await transcript.boundingBox();
  if (!box) throw new Error("Expected the transcript on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const scrolledBack = /^Transcript message ([1-9]|[1-4]\d)\.$/;
  let settled: string | null = null;
  // Under load a wheel can land late, after a retry already wheeled again, and
  // overshoot to the first message; wheel back down then rather than failing.
  await expect(async () => {
    const before = await firstVisibleMessage(transcript);
    if (!before?.match(scrolledBack)) {
      await page.mouse.wheel(0, before === "Transcript message 0." ? 600 : -1500);
    }
    // Settled: the same message on top across two reads a moment apart.
    const current = await firstVisibleMessage(transcript);
    await page.waitForTimeout(250);
    settled = await firstVisibleMessage(transcript);
    expect(settled).toBe(current);
    expect(settled).toMatch(scrolledBack);
  }).toPass();
  return settled!;
}

/** The same element as before, so React kept the component that owns it. */
async function remember(locator: Locator, name: string) {
  await locator.evaluate((element, key) => {
    (window as unknown as Record<string, Element>)[key] = element;
  }, name);
}

async function isSameElement(locator: Locator, name: string): Promise<boolean> {
  return locator.evaluate(
    (element, key) => (window as unknown as Record<string, Element>)[key] === element,
    name,
  );
}

/**
 * The pane tree alone, and inside the real `AppShell`, which moves its own
 * content host between layouts at the same breakpoint the pane tree moves its
 * pane hosts at.
 */
const SHELLS = [
  { name: "pane tree", path: "/pane-breakpoint" },
  { name: "in the app shell", path: "/pane-breakpoint?shell=app" },
] as const;

for (const shell of SHELLS)
  for (const mode of ["moveBefore", "appendChild fallback"] as const) {
    test(`split panes keep terminal output, scroll positions and the draft across the breakpoint (${shell.name}, ${mode})`, async ({
      page,
    }, testInfo) => {
      if (mode === "appendChild fallback") {
        // Safari and older engines have no state-preserving move.
        await page.addInitScript(() => {
          delete (Element.prototype as { moveBefore?: unknown }).moveBefore;
        });
      }
      // Each project starts on its own side of the breakpoint and crosses both ways.
      const startsOnPhone = testInfo.project.name === "mobile-chromium";
      const [start, other] = startsOnPhone ? [PHONE, DESKTOP] : [DESKTOP, PHONE];
      await page.setViewportSize(start);
      await page.goto(shell.path);
      const view = panes(page);
      if (shell.path !== "/pane-breakpoint" && start === PHONE) {
        // A phone-sized first load opens the projects drawer over the workspace.
        const drawer = page.getByRole("dialog", { name: "Projects and environments" });
        await expect(drawer).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(drawer).toHaveCount(0);
      }

      await expect(view.terminal).toHaveCount(1);
      await page.evaluate(
        (count) =>
          window.writeBreakpointTerminal!(
            Array.from({ length: count }, (_, index) => `Breakpoint row ${index}\r\n`).join(""),
          ),
        TERMINAL_ROWS,
      );
      await page.evaluate((line) => window.scrollBreakpointTerminal!(line), TERMINAL_TOP_LINE);
      const transcriptTop = await scrollTranscriptUp(page, view.transcript);
      await view.composer.click();
      await page.keyboard.type("keep this draft");
      await remember(view.terminalPane, "terminalPane");
      await remember(view.agentPane, "agentPane");
      await remember(view.terminal, "terminal");

      const expectAgentPaneKept = async (typed: string) => {
        expect(await isSameElement(view.agentPane, "agentPane")).toBe(true);
        await expect(view.composer).toHaveText(typed);
        expect(await firstVisibleMessage(view.transcript)).toBe(transcriptTop);
      };
      // xterm re-anchors its viewport by a few lines on every resize, crossing or
      // not, so the terminal is checked for still being scrolled back into its
      // history and showing it, rather than for one exact line.
      const expectTerminalPaneKept = async () => {
        expect(await isSameElement(view.terminalPane, "terminalPane")).toBe(true);
        expect(await isSameElement(view.terminal, "terminal")).toBe(true);
        // A pane that was hidden renders its rows on the frame after it shows.
        await expect(async () => {
          const terminal = (await page.evaluate(() => window.breakpointTerminalState!()))!;
          expect(terminal.firstLine).toBe("Breakpoint row 0");
          expect(terminal.lastLine).toBe(`Breakpoint row ${TERMINAL_ROWS - 1}`);
          expect(terminal.viewportY).toBeGreaterThan(0);
          expect(terminal.viewportY).toBeLessThan(terminal.baseY);
          expect(await view.terminalRows.locator(":scope > div").first().textContent()).toBe(
            `Breakpoint row ${terminal.viewportY}`,
          );
        }).toPass();
      };

      // Cross once. The composer still has focus and its caret: typing continues the draft.
      await page.setViewportSize(other);
      await expect(view.composer).toBeFocused();
      await page.keyboard.type(" and more");
      await expectAgentPaneKept("keep this draft and more");
      await expect(page.getByRole("tablist", { name: "Split panes" })).toHaveCount(
        other === PHONE ? 1 : 0,
      );
      if (other === DESKTOP) await expectTerminalPaneKept();

      // And back. The phone shows one pane at a time, so the shell pane is checked last.
      await page.setViewportSize(start);
      await expect(view.composer).toBeFocused();
      await page.keyboard.type("!");
      await expectAgentPaneKept("keep this draft and more!");
      if (start === PHONE) await page.getByRole("tab", { name: /Shell/ }).click();
      await expectTerminalPaneKept();
    });
  }

test("switching panes on a phone keeps each pane's scroll position and the terminal's size", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "the pane switcher is phone-only");
  await page.goto("/pane-breakpoint");
  const transcript = page.locator('[data-pane-host="agent-pane"]').getByTestId("virtuoso-scroller");
  const terminalRows = page.locator('[data-pane-host="terminal-pane"] .xterm-rows');
  const terminalState = async () => (await page.evaluate(() => window.breakpointTerminalState!()))!;
  const selectPane = (name: RegExp) => page.getByRole("tab", { name }).click();

  // The shell pane starts hidden behind the Codex pane, yet its terminal is
  // already fitted to the pane: hidden panes stay laid out at full size.
  await expect(page.locator('[data-pane-host="terminal-pane"] .xterm')).toHaveCount(1);
  // Fitted to the phone-width pane, not left at xterm's default 80 columns.
  await expect.poll(async () => (await terminalState()).cols).toBeLessThan(80);
  const hiddenSize = await terminalState();
  expect(hiddenSize.cols).toBeGreaterThan(30);
  await page.evaluate(
    (count) =>
      window.writeBreakpointTerminal!(
        Array.from({ length: count }, (_, index) => `Breakpoint row ${index}\r\n`).join(""),
      ),
    TERMINAL_ROWS,
  );
  await page.evaluate((line) => window.scrollBreakpointTerminal!(line), TERMINAL_TOP_LINE);
  const transcriptTop = await scrollTranscriptUp(page, transcript);

  for (let round = 0; round < 2; round += 1) {
    await selectPane(/Shell/);
    await expect(page.getByRole("tab", { name: /Shell/ })).toHaveAttribute("aria-selected", "true");
    await expect(async () => {
      const shown = await terminalState();
      expect([shown.cols, shown.rows]).toEqual([hiddenSize.cols, hiddenSize.rows]);
      expect(shown.viewportY).toBe(TERMINAL_TOP_LINE);
      expect(await terminalRows.locator(":scope > div").first().textContent()).toBe(
        `Breakpoint row ${TERMINAL_TOP_LINE}`,
      );
    }).toPass();

    await selectPane(/Codex/);
    await expect.poll(() => firstVisibleMessage(transcript)).toBe(transcriptTop);
    // Hidden again, the terminal keeps the size it has on screen.
    const hidden = await terminalState();
    expect([hidden.cols, hidden.rows, hidden.viewportY]).toEqual([
      hiddenSize.cols,
      hiddenSize.rows,
      TERMINAL_TOP_LINE,
    ]);
  }
});
