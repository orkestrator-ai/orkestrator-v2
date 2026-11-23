import { expect, test } from "@playwright/test";
import path from "node:path";

test("trusted terminal gestures authorize clipboard writes; replies and replay do not", async ({
  page,
}) => {
  await page.goto("/tmux-compose-focus");
  const root = path.resolve(import.meta.dirname, "..");
  await page.evaluate(async () => {
    const modules = window.__fixtureModules!;
    const { createXtermTerminal } = await modules["lib/terminal-xterm"]();
    const { bindOsc52ClipboardGestures, suppressOsc52Clipboard } =
      await modules["lib/terminal-osc52"]();
    const copies: string[] = [];
    window.orkestrator!.clipboard.writeText = async (text: string) => {
      copies.push(text);
    };
    const host = document.createElement("div");
    host.id = "osc-terminal";
    host.style.cssText = "width: min(600px, 100%); height: 260px; position: relative;";
    document.body.replaceChildren(host);
    const { terminal } = createXtermTerminal({}, undefined, {
      environmentId: "fixture",
      tabId: "copy",
    });
    terminal.open(host);
    bindOsc52ClipboardGestures(terminal, host);
    const output = (prefix = "") =>
      new Promise<void>((resolve) => terminal.write(`${prefix}\x1b]52;c;Y29waWVk\x07`, resolve));
    Object.assign(window, {
      oscTest: {
        copies,
        output,
        replay: async () => {
          const release = suppressOsc52Clipboard(terminal);
          await output("\x1b[5n");
          release();
        },
        terminal,
      },
    });
    await new Promise<void>((resolve) =>
      terminal.write(
        "Clipboard test terminal\r\nSelect text in a fullscreen application to copy.",
        resolve,
      ),
    );
  });
  const state = () =>
    page.evaluate(() => (window as unknown as { oscTest: { copies: string[] } }).oscTest.copies);
  const output = (query: string) =>
    page.evaluate(
      (query) =>
        (
          window as unknown as { oscTest: { output: (query: string) => Promise<void> } }
        ).oscTest.output(query),
      query,
    );
  for (const query of ["\x1b[c", "\x1b[5n", "\x1b[6n"]) await output(query);
  expect(await state()).toEqual([]);
  await page.locator("#osc-terminal").click();
  await output("");
  expect(await state()).toEqual(["copied"]);
  await page.evaluate(() =>
    (window as unknown as { oscTest: { replay: () => Promise<void> } }).oscTest.replay(),
  );
  await output("\x1b[5n");
  expect(await state()).toEqual(["copied"]);
  await page.keyboard.press("Enter");
  await output("");
  expect(await state()).toEqual(["copied", "copied"]);
  await page.screenshot({
    path: path.join(
      root,
      "output/visual-previews",
      `terminal-copy-${test.info().project.name}.png`,
    ),
  });
  await page.evaluate(() => {
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "Other terminal";
    document.body.appendChild(elsewhere);
    elsewhere.focus();
  });
  await output("");
  expect(await state()).toEqual(["copied", "copied"]);
  await page.reload();
});
