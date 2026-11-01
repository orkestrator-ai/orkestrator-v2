import { expect, test, type Browser } from "@playwright/test";
import { confirmReleaseBranch, openBranchField } from "./agent-launch-branch";

// Chrome's own datalist popup, driven from the keyboard (todo 1171). The popup
// is browser UI, so the default headless shell and a headed window both fail:
// the shell has no autofill popup, and a headed window on a locked or unattended
// macOS desktop never gets focus, so Chrome drops the popup (`kNoFrameHasFocus`).
// The `chromium` channel runs the full bundled build in Chrome's new headless
// mode, which gives the window focus without a desktop. Its default 800x600
// screen leaves no room under the field (`kInsufficientSpace`), hence the larger
// screen.
test.use({
  channel:
    !process.env.ORKESTRATOR_E2E_BROWSER || process.env.ORKESTRATOR_E2E_BROWSER === "chromium"
      ? "chromium"
      : undefined,
  headless: true,
  launchOptions: { args: ["--screen-info={0,0 2000x2000}"] },
});
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Requires Chrome's native datalist and CDP",
);

// Chrome's `SuggestionHidingReason` values seen while diagnosing todo 1171.
const hidingReasons: Record<number, string> = {
  0: "kAcceptSuggestion",
  7: "kRendererEvent",
  11: "kViewDestroyed",
  13: "kInsufficientSpace",
  23: "kNoFrameHasFocus",
};

/** Why Chrome closed its datalist popups so far, for a failure message. */
async function popupHidingReasons(browser: Browser) {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { histogram } = await cdp.send("Browser.getHistogram", {
      name: "Autofill.PopupHidingReason.DataList",
    });
    return histogram.buckets
      .map(({ low, count }) => `${hidingReasons[low] ?? low} x${count}`)
      .join(", ");
  } catch {
    // Chrome has no such histogram until it hides a datalist popup.
    return "none recorded";
  } finally {
    await cdp.detach();
  }
}

test("selects a native branch suggestion with the keyboard and confirms", async ({
  browser,
  page,
}) => {
  const { dialog, branch } = await openBranchField(page);
  await branch.click();
  await branch.press("ControlOrMeta+A");
  await branch.press("Backspace");
  await branch.pressSequentially("rel", { delay: 100 });
  // The browser-owned popup has no DOM locator to await.
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  // Playwright's macOS editing commands target the text editor, and without the
  // native key code Chrome closes the popup (`kViewDestroyed`). Native key codes
  // without those commands let the popup handle navigation. The browser handles
  // each key before the next command is sent.
  for (const [key, windowsVirtualKeyCode, nativeVirtualKeyCode] of [
    ["ArrowDown", 40, 125],
    ["Enter", 13, 36],
  ] as const) {
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode,
        ...(process.platform === "darwin" ? { nativeVirtualKeyCode } : {}),
      });
    }
  }
  await cdp.detach();
  await expect(branch)
    .toHaveValue("release/2.0")
    .catch(async (error: Error) => {
      error.message += `\nChrome hid its datalist popups with: ${await popupHidingReasons(browser)}`;
      throw error;
    });
  await confirmReleaseBranch(page, dialog);
});
