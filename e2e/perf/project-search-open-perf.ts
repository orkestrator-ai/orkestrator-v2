/**
 * Sidebar search (⌘K palette) cost at scale (real browser, not part of any suite).
 *
 *   mise exec -- bun e2e/perf/project-search-open-perf.ts \
 *     [--environments 500,2000] [--projects 50] [--opens 20] [--updates 30] \
 *     [--port 1495] [--label change] [--dist output/tmp/project-search-perf-dist]
 *
 * The `e2e/fixture` app is built with `apps/web`'s Vite config (production
 * React) into a temporary directory (or an empty or new `--dist` directory)
 * and served by `vite
 * preview`. Each environment count gets a fresh headless Chromium (Playwright's
 * own build) at `/project-search-scale-perf`
 * (`e2e/fixture/ProjectSearchScalePerfFixture.tsx`): one machine with
 * `--projects` projects, `--environments` environments and eight recent
 * projects. Per count it records:
 *
 *  - closed update: `--updates` environment-list replacements with the palette
 *    closed, each timed from `setState` to the end of React's synchronous
 *    render and commit (`flushSync`);
 *  - first open and warm reopen: `--opens` pairs, each starting with a fresh
 *    fixture load. Each press is timed to the first result row in the DOM
 *    (`rendered`) and to the end of the next animation frame (`frame`);
 *  - open update: the same replacements with the palette open.
 *
 * Output is numbers only. A JSON report is written to
 * output/benchmarks/project-search/<run-id>.json. Other work on the host
 * changes every number here, so a report is a sample of that host at that
 * time, not a reference figure.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { startOwnedPreview } from "./preview-server";
import { stopProcessGroup } from "../process-cleanup";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
/** Longer than the dialog's 200 ms exit motion and the palette's close timers. */
const CLOSE_SETTLE_MS = 400;

interface Options {
  environments: number[];
  projects: number;
  opens: number;
  updates: number;
  port: number;
  label: string;
  dist: string | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    environments: [500, 2000],
    projects: 50,
    opens: 20,
    updates: 30,
    port: 1495,
    label: "change",
    dist: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--environments") options.environments = value().split(",").map(Number);
    else if (arg === "--projects") options.projects = Number(value());
    else if (arg === "--opens") options.opens = Number(value());
    else if (arg === "--updates") options.updates = Number(value());
    else if (arg === "--port") options.port = Number(value());
    else if (arg === "--label") options.label = value();
    else if (arg === "--dist") options.dist = path.resolve(value());
    else throw new Error(`Unknown option ${arg}`);
  }
  const counts = [options.projects, options.opens, options.updates, ...options.environments];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
    throw new Error("--environments, --projects, --opens and --updates expect positive integers");
  }
  return options;
}

interface Distribution {
  samples: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    samples: sorted.length,
    medianMs: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

function build(outDir: string): string {
  const webDir = path.join(repositoryRoot, "apps/web");
  const vite = path.join(webDir, "node_modules/vite/bin/vite.js");
  const existing = lstatSync(outDir, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || readdirSync(outDir).length > 0)) {
    throw new Error(`Fixture output directory must be empty or new: ${outDir}`);
  }
  const result = spawnSync(
    process.execPath,
    [
      vite,
      "build",
      "../../e2e/fixture",
      "--config",
      "vite.config.ts",
      "--outDir",
      outDir,
      "--no-emptyOutDir",
      "--logLevel",
      "warn",
    ],
    { cwd: webDir, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Fixture build failed: ${result.error ?? result.stderr ?? result.stdout}`);
  }
  return vite;
}

async function updates(page: Page, count: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    samples.push(await page.evaluate(() => window.__projectSearchPerf!.update()));
  }
  return samples;
}

/** Presses the search button and times the palette's first rows and next frame. */
async function openOnce(page: Page) {
  const sample = await page.evaluate(
    () =>
      new Promise<{ renderedMs: number; frameMs: number; rows: number }>((resolve) => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-testid="project-search-trigger"]',
        )!;
        const rowSelector = '#project-search-results [role="option"]';
        let renderedAt: number | null = null;
        const observer = new MutationObserver(() => {
          if (renderedAt === null && document.querySelector(rowSelector)) {
            renderedAt = performance.now();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const start = performance.now();
        trigger.click();
        requestAnimationFrame(() =>
          setTimeout(() => {
            observer.disconnect();
            const frameAt = performance.now();
            resolve({
              renderedMs: (renderedAt ?? frameAt) - start,
              frameMs: frameAt - start,
              rows: document.querySelectorAll(rowSelector).length,
            });
          }, 0),
        );
      }),
  );
  if (sample.rows === 0) throw new Error("The palette opened without result rows");
  return sample;
}

async function closeSearch(page: Page) {
  await page.keyboard.press("Escape");
  await page.getByTestId("project-search-dialog").waitFor({ state: "detached" });
  await page.waitForTimeout(CLOSE_SETTLE_MS);
}

async function measure(url: string, options: Options, environments: number) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const fixtureUrl = `${url}/project-search-scale-perf?projects=${options.projects}&environments=${environments}`;
    const firstOpens: Awaited<ReturnType<typeof openOnce>>[] = [];
    const warmReopens: Awaited<ReturnType<typeof openOnce>>[] = [];
    for (let i = 0; i < options.opens; i++) {
      await page.goto(fixtureUrl);
      await page.waitForFunction(() => window.__projectSearchPerf?.ready === true);
      firstOpens.push(await openOnce(page));
      await closeSearch(page);
      warmReopens.push(await openOnce(page));
      await closeSearch(page);
    }

    // Warm the update path before collecting update samples.
    await updates(page, 3);
    const closedUpdate = await updates(page, options.updates);
    await openOnce(page);
    const openUpdate = await updates(page, options.updates);
    await closeSearch(page);
    return {
      environments,
      projects: options.projects,
      rowsShown: firstOpens[0]!.rows,
      closedUpdate: distribution(closedUpdate),
      firstOpenRendered: distribution(firstOpens.map((sample) => sample.renderedMs)),
      firstOpenFrame: distribution(firstOpens.map((sample) => sample.frameMs)),
      warmReopenRendered: distribution(warmReopens.map((sample) => sample.renderedMs)),
      warmReopenFrame: distribution(warmReopens.map((sample) => sample.frameMs)),
      openUpdate: distribution(openUpdate),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const workDir = mkdtempSync(path.join(tmpdir(), "project-search-perf-"));
  const outDir = options.dist ?? path.join(workDir, "dist");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const outputDir = path.join(repositoryRoot, "output/benchmarks/project-search");
  let preview: Awaited<ReturnType<typeof startOwnedPreview>> | undefined;
  try {
    console.log("[project-search] building the fixture");
    const vite = build(outDir);
    preview = await startOwnedPreview({
      command: [
        process.execPath,
        vite,
        "preview",
        "../../e2e/fixture",
        "--config",
        "vite.config.ts",
        "--outDir",
        outDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(options.port),
        "--strictPort",
      ],
      cwd: path.join(repositoryRoot, "apps/web"),
      outDir,
      port: options.port,
    });
    const results = [];
    for (const environments of options.environments) {
      const result = await measure(preview.url, options, environments);
      results.push(result);
      console.log(`[project-search] ${options.label} ${JSON.stringify(result)}`);
    }
    const browserVersion = await chromium.launch({ headless: true }).then(async (browser) => {
      const version = browser.version();
      await browser.close();
      return version;
    });
    const report = {
      runId,
      label: options.label,
      browserVersion,
      environment: { platform: process.platform, arch: process.arch },
      options: { ...options, dist: options.dist ? "explicit" : null },
      results,
    };
    mkdirSync(outputDir, { recursive: true });
    const reportFile = path.join(outputDir, `${runId}.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[project-search] Chromium ${browserVersion}`);
    console.log(`[project-search] report ${path.relative(repositoryRoot, reportFile)}`);
  } finally {
    if (preview) await stopProcessGroup(preview.process);
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
