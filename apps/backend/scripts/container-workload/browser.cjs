// Chromium under shared-memory pressure: BROWSERS browsers (one per
// Playwright worker) with PAGES contexts each load a heavy synthetic page,
// scroll it and take tall screenshots for ROUNDS rounds. Renderer and
// compositor bitmaps travel through /dev/shm, so this is the workload a small
// shared-memory mount or a tight memory limit breaks first. Prints one JSON
// line: timings, page crashes and errors (counts only, never page contents).
"use strict";
const fs = require("node:fs");
const { chromium } = require("playwright");

const BROWSERS = Number(process.env.BROWSERS || 3);
const PAGES = Number(process.env.PAGES || 2);
const ROUNDS = Number(process.env.ROUNDS || 4);
const PAGE_FILE = "/tmp/w/page.html";

// 2,000 styled rows, four 2048x2048 canvases and an animated, filtered
// header: about 40,000 px tall at a 1920x1080 viewport.
fs.writeFileSync(
  PAGE_FILE,
  `<!doctype html><html><head><style>
  body { margin: 0; font: 14px sans-serif; }
  .row { display: flex; gap: 8px; padding: 8px; box-shadow: 0 2px 6px rgba(0,0,0,.3); border-radius: 6px; margin: 6px; }
  .row:nth-child(odd) { background: linear-gradient(90deg, #fde, #def); }
  .chip { width: 80px; height: 24px; border-radius: 12px; background: hsl(var(--h), 70%, 60%); filter: blur(0.5px); }
  header { height: 400px; background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red); animation: spin 2s linear infinite; filter: saturate(2) blur(2px); }
  @keyframes spin { to { filter: hue-rotate(360deg) blur(2px); } }
  canvas { display: block; width: 100%; }
</style></head><body><header></header><main id="m"></main><script>
  const main = document.getElementById("m");
  for (let c = 0; c < 4; c++) {
    const canvas = document.createElement("canvas");
    canvas.width = 2048; canvas.height = 2048;
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = "hsl(" + ((i * 7 + c * 90) % 360) + ",80%,50%)";
      ctx.beginPath();
      ctx.arc((i * 97) % 2048, (i * 61) % 2048, 10 + (i % 40), 0, Math.PI * 2);
      ctx.fill();
    }
    main.appendChild(canvas);
  }
  for (let i = 0; i < 2000; i++) {
    const row = document.createElement("div");
    row.className = "row";
    for (let j = 0; j < 12; j++) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.style.setProperty("--h", String((i * 13 + j * 29) % 360));
      row.appendChild(chip);
    }
    row.appendChild(document.createTextNode("Row " + i));
    main.appendChild(row);
  }
</script></body></html>`,
);

async function worker(index, totals) {
  const started = performance.now();
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    totals.launchFailures += 1;
    return;
  }
  // A disconnect before we close the browser is a crash.
  let closing = false;
  browser.on("disconnected", () => {
    if (!closing) totals.browserDisconnects += 1;
  });
  totals.launchMs.push(performance.now() - started);
  try {
    await Promise.all(
      Array.from({ length: PAGES }, async (_, pageIndex) => {
        let context;
        try {
          context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
          const page = await context.newPage();
          page.on("crash", () => {
            totals.pageCrashes += 1;
          });
          for (let round = 0; round < ROUNDS; round++) {
            const roundStarted = performance.now();
            try {
              await page.goto(`file://${PAGE_FILE}?b=${index}&p=${pageIndex}&r=${round}`, {
                waitUntil: "load",
                timeout: 120_000,
              });
              await page.evaluate(async () => {
                for (let y = 0; y < document.body.scrollHeight; y += 2000) {
                  window.scrollTo(0, y);
                  await new Promise((resolve) => requestAnimationFrame(resolve));
                }
              });
              await page.screenshot({
                clip: { x: 0, y: 0, width: 1920, height: 12_000 },
                timeout: 120_000,
              });
              totals.roundMs.push(performance.now() - roundStarted);
            } catch {
              totals.roundErrors += 1;
            }
          }
        } catch {
          totals.setupFailures += 1;
        } finally {
          if (context) await context.close().catch(() => undefined);
        }
      }),
    );
  } finally {
    closing = true;
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  const totals = {
    launchMs: [],
    roundMs: [],
    launchFailures: 0,
    setupFailures: 0,
    browserDisconnects: 0,
    pageCrashes: 0,
    roundErrors: 0,
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: BROWSERS }, (_, index) => worker(index, totals)));
  const sorted = [...totals.roundMs].sort((a, b) => a - b);
  const at = (q) => Math.round(sorted[Math.floor(q * (sorted.length - 1))] ?? 0);
  process.stdout.write(
    `${JSON.stringify({
      workload: "browser",
      browsers: BROWSERS,
      pagesPerBrowser: PAGES,
      rounds: ROUNDS,
      wallMs: Math.round(performance.now() - started),
      roundsCompleted: sorted.length,
      roundMedianMs: at(0.5),
      roundP90Ms: at(0.9),
      launchFailures: totals.launchFailures,
      setupFailures: totals.setupFailures,
      browserDisconnects: totals.browserDisconnects,
      pageCrashes: totals.pageCrashes,
      roundErrors: totals.roundErrors,
    })}\n`,
  );
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ workload: "browser", fatal: true })}\n`);
  process.exitCode = 1;
});
