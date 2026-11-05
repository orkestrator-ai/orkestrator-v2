/**
 * First-load cost of the legacy preview route's body rewrite (GW-10), against
 * bodies captured from a real Vite dev server:
 *
 *   mise exec -- bun apps/backend/scripts/preview-rewrite-costs.ts capture \
 *     <name> <vite root> output/efficiency/<name>.json [page.html]
 *   mise exec -- bun apps/backend/scripts/preview-rewrite-costs.ts measure \
 *     output/efficiency/<name>.json [more.json ...] [--runs 15] [--out result.json]
 *
 * `capture` walks the page's imports, dynamic ones included, through a Vite server
 * in middleware mode, which binds no port. A corpus holds source code, so keep it
 * out of the repository (`output/efficiency/` is git-ignored).
 *
 * `measure` times the rewriter and two candidates (a no-match skip and one combined
 * regex), then replays each corpus through the real gateway on an ephemeral
 * 127.0.0.1 port with a temporary data directory and a random token that is never
 * printed, against an application served from memory. It never touches a real data
 * directory, backend or provider. Figures are aggregates only, never content.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { OrkestratorGateway } from "../src/gateway.js";
import { rewriteBrowserPreviewBody } from "../src/gateway-internals.js";

type Body = { url: string; kind: "html" | "js"; body: string };
type Corpus = { name: string; bodies: Body[] };

const BROWSER_CONNECTIONS = 6;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Runs every variant once per round, so host load falls on all of them alike. */
function interleaved<Name extends string>(runs: number, variants: Record<Name, () => void>) {
  const names = Object.keys(variants) as Name[];
  const samples = new Map<Name, number[]>(names.map((name) => [name, []]));
  for (let run = 0; run < runs; run += 1) {
    for (const name of names) {
      const started = performance.now();
      variants[name]();
      samples.get(name)?.push(performance.now() - started);
    }
  }
  return Object.fromEntries(
    names.map((name) => {
      const values = samples.get(name) ?? [];
      return [name, { medianMs: median(values), minMs: Math.min(...values) }];
    }),
  ) as Record<Name, { medianMs: number; minMs: number }>;
}

/** What a no-match skip could test first: everything the JavaScript passes need. */
function jsMayRewrite(body: string, port: string): boolean {
  return body.includes('"/') || body.includes("'/") || body.includes(`:${port}`);
}

/** The exact shapes the JavaScript passes rewrite, stopping at the first one. */
function exactJsProbe(port: string): RegExp {
  return new RegExp(
    `\\b(?:from\\s*|import\\s*\\(\\s*|import\\s+|new\\s+URL\\s*\\(\\s*)["']\\/(?!\\/)|["'\u0060]http:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}`,
  );
}

/** The same four import shapes as one alternation, then the loopback pass. */
function combinedJsRewrite(body: string, prefix: string, port: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const proxied = new RegExp(`^(?:${escaped}(?:/|$)|//)`);
  const rewritePath = (value: string) =>
    proxied.test(value) ? value : `${prefix}${value.startsWith("/") ? value : `/${value}`}`;
  const imports =
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew\s+URL\s*\(\s*)(["'])(\/(?!\/)[^"'\r\n]*)\2/g;
  const loopback = new RegExp(
    `(["'\u0060])http:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(\\/[^"'\u0060\\r\\n]*)?\\1`,
    "g",
  );
  return body
    .replace(imports, (_match, before: string, quote: string, value: string) => {
      return `${before}${quote}${rewritePath(value)}${quote}`;
    })
    .replace(
      loopback,
      (_match, quote: string, pathname = "/") => `${quote}${rewritePath(pathname)}${quote}`,
    );
}

function rewriteFigures(corpus: Corpus, runs: number) {
  const port = "5173";
  const prefix = `/__orkestrator/browser/loopback/${port}`;
  const target = new URL(`http://127.0.0.1:${port}/`);
  const rewrite = (body: Body) => rewriteBrowserPreviewBody(body.body, prefix, target, body.kind);
  const js = corpus.bodies.filter((body) => body.kind === "js");
  const encoded = corpus.bodies.map((body) => Buffer.from(body.body));
  const unchanged = corpus.bodies.filter((body) => rewrite(body) === body.body);
  const probeSkips = js.filter((body) => !jsMayRewrite(body.body, port));
  const exactProbe = exactJsProbe(port);
  const exactSkips = js.filter((body) => !exactProbe.test(body.body));
  const bytes = (bodies: Body[]) =>
    bodies.reduce((total, body) => total + Buffer.byteLength(body.body), 0);
  // A difference here would be the sequential passes acting on each other.
  const combinedDiffers = js.filter(
    (body) => combinedJsRewrite(body.body, prefix, port) !== rewrite(body),
  );

  return {
    bodies: corpus.bodies.length,
    bytes: bytes(corpus.bodies),
    html: corpus.bodies.length - js.length,
    unchangedBodies: unchanged.length,
    unchangedBytes: bytes(unchanged),
    probeSkippableBodies: probeSkips.length,
    probeSkippableBytes: bytes(probeSkips),
    exactProbeSkippableBodies: exactSkips.length,
    exactProbeSkippableBytes: bytes(exactSkips),
    combinedDiffersBodies: combinedDiffers.length,
    timings: interleaved(runs, {
      everyBodyToday: () => {
        for (const body of corpus.bodies) rewrite(body);
      },
      jsToday: () => {
        for (const body of js) rewrite(body);
      },
      jsCombined: () => {
        for (const body of js) combinedJsRewrite(body.body, prefix, port);
      },
      jsSkipIncludesProbe: () => {
        for (const body of js) if (jsMayRewrite(body.body, port)) rewrite(body);
      },
      jsSkipExactProbe: () => {
        for (const body of js) if (exactProbe.test(body.body)) rewrite(body);
      },
      decodeAndEncode: () => {
        for (const buffer of encoded) Buffer.from(buffer.toString("utf8"));
      },
    }),
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Application did not bind");
  return address.port;
}

async function replay(corpus: Corpus, runs: number) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-preview-rewrite-costs-"));
  const rendererRoot = path.join(dataDir, "dist");
  await mkdir(rendererRoot);
  await writeFile(path.join(rendererRoot, "index.html"), "<div></div>");
  const token = randomBytes(24).toString("hex");
  const byUrl = new Map(corpus.bodies.map((body, index) => [body.url, { ...body, index }]));
  const application = createServer((request, response) => {
    const body = byUrl.get(request.url ?? "");
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    const etag = `W/"vite-${body.index}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": body.kind === "html" ? "text/html" : "text/javascript",
      "cache-control": "no-cache",
      etag,
    });
    response.end(body.body);
  });
  const port = await listen(application);
  const gateway = new OrkestratorGateway({
    backend: { invoke: async () => null },
    dataDir,
    rendererRoot,
    bindAddress: "127.0.0.1",
    port: 0,
    env: { ORKESTRATOR_GATEWAY_TOKEN: token },
    allowNonTailscaleBind: true,
    legacyPreviewPortAccess: async () => "allowed" as const,
  });
  const info = await gateway.start();
  if (!info) throw new Error("Gateway did not start");
  const origin = info.url;

  const load = async (held: Map<string, string>) => {
    const urls = corpus.bodies.map((body) => body.url);
    const tally = { ok: 0, notModified: 0, failed: 0, wireBytes: 0 };
    const started = performance.now();
    const worker = async () => {
      for (let url = urls.shift(); url !== undefined; url = urls.shift()) {
        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
          origin: "null",
          "accept-encoding": "gzip",
        };
        const etag = held.get(url);
        if (etag) headers["if-none-match"] = etag;
        const response = await fetch(
          new URL(`/__orkestrator/browser/loopback/${port}${url}`, origin),
          {
            headers,
            // The wire size, without fetch decoding it first.
            decompress: false,
          } as RequestInit,
        );
        const received = await response.arrayBuffer();
        tally.wireBytes += received.byteLength;
        if (response.status === 200) tally.ok += 1;
        else if (response.status === 304) tally.notModified += 1;
        else tally.failed += 1;
        const tag = response.headers.get("etag");
        if (tag) held.set(url, tag);
      }
    };
    await Promise.all(Array.from({ length: BROWSER_CONNECTIONS }, worker));
    return { ...tally, wallMs: performance.now() - started };
  };

  try {
    const first: Array<Awaited<ReturnType<typeof load>>> = [];
    const again: Array<Awaited<ReturnType<typeof load>>> = [];
    for (let run = 0; run < runs; run += 1) {
      const held = new Map<string, string>();
      first.push(await load(held));
      again.push(await load(held));
    }
    const summary = (loads: typeof first) => ({
      medianMs: median(loads.map((one) => one.wallMs)),
      minMs: Math.min(...loads.map((one) => one.wallMs)),
      ok: loads[0]?.ok,
      notModified: loads[0]?.notModified,
      failed: loads[0]?.failed,
      wireBytes: loads[0]?.wireBytes,
    });
    return { firstLoad: summary(first), repeatLoad: summary(again) };
  } finally {
    await gateway.stop();
    await new Promise((resolve) => application.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function capture(name: string, root: string, out: string, page = "index.html") {
  const viteEntry = path.resolve(
    import.meta.dirname,
    "../../web/node_modules/vite/dist/node/index.js",
  );
  const { createServer: createViteServer } = await import(viteEntry);
  const started = performance.now();
  const vite = await createViteServer({
    root,
    cacheDir: `${out}.vite-cache`,
    logLevel: "warn",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  const html: string = await vite.transformIndexHtml(
    `/${page}`,
    await readFile(path.join(root, page), "utf8"),
  );
  const bodies: Body[] = [{ url: `/${page}`, kind: "html", body: html }];
  const queue = new Set<string>();
  const enqueue = (code: string, pattern: RegExp) => {
    for (const match of code.matchAll(pattern)) if (match[1]) queue.add(match[1]);
  };
  enqueue(html, /<script[^>]*\bsrc="([^"]+)"/g);
  enqueue(html, /from "(\/[^"]+)"/g);
  const seen = new Set<string>();
  for (const url of queue) {
    if (seen.has(url)) continue;
    seen.add(url);
    const result = await vite.transformRequest(url).catch(() => null);
    if (!result) continue;
    bodies.push({ url, kind: "js", body: result.code });
    enqueue(result.code, /\b(?:from\s*|import\s*\(?\s*)["'](\/[^"'\r\n]+)["']/g);
  }
  const viteWallMs = performance.now() - started;
  await vite.close();
  await writeFile(out, JSON.stringify({ name, viteWallMs, bodies }));
  console.log(JSON.stringify({ name, bodies: bodies.length, viteWallMs }));
}

async function measure(args: string[]) {
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args.splice(index, 2)[1] : undefined;
  };
  const runs = Number(flag("--runs") ?? 15);
  const out = flag("--out");
  const results: Record<string, unknown> = {};
  for (const file of args) {
    const corpus = JSON.parse(await readFile(file, "utf8")) as Corpus;
    results[corpus.name] = {
      rewrite: rewriteFigures(corpus, runs),
      replay: await replay(corpus, Math.min(runs, 7)),
    };
  }
  const text = JSON.stringify(
    { loadAverage: os.loadavg(), bun: Bun.version, runs, results },
    null,
    2,
  );
  if (out) await writeFile(out, text);
  console.log(text);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "capture" && rest[0] && rest[1] && rest[2]) {
  await capture(rest[0], rest[1], rest[2], rest[3]);
} else if (mode === "measure") {
  await measure(rest);
} else {
  throw new Error("Usage: preview-rewrite-costs.ts capture|measure ...; see the header comment");
}
process.exit(0);
