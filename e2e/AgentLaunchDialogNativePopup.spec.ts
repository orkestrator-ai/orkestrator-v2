import { expect, test } from "@playwright/test";
import { confirmReleaseBranch, openBranchField } from "./agent-launch-branch";

// Opt-in: Chrome only creates its datalist popup while its window can be the
// active one. In a locked or unattended macOS session it never appears, even for
// a bare <input list>, so the keys below reach the page instead (todo 1171).
const nativePopups = process.env.ORKESTRATOR_E2E_NATIVE_POPUPS === "1";

// Use the full Chrome browser: bundled Chromium does not expose the native
// datalist popup through automation on macOS. Install with `bunx playwright install chrome`.
// Do not pass a Chrome channel to an alternate engine, even for skipped tests.
test.use({
  channel:
    nativePopups &&
    (!process.env.ORKESTRATOR_E2E_BROWSER || process.env.ORKESTRATOR_E2E_BROWSER === "chromium")
      ? "chrome"
      : undefined,
  headless: !nativePopups,
});
test.skip(
  !nativePopups,
  "Needs an unlocked desktop where Chrome can be the active app; set ORKESTRATOR_E2E_NATIVE_POPUPS=1",
);
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Requires Chrome's native datalist and CDP",
);

test("selects a native branch suggestion with the keyboard and confirms", async ({ page }) => {
  const { dialog, branch } = await openBranchField(page);
  await branch.click();
  await branch.press("ControlOrMeta+A");
  await branch.press("Backspace");
  await branch.pressSequentially("rel", { delay: 100 });
  // The browser-owned popup has no DOM locator to await.
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  // Playwright's macOS editing commands target the text editor. Native key codes
  // without those commands let Chrome's own datalist popup handle navigation.
  for (const [key, windowsVirtualKeyCode, nativeVirtualKeyCode] of [
    ["ArrowDown", 40, 125],
    ["Enter", 13, 36],
  ] as const) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code: key,
      windowsVirtualKeyCode,
      ...(process.platform === "darwin" ? { nativeVirtualKeyCode } : {}),
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
      windowsVirtualKeyCode,
      ...(process.platform === "darwin" ? { nativeVirtualKeyCode } : {}),
    });
    await page.waitForTimeout(500);
  }
  await cdp.detach();
  await expect(branch).toHaveValue("release/2.0");
  await confirmReleaseBranch(page, dialog);
});
