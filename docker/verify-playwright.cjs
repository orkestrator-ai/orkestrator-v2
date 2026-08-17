// Build-time (and on-demand) proof that the baked-in Chromium actually starts.
//
// A missing shared library is the usual way `playwright install` "succeeds" and
// then fails on first use, so the image build runs this rather than trusting the
// installer's exit status. It launches with default options — no explicit
// `chromiumSandbox`, no extra args — because that is how an agent will launch
// it, and because Playwright's default `chromiumSandbox: false` is exactly what
// makes Chromium work as uid 0 and inside a container with no CAP_SYS_ADMIN.
//
// Left in the image on purpose: "does Playwright work in this container?" is a
// question worth being able to answer without reconstructing this script.
//   NODE_PATH=/usr/local/share/npm-global/lib/node_modules node \
//     /usr/local/share/verify-playwright.cjs
const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<h1>playwright-ok</h1>");
    const text = await page.textContent("h1");
    if (text !== "playwright-ok") {
      throw new Error(`unexpected page content: ${JSON.stringify(text)}`);
    }
  } finally {
    await browser.close();
  }
  const { uid } = require("node:os").userInfo();
  console.log(`chromium launch verified (uid ${uid})`);
}

// An unhandled rejection would already fail the build, but exiting explicitly
// keeps the reason on one line instead of a bare stack trace.
main().catch((error) => {
  console.error(`chromium launch FAILED: ${error?.stack ?? error}`);
  process.exit(1);
});
