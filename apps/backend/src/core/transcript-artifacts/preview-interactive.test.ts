/**
 * Real-Chromium qualification of the interactive and static preview paths.
 * Skipped (with the reason printed) when no Chromium executable is found.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { freemem, loadavg, tmpdir, totalmem } from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import type { ArtifactProbeV1 } from "@orkestrator/protocol/transcript-artifacts";
import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import { resolveDesignChromiumPath } from "../design/index.js";
import type { PreviewJob, PreviewJobResult } from "./contracts.js";
import { artifactFrameRuntimeScript } from "@orkestrator/protocol/artifact-frame-channel";
import { buildInteractiveCsp, escapeInlineScript, inlineScriptHash } from "./interactive-csp.js";
import { TranscriptInteractivePreparer } from "./interactive-prepare.js";
import { isAlive, listProcesses } from "./preview-process-tree.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import { previewTestScratchRoot } from "./fixtures/preview-scratch-root.js";

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM)
  console.warn(
    "[preview-interactive.test] skipped: no Chromium executable (set ORKESTRATOR_DESIGN_CHROMIUM_PATH)",
  );
const browserTest = CHROMIUM ? test : test.skip;

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");
const preparer = new TranscriptInteractivePreparer({ frameAncestors: ["http://127.0.0.1:*"] });
const CALCULATOR_PROBES: ArtifactProbeV1[] = [
  { op: "wait-visible", target: "total" },
  { op: "expect-number", target: "total", equals: 60 },
  { op: "set-number", target: "tasks", value: 8 },
  { op: "expect-number", target: "total", equals: 96 },
  { op: "set-number", target: "minutes", value: 0 },
  { op: "expect-number", target: "total", equals: 0 },
];

type Exit = {
  operationId: string;
  verified: boolean;
  browserPid: number | null;
  workerPid: number | null;
};
const exits: Exit[] = [];
let runner: TranscriptPreviewRunner;
let operation = 0;
const scope = () => ({
  environmentId: `env-${++operation}`,
  conversationKey: "conv",
  operationId: `op_interactive${String(operation).padStart(6, "0")}`,
});

beforeAll(() => {
  // Process-mode qualification of the executable path; production requires
  // the explicit opt-in (container isolation is the default for this kind).
  runner = new TranscriptPreviewRunner({
    isolation: "process",
    scratchRoot: previewTestScratchRoot(),
    allowProcessInteractive: true,
    onWorkerExit: (report) => exits.push(report),
  });
});
afterAll(async () => {
  await runner?.close();
});

async function interactiveJob(
  html: string,
  probes: ArtifactProbeV1[],
  dependencyIds: string[] = [],
): Promise<PreviewJob> {
  const prepared = await preparer.prepare({
    artifactId: "art_interactive01",
    revision: 1,
    html,
    dependencyIds,
    assets: [],
  });
  if (!prepared.ok) throw new Error(`preparation failed: ${JSON.stringify(prepared.diagnostics)}`);
  return {
    kind: "html-interactive",
    preparedDocument: prepared.prepared.document,
    contentSecurityPolicy: prepared.prepared.contentSecurityPolicy,
    readinessNonce: prepared.prepared.readinessNonce,
    identity: { artifactId: "art_interactive01", revision: 1 },
    profile: DEFAULT_PREVIEW_PROFILE,
    probes,
  };
}

function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

async function waitForIdle(target: TranscriptPreviewRunner) {
  const deadline = Date.now() + 10_000;
  while (target.stats().running > 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("interactive preview in Chromium", () => {
  browserTest(
    "calculator passes its declared probes and captures initial and final PNGs",
    async () => {
      const result = await runner.run(
        await interactiveJob(fixture("calculator.html"), CALCULATOR_PROBES),
        scope(),
        new AbortController().signal,
      );
      if (!result.ok)
        console.error(
          JSON.stringify(result, (key, value) => (key === "png" ? "<png>" : value)).slice(0, 2_000),
        );
      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "html-interactive") return;
      expect(result.probeResults.map((probe) => probe.status)).toEqual(
        CALCULATOR_PROBES.map(() => "passed"),
      );
      expect(result.probeResults[1]!.observed).toBe(60);
      expect(result.probeResults[3]!.observed).toBe(96);
      expect(result.probeResults[5]!.observed).toBe(0);
      expect(result.captures.map((capture) => capture.label)).toEqual(["initial", "final"]);
      for (const capture of result.captures) {
        expect(isPng(capture.png)).toBe(true);
        expect(capture.width).toBe(960);
        expect(capture.height).toBe(640);
      }
      expect(result.runtimeErrors).toBe(0);
      expect(result.blockedRequests).toEqual({});
      expect(result.browserBuild).toMatch(/^chromium\//);
      expect(result.elementCount).toBeGreaterThan(5);
    },
    60_000,
  );

  browserTest(
    "the deliberate 80-instead-of-96 bug fails its probe with an exact path and a diagnostic capture",
    async () => {
      const result = await runner.run(
        await interactiveJob(fixture("calculator-bug.html"), CALCULATOR_PROBES),
        scope(),
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("validation_failed");
      expect(result.probeResults?.map((probe) => probe.status)).toEqual([
        "passed",
        "passed",
        "passed",
        "failed",
        "skipped",
        "skipped",
      ]);
      expect(result.probeResults?.[3]).toMatchObject({
        index: 3,
        op: "expect-number",
        target: "total",
        status: "failed",
        observed: 80,
        errorCode: "expectation_failed",
      });
      const diagnostic = result.diagnostics.find(
        (entry) => entry.code === "probe_expectation_failed",
      );
      expect(diagnostic).toMatchObject({ location: "probes[3]" });
      expect(diagnostic!.message).toBe(
        'Probe 3 (expect-number on "total"): Expected 96, observed 80',
      );
      expect(result.captures.map((capture) => capture.label)).toEqual(["initial", "diagnostic"]);
      expect(result.captures.every((capture) => isPng(capture.png))).toBe(true);
    },
    60_000,
  );

  browserTest(
    "a fixture using the pinned d3 dependency works offline",
    async () => {
      const probes: ArtifactProbeV1[] = [
        { op: "expect-number", target: "bar-count", equals: 5 },
        { op: "expect-number", target: "max-value", equals: 9 },
        { op: "click", target: "add-day" },
        { op: "expect-number", target: "bar-count", equals: 6 },
        { op: "expect-text", target: "max-value", equals: "12" },
      ];
      const result = await runner.run(
        await interactiveJob(fixture("d3-bars.html"), probes, ["d3@7.9.0"]),
        scope(),
        new AbortController().signal,
      );
      if (!result.ok)
        console.error(
          JSON.stringify(result, (key, value) => (key === "png" ? "<png>" : value)).slice(0, 2_000),
        );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.blockedRequests).toEqual({});
    },
    60_000,
  );

  browserTest(
    "the static path strips authored scripts, reports counts and captures",
    async () => {
      const html =
        '<!doctype html><html><body><h1 id="t">Static</h1><script>document.getElementById("t").textContent = "ran"</script><button onclick="alert(1)">b</button><a href="javascript:alert(1)">x</a><iframe src="https://example.com"></iframe></body></html>';
      const result = await runner.run(
        { kind: "html-static", html, profile: DEFAULT_PREVIEW_PROFILE },
        scope(),
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "html-static") return;
      expect(result.sanitizer).toMatchObject({
        scripts: 1,
        handlers: 1,
        executableUrls: 1,
        forbiddenElements: 1,
      });
      expect(result.effectiveHtml).toContain("Static");
      expect(result.effectiveHtml).not.toContain("<script");
      expect(result.effectiveHtml).not.toContain("onclick");
      expect(result.captures).toHaveLength(1);
      expect(isPng(result.captures[0]!.png)).toBe(true);
    },
    60_000,
  );

  browserTest(
    "infinite loops before and after ready are killed, the browser is gone and capacity recovers",
    async () => {
      const local: Exit[] = [];
      const target = new TranscriptPreviewRunner({
        isolation: "process",
        scratchRoot: previewTestScratchRoot(),
        allowProcessInteractive: true,
        // probeStepMs: the hung click waits out the same step deadline, only
        // sooner; the healthy calculator job afterwards still has ample time per step.
        budgets: {
          readinessMs: 2_000,
          workerWallMs: 9_000,
          cleanupGraceMs: 500,
          probeStepMs: 1_000,
        },
        onWorkerExit: (report) => local.push(report),
      });
      try {
        const before = await interactiveJob(
          "<!doctype html><html><body><p>x</p><script>for(;;){}</script></body></html>",
          [],
        );
        let started = Date.now();
        const first = await target.run(before, scope(), new AbortController().signal);
        const firstElapsed = Date.now() - started;
        expect(first.ok).toBe(false);
        if (!first.ok) expect(first.error.code).toBe("render_timeout");
        // Readiness (2 s) plus launch and the external hard slack stay well inside the worker budget.
        expect(firstElapsed).toBeLessThan(9_000);

        const after = await interactiveJob(
          '<!doctype html><html><body><p data-artifact-test="x">x</p><script>window.addEventListener("load", () => setTimeout(() => { for(;;){} }, 0));</script></body></html>',
          [{ op: "click", target: "x" }],
        );
        started = Date.now();
        const second = await target.run(after, scope(), new AbortController().signal);
        const secondElapsed = Date.now() - started;
        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.error.code).toBe("render_timeout");
        expect(secondElapsed).toBeLessThan(9_000 + 2_000);

        await waitForIdle(target);
        expect(target.stats()).toMatchObject({ running: 0, queued: 0, unverifiedExits: 0 });
        expect(local).toHaveLength(2);
        const processes = await listProcesses();
        for (const exit of local) {
          expect(exit.verified).toBe(true);
          expect(exit.browserPid).toBeGreaterThan(0);
          expect(isAlive(exit.browserPid!, processes)).toBe(false);
          expect(isAlive(exit.workerPid!, processes)).toBe(false);
        }
        const healthy = await target.run(
          await interactiveJob(fixture("calculator.html"), CALCULATOR_PROBES),
          scope(),
          new AbortController().signal,
        );
        expect(healthy.ok).toBe(true);
      } finally {
        await target.close();
      }
    },
    90_000,
  );

  describe("resource escape", () => {
    let sink: Server;
    let sinkOrigin = "";
    const hits: string[] = [];
    beforeAll(async () => {
      sink = createServer((request, response) => {
        hits.push(`${request.method} ${request.url}`);
        if (request.url?.startsWith("/redirect")) {
          response.writeHead(302, { location: `${sinkOrigin}/after-redirect` });
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-type": "text/plain",
          "access-control-allow-origin": "*",
        });
        response.end("ok");
      });
      sink.on("upgrade", (request, socket) => {
        hits.push(`UPGRADE ${request.url}`);
        socket.destroy();
      });
      await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
      sinkOrigin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    });

    const escapeBody = () => `
      <img src="${sinkOrigin}/img">
      <link rel="stylesheet" href="${sinkOrigin}/css">
      <link rel="prefetch" href="${sinkOrigin}/prefetch">
      <style>@font-face{font-family:x;src:url(${sinkOrigin}/font)} body{font-family:x;background:url(${sinkOrigin}/bg)}</style>
      <script src="${sinkOrigin}/script"></script>
      <iframe src="${sinkOrigin}/iframe"></iframe>
      <form id="f" action="${sinkOrigin}/form" method="post"><input name="a" value="b"></form>`;
    const escapeScript = () => `
      fetch("${sinkOrigin}/fetch").catch(() => {});
      try { const x = new XMLHttpRequest(); x.open("GET", "${sinkOrigin}/xhr"); x.send(); } catch {}
      try { new WebSocket("${sinkOrigin.replace("http", "ws")}/ws"); } catch {}
      try { navigator.sendBeacon("${sinkOrigin}/beacon", "x"); } catch {}
      try { new Worker("${sinkOrigin}/worker"); } catch {}
      try { new EventSource("${sinkOrigin}/sse"); } catch {}
      try { document.getElementById("f").submit(); } catch {}
      try { const i = new Image(); i.src = "${sinkOrigin}/img2"; } catch {}
      setTimeout(() => { try { location.href = "${sinkOrigin}/redirect"; } catch {} }, 50);
      setTimeout(() => { try { window.open("${sinkOrigin}/popup"); } catch {} }, 60);`;

    browserTest(
      "the sink detects requests from a deliberately unrestricted page",
      async () => {
        hits.length = 0;
        const CONTROL_PATHS = [
          "/img",
          "/css",
          "/fetch",
          "/xhr",
          "/beacon",
          "/script",
          "/iframe",
          "/form",
        ];
        const reached = (path: string) => hits.some((hit) => hit.includes(path));
        // Flake 0672: this page crashed Chromium on CI twice with no reason
        // given. Chromium's own log and the host's memory say why next time.
        const logDirectory = mkdtempSync(path.join(tmpdir(), "ork-0672-"));
        const logFile = path.join(logDirectory, "chrome.log");
        const browser = await chromium.launch({
          executablePath: CHROMIUM!,
          headless: true,
          args: ["--enable-logging", `--log-file=${logFile}`],
        });
        let crash: string | undefined;
        try {
          const page = await browser.newPage();
          page.on("crash", () => {
            crash = `renderer crashed at ${new Date().toISOString()}; free memory ${freemem()} of ${totalmem()} bytes; load ${loadavg().map((load) => load.toFixed(1))}`;
          });
          await page.goto(`${sinkOrigin}/start`);
          await page.setContent(
            `<!doctype html><html><body>${escapeBody()}<script>${escapeScript()}</script></body></html>`,
          );
          // A positive observation: done as soon as every class has arrived.
          const deadline = Date.now() + 10_000;
          while (!crash && !CONTROL_PATHS.every(reached) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          if (crash) throw new Error("The unrestricted control page crashed");
          const missing = CONTROL_PATHS.filter((path) => !reached(path));
          if (missing.length > 0)
            throw new Error(`The unrestricted control page missed requests: ${missing.join(", ")}`);
        } catch (error) {
          const log = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : [];
          throw new Error(
            [
              String(error),
              crash ?? "no crash event",
              "Chromium log tail:",
              ...log.slice(-40).map((line) => line.slice(0, 300)),
            ].join("\n"),
          );
        } finally {
          await browser.close();
          rmSync(logDirectory, { recursive: true, force: true });
        }
        // The control proves the sink observes every class we later expect to be blocked.
        for (const path of CONTROL_PATHS) {
          expect(reached(path)).toBe(true);
        }
      },
      60_000,
    );

    browserTest(
      "the preview boundary lets none of them reach the sink",
      async () => {
        hits.length = 0;
        // Built by hand (not by the preparer, which would reject most of this) so the
        // runtime boundary itself is exercised: only the script hash is authorized.
        const runtime = escapeInlineScript(
          artifactFrameRuntimeScript({
            artifactId: "art_escape0001",
            revision: 1,
            nonce: "escapeNonce0001",
          }),
        );
        const script = escapeScript();
        const document = `<!doctype html><html><head><script>${runtime}</script></head><body>${escapeBody()}<a href="${sinkOrigin}/anchor" id="a" data-artifact-test="link">go</a><script>${script}</script><meta http-equiv="refresh" content="0;url=${sinkOrigin}/refresh"></body></html>`;
        const csp = buildInteractiveCsp([inlineScriptHash(runtime), inlineScriptHash(script)], []);
        const result: PreviewJobResult = await runner.run(
          {
            kind: "html-interactive",
            preparedDocument: document,
            contentSecurityPolicy: csp,
            readinessNonce: "escapeNonce0001",
            profile: DEFAULT_PREVIEW_PROFILE,
            probes: [{ op: "click", target: "link" }],
          },
          scope(),
          new AbortController().signal,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        console.error(
          "[escape]",
          !result.ok && result.error.code,
          result.blockedRequests,
          result.diagnostics.map((d) => d.code + ":" + d.message),
        );
        expect(hits).toEqual([]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(["policy_denied", "validation_failed", "render_timeout"]).toContain(
            result.error.code,
          );
          const blocked = Object.values(result.blockedRequests).reduce(
            (sum, value) => sum + value,
            0,
          );
          expect(blocked).toBeGreaterThan(0);
        }
      },
      60_000,
    );
  });
});
