/**
 * Credential isolation and resource escape, headless, observed from outside
 * the worker. Canaries: a secret in this (backend) process's environment, a
 * file in a fake HOME, and a session cookie set by a local "application"
 * server. A hostile document then tries every egress path we can observe —
 * images, CSS, fonts, scripts, fetch/XHR, WebSocket, beacon, workers,
 * EventSource, iframe, `<object>`, forms, prefetch/preconnect/dns-prefetch,
 * RTCPeerConnection (STUN to a local UDP sink), redirects, a custom scheme,
 * popups — and reads whatever credentials it can reach into a probed element.
 *
 * Every class is first shown to reach the sinks from a deliberately
 * unrestricted Chromium page (the control); the preview, in process and in
 * container isolation, must then reach none of them, and no canary may
 * appear in the worker's output, its captures (byte search), its probe
 * observations or any request a sink saw.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { artifactFrameRuntimeScript } from "@orkestrator/protocol/artifact-frame-channel";
import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import { resolveDesignChromiumPath } from "../design/index.js";
import type { PreviewJobResult } from "./contracts.js";
import { buildInteractiveCsp, escapeInlineScript, inlineScriptHash } from "./interactive-csp.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  PREVIEW_WORKER_USER,
  resolveSeccompProfile,
} from "./runtime.js";

const CHROMIUM = resolveDesignChromiumPath();
const IMAGE = process.env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE ?? DEFAULT_PREVIEW_WORKER_IMAGE;
const imagePresent =
  spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 }).status ===
  0;
if (!CHROMIUM) console.warn("[preview-escape.test] skipped: no Chromium executable");
if (!imagePresent)
  console.warn(
    `[preview-escape.test] container case skipped: Docker or image ${IMAGE} unavailable`,
  );
const browserTest = CHROMIUM ? test : test.skip;
const containerTest = CHROMIUM && imagePresent ? test : test.skip;

const random = () => Math.random().toString(36).slice(2, 12);
const CANARY = {
  env: `canary-env-${random()}`,
  file: `canary-file-${random()}`,
  cookie: `canary-cookie-${random()}`,
};

interface Observed {
  http: string[];
  connections: number;
  udp: number;
  app: Array<{ url: string; cookie: string }>;
}
const observed: Observed = { http: [], connections: 0, udp: 0, app: [] };
const reset = () => {
  observed.http.length = 0;
  observed.connections = 0;
  observed.udp = 0;
  observed.app.length = 0;
};

let sink: Server;
let app: Server;
let udp: Socket;
let sinkOrigin = "";
let appOrigin = "";
let udpPort = 0;
let fakeHome = "";
const saved = { HOME: process.env.HOME, env: process.env.ORK_ESCAPE_CANARY };

beforeAll(async () => {
  // Canaries seeded where a careless worker launch would inherit them.
  fakeHome = mkdtempSync(path.join(tmpdir(), "ork-escape-home-"));
  writeFileSync(path.join(fakeHome, "canary.txt"), CANARY.file);
  process.env.HOME = fakeHome;
  process.env.ORK_ESCAPE_CANARY = CANARY.env;

  sink = createServer((request, response) => {
    observed.http.push(`${request.method} ${request.url} ${request.headers.cookie ?? ""}`);
    if (request.url?.startsWith("/redirect")) {
      response.writeHead(302, { location: `${sinkOrigin}/after-redirect` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    response.end("ok");
  });
  sink.on("connection", () => observed.connections++);
  sink.on("upgrade", (request, socket) => {
    observed.http.push(`UPGRADE ${request.url}`);
    socket.destroy();
  });
  app = createServer((request, response) => {
    observed.app.push({ url: request.url ?? "", cookie: String(request.headers.cookie ?? "") });
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": `ork_session=${CANARY.cookie}; Path=/; SameSite=Lax`,
    });
    response.end("<!doctype html><title>app</title>");
  });
  udp = createSocket("udp4");
  udp.on("message", () => observed.udp++);
  await Promise.all([
    new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve)),
  ]);
  sinkOrigin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  appOrigin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  udpPort = udp.address().port;
});

afterAll(async () => {
  process.env.HOME = saved.HOME;
  if (saved.env === undefined) delete process.env.ORK_ESCAPE_CANARY;
  else process.env.ORK_ESCAPE_CANARY = saved.env;
  rmSync(fakeHome, { recursive: true, force: true });
  await Promise.all([
    new Promise<void>((resolve) => sink.close(() => resolve())),
    new Promise<void>((resolve) => app.close(() => resolve())),
  ]);
  udp.close();
});

const escapeBody = () => `
  <p data-artifact-test="leak" id="leak">none</p>
  <img src="${sinkOrigin}/img">
  <link rel="stylesheet" href="${sinkOrigin}/css">
  <link rel="prefetch" href="${sinkOrigin}/prefetch">
  <link rel="preconnect" href="${sinkOrigin.replace("127.0.0.1", "127.0.0.1")}">
  <link rel="dns-prefetch" href="//canary-dns-prefetch.invalid">
  <style>@font-face{font-family:x;src:url(${sinkOrigin}/font)} body{font-family:x;background:url(${sinkOrigin}/bg)}</style>
  <script src="${sinkOrigin}/script"></script>
  <iframe src="${sinkOrigin}/iframe"></iframe>
  <object data="${sinkOrigin}/object" type="text/html"></object>
  <img src="${appOrigin}/app-img">
  <img src="file://${fakeHome}/canary.txt">
  <iframe name="form-target"></iframe>
  <form id="f" action="${sinkOrigin}/form" method="post" target="form-target"><input name="a" value="b"></form>
  <a id="custom" href="orkestrator-canary://open?x=1">custom</a>`;

const escapeScript = () => `
  const found = [];
  const note = (label, value) => { if (value) found.push(label + "=" + String(value).slice(0, 200)); };
  try { note("cookie", document.cookie); } catch {}
  try { note("localStorage", JSON.stringify(Object.entries(localStorage))); } catch {}
  try { note("parent-cookie", parent.document.cookie); } catch {}
  try { if (window.parent !== window) note("parent-href", parent.location.href); } catch {}
  try { note("opener", window.opener && window.opener.location.href); } catch {}
  try { note("process", typeof process !== "undefined" && JSON.stringify(process.env)); } catch {}
  try { note("bun", typeof Bun !== "undefined" && "bun"); } catch {}
  const publish = () => { const el = document.getElementById("leak"); if (el && found.length) el.textContent = found.join(" | "); };
  publish();
  fetch("file://${fakeHome}/canary.txt").then((r) => r.text()).then((t) => { note("file", t); publish(); }).catch(() => {});
  fetch("${appOrigin}/app-fetch", { credentials: "include" }).then((r) => r.text()).then(() => {}).catch(() => {});
  fetch("${sinkOrigin}/fetch").catch(() => {});
  try { const x = new XMLHttpRequest(); x.open("GET", "${sinkOrigin}/xhr"); x.send(); } catch {}
  try { new WebSocket("${sinkOrigin.replace("http", "ws")}/ws"); } catch {}
  try { navigator.sendBeacon("${sinkOrigin}/beacon", "x"); } catch {}
  try { new Worker("${sinkOrigin}/worker"); } catch {}
  try { new EventSource("${sinkOrigin}/sse"); } catch {}
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udpPort}" }] });
    pc.createDataChannel("x");
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
  } catch {}
  try { document.getElementById("f").submit(); } catch {}
  try { const i = new Image(); i.src = "${sinkOrigin}/img2"; } catch {}
  setTimeout(() => { try { window.open("${sinkOrigin}/popup"); } catch {} }, 40);
  setTimeout(() => { try { document.getElementById("custom").click(); } catch {} }, 50);
  setTimeout(() => { try { location.href = "${sinkOrigin}/redirect"; } catch {} }, 1200);`;

/** Byte search over everything the worker handed back, including PNG captures. */
function leakedCanaries(result: PreviewJobResult): string[] {
  const text = JSON.stringify(result, (key, value) =>
    key === "png" ? Buffer.from(value as Uint8Array).toString("latin1") : value,
  );
  return Object.values(CANARY).filter((canary) => text.includes(canary));
}

function seenCanaries(): string[] {
  const seen = JSON.stringify(observed);
  return Object.values(CANARY).filter((canary) => seen.includes(canary));
}

async function runPreview(runner: TranscriptPreviewRunner): Promise<PreviewJobResult> {
  const runtime = escapeInlineScript(
    artifactFrameRuntimeScript({
      artifactId: "art_escape0002",
      revision: 1,
      nonce: "escapeNonce0002",
    }),
  );
  const script = escapeScript();
  // Built by hand (the preparer would reject most of this) so the runtime
  // boundary itself is exercised: only the two script hashes are authorized.
  const document = `<!doctype html><html><head><script>${runtime}</script></head><body>${escapeBody()}<script>${script}</script><meta http-equiv="refresh" content="0;url=${sinkOrigin}/refresh"></body></html>`;
  const csp = buildInteractiveCsp([inlineScriptHash(runtime), inlineScriptHash(script)], []);
  const result = await runner.run(
    {
      kind: "html-interactive",
      preparedDocument: document,
      contentSecurityPolicy: csp,
      readinessNonce: "escapeNonce0002",
      profile: DEFAULT_PREVIEW_PROFILE,
      probes: [
        { op: "wait-visible", target: "leak" },
        { op: "expect-text", target: "leak", equals: "none" },
      ],
    },
    {
      environmentId: "env-escape",
      conversationKey: `c-${random()}`,
      operationId: `op_escape${random()}`,
    },
    new AbortController().signal,
  );
  // Late egress (timers, ICE gathering) would still have to arrive somewhere.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return result;
}

function probesOf(result: PreviewJobResult) {
  return "probeResults" in result ? (result.probeResults ?? []) : [];
}

function expectContained(result: PreviewJobResult, mode: string) {
  console.warn(
    `[preview-escape.test] ${mode}:`,
    result.ok ? "ok" : `${result.error.code}: ${result.error.message}`,
    JSON.stringify(result.blockedRequests),
    JSON.stringify(probesOf(result)),
  );
  expect(observed.http).toEqual([]);
  expect(observed.connections).toBe(0);
  expect(observed.udp).toBe(0);
  expect(observed.app).toEqual([]);
  expect(leakedCanaries(result)).toEqual([]);
  expect(seenCanaries()).toEqual([]);
  // The probe observed the leak element: nothing readable was found.
  const probe = probesOf(result).find((entry) => entry.op === "expect-text");
  if (probe?.observed !== undefined) expect(probe.observed).toBe("none");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(["policy_denied", "validation_failed", "render_timeout"]).toContain(result.error.code);
    const blocked = Object.values(result.blockedRequests).reduce((sum, value) => sum + value, 0);
    expect(blocked).toBeGreaterThan(0);
  }
}

describe("credential isolation and resource escape", () => {
  browserTest(
    "control: an unrestricted page reaches every sink and carries the cookie canary",
    async () => {
      reset();
      const browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        // The application session: the cookie canary lands in this browser.
        await page.goto(`${appOrigin}/login`);
        await page.setContent(
          `<!doctype html><html><body>${escapeBody()}<script>${escapeScript()}</script></body></html>`,
        );
        await page.waitForTimeout(2_500);
        await context.close();
      } finally {
        await browser.close();
      }
      const reached = (fragment: string) => observed.http.some((hit) => hit.includes(fragment));
      for (const fragment of [
        "/img ",
        "/css",
        "/fetch",
        "/xhr",
        "/beacon",
        "/script",
        "/iframe",
        "/object",
        "/form",
        "/redirect",
      ]) {
        expect(reached(fragment), `control did not reach ${fragment}`).toBe(true);
      }
      expect(observed.connections).toBeGreaterThan(0);
      // STUN binding requests from ICE gathering reached the UDP sink.
      expect(observed.udp).toBeGreaterThan(0);
      // The application server saw a request carrying the session cookie canary.
      expect(observed.app.some((hit) => hit.cookie.includes(CANARY.cookie))).toBe(true);
      expect(seenCanaries()).toContain(CANARY.cookie);
    },
    60_000,
  );

  browserTest(
    "process isolation: no sink is reached and no canary leaves the worker",
    async () => {
      reset();
      const runner = new TranscriptPreviewRunner({
        isolation: "process",
        allowProcessInteractive: true,
      });
      try {
        expectContained(await runPreview(runner), "process");
      } finally {
        await runner.close();
      }
    },
    90_000,
  );

  containerTest(
    "container isolation: no sink is reached and no canary leaves the worker",
    async () => {
      reset();
      // The docker CLI needs the real HOME for its context and socket; the
      // container itself receives no host environment or home either way.
      process.env.HOME = saved.HOME;
      const runner = new TranscriptPreviewRunner({
        isolation: "container",
        container: {
          docker: "docker",
          image: IMAGE,
          seccompProfile: resolveSeccompProfile()!,
          user: PREVIEW_WORKER_USER,
        },
      });
      try {
        expectContained(await runPreview(runner), "container");
      } finally {
        await runner.close();
        process.env.HOME = fakeHome;
      }
    },
    120_000,
  );
});
