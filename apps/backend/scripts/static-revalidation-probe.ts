/**
 * Which validators do real browser engines send when they revalidate a static
 * file the gateway served (to-do 6160, retired; the results are in
 * docs/architecture/remote-gateway.md)? The gateway answers a date-only
 * revalidation (`If-Modified-Since` with no `If-None-Match`) only after running
 * the on-the-fly compression, so the question is whether any client we ship
 * takes that path.
 *
 *   mise exec -- bun apps/backend/scripts/static-revalidation-probe.ts \
 *     [--engines chromium,webkit,firefox] [--out result.json]
 *
 * Starts the real gateway in this process on an ephemeral 127.0.0.1 port with a
 * temporary renderer root (an `index.html` and a script and stylesheet with no
 * precompressed sibling, which is the path in question) and a random token that
 * is never printed. A recording proxy in front of it adds the token and notes,
 * per request, the path, status, content coding and whether each validator was
 * present. Each engine loads the page, reloads it, navigates back to it and
 * fetches the script with the default and `no-cache` modes.
 *
 * An engine that cannot launch on this host is reported as `unavailable`, with
 * the launcher's first line, rather than failing the run. It never touches a
 * real data directory, backend or provider. JSON goes to stdout (or `--out`).
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium, firefox, webkit, type BrowserType } from "playwright-core";

import { OrkestratorGateway } from "../src/gateway.js";

const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox };
const PROBED_PATHS = new Set(["/", "/app.js", "/style.css"]);

export type ProbeRequest = {
  step: string;
  path: string;
  status: number;
  ifNoneMatch: boolean;
  ifModifiedSince: boolean;
  contentEncoding: string;
};

export type EngineResult =
  | { engine: string; status: "unavailable"; reason: string }
  | {
      engine: string;
      status: "observed";
      version: string;
      requests: ProbeRequest[];
      revalidations: number;
      dateOnlyRevalidations: number;
    };

/** Counts a run's revalidations and the ones that carried a date but no tag. */
export function summarizeRequests(requests: ProbeRequest[]) {
  const revalidating = requests.filter((entry) => entry.ifNoneMatch || entry.ifModifiedSince);
  return {
    revalidations: revalidating.length,
    dateOnlyRevalidations: revalidating.filter((entry) => !entry.ifNoneMatch).length,
  };
}

async function writeRendererRoot(dataDir: string): Promise<string> {
  const rendererRoot = path.join(dataDir, "dist");
  await mkdir(rendererRoot, { recursive: true });
  await writeFile(
    path.join(rendererRoot, "index.html"),
    '<!doctype html><html><head><script src="/app.js"></script>' +
      '<link rel="stylesheet" href="/style.css"></head><body>probe</body></html>',
  );
  // Compressible, under the fallback cap, and with no `.br`/`.gz` sibling.
  await writeFile(path.join(rendererRoot, "app.js"), "console.log('probe');\n".repeat(2_000));
  await writeFile(path.join(rendererRoot, "style.css"), "body { color: black; }\n".repeat(2_000));
  return rendererRoot;
}

function startRecorder(upstream: URL, token: string, record: (entry: ProbeRequest) => void) {
  let step = "";
  const server: Server = createServer((request, response) => {
    const forward = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: upstream.host, authorization: `Bearer ${token}` },
      },
      (upstreamResponse) => {
        const requestPath = request.url ?? "";
        if (PROBED_PATHS.has(requestPath)) {
          record({
            step,
            path: requestPath,
            status: upstreamResponse.statusCode ?? 0,
            ifNoneMatch: request.headers["if-none-match"] !== undefined,
            ifModifiedSince: request.headers["if-modified-since"] !== undefined,
            contentEncoding: String(upstreamResponse.headers["content-encoding"] ?? "identity"),
          });
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    forward.on("error", () => response.destroy());
    request.pipe(forward);
  });
  return {
    server,
    setStep: (next: string) => {
      step = next;
    },
  };
}

async function probeEngine(
  name: string,
  type: BrowserType,
  base: string,
  recorder: ReturnType<typeof startRecorder>,
  requests: ProbeRequest[],
): Promise<EngineResult> {
  let browser;
  try {
    browser = await type.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      message
        .split("\n")
        .map((line) => line.replace(/[║╔╗╚╝═]/g, "").trim())
        .find((line) => line.length > 0 && !line.startsWith("_wrapApiCall")) ?? "launch failed";
    return { engine: name, status: "unavailable", reason };
  }
  const start = requests.length;
  try {
    const page = await (await browser.newContext()).newPage();
    recorder.setStep("first-load");
    await page.goto(base, { waitUntil: "load" });
    recorder.setStep("reload");
    await page.reload({ waitUntil: "load" });
    recorder.setStep("navigate-again");
    await page.goto("about:blank");
    await page.goto(base, { waitUntil: "load" });
    recorder.setStep("fetch-default");
    await page.evaluate(async () => {
      await (await fetch("/app.js")).text();
    });
    recorder.setStep("fetch-no-cache");
    await page.evaluate(async () => {
      await (await fetch("/app.js", { cache: "no-cache" })).text();
    });
    const observed = requests.slice(start);
    return {
      engine: name,
      status: "observed",
      version: browser.version(),
      requests: observed,
      ...summarizeRequests(observed),
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      engines: { type: "string", default: "chromium,webkit,firefox" },
      out: { type: "string" },
    },
  });
  const names = String(values.engines)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!ENGINES[name]) throw new Error(`Unknown engine: ${name}`);
  }

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-static-revalidation-probe-"));
  const token = randomBytes(24).toString("hex");
  let gateway: OrkestratorGateway | null = null;
  let recorderServer: Server | null = null;
  try {
    gateway = new OrkestratorGateway({
      backend: { invoke: async () => null },
      dataDir,
      rendererRoot: await writeRendererRoot(dataDir),
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: token },
      allowNonTailscaleBind: true,
      compression: "body",
    });
    const info = await gateway.start();
    if (!info) throw new Error("Gateway did not start");

    const requests: ProbeRequest[] = [];
    const recorder = startRecorder(new URL(info.url), token, (entry) => requests.push(entry));
    recorderServer = recorder.server;
    await new Promise<void>((resolve) => recorder.server.listen(0, "127.0.0.1", resolve));
    const address = recorder.server.address();
    if (!address || typeof address === "string") throw new Error("Recorder has no address");
    const base = `http://127.0.0.1:${address.port}/`;

    const results: EngineResult[] = [];
    for (const name of names) {
      results.push(await probeEngine(name, ENGINES[name]!, base, recorder, requests));
    }
    const output = JSON.stringify(
      { measuredAt: new Date().toISOString(), platform: process.platform, results },
      null,
      2,
    );
    if (values.out) await writeFile(values.out, `${output}\n`);
    else console.log(output);
  } finally {
    if (recorderServer) {
      await new Promise<void>((resolve) => recorderServer!.close(() => resolve()));
    }
    await gateway?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
