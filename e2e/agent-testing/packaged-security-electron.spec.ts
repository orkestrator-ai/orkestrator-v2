/** Direct launch of the shipping (inspect-off) binary; never _electron.launch. */
import { expect, test } from "./electron-fixtures";
import { chromium, type Browser } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GATEWAY_RENDERER_CONTENT_SECURITY_POLICY,
  GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
  RENDERER_CONTENT_SECURITY_POLICY,
  STATIC_HTML_FRAME_DOCUMENT,
} from "@orkestrator/protocol/renderer-content-security-policy";
import {
  AGENT_TEST_HIDDEN_WINDOWS_ENV,
  resolveRuntimeProfile,
} from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ownProcessGroup, stopProcessGroup, withCleanup } from "../process-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { dismissStartupDialogsOnPage } from "./electron-startup-dialogs";
import { packagedLaunchEnvironment, packagedLaunchSwitches } from "./packaged-electron-app";
import { shippingPackage, verifyShippingPackage } from "../../scripts/packaged-security";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * The static HTML presentation handshake, run in a page: the emitted document
 * announces itself with the URL fragment's nonce, renders once, and reports.
 */
async function probeStaticFrame(
  src: string,
): Promise<{ ready: boolean; rendered: boolean; origin: string; authored: boolean }> {
  const nonce = "securityprobenonce0000000000000000";
  const generation = "securityprobegeneration0000000000";
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.src = `${src}#${nonce}`;
  frame.dataset.securityProbe = "static";
  frame.style.cssText =
    "position:fixed;inset:16px;width:400px;height:150px;z-index:2147483647;background:white;color:black";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Static frame timed out")), 15000);
    let ready = false;
    let authored = false;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (event.data === "authored") authored = true;
      const data = event.data as { channel?: string; type?: string; nonce?: string };
      if (data?.channel !== "orkestrator-static-html") return;
      if (data.type === "ready" && data.nonce === nonce) {
        ready = true;
        frame.contentWindow!.postMessage(
          {
            channel: "orkestrator-static-html",
            v: 1,
            type: "render",
            generation,
            verifiedAppearance: "light",
            theme: { appearance: "light", reducedMotion: false, tokens: {} },
            html: "<!doctype html><p>Packaged static document</p><script>parent.postMessage('authored', '*')</script>",
          },
          "*",
        );
      } else if (data.type === "rendered") {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
        resolve({ ready, rendered: true, origin: event.origin, authored });
      } else if (data.type === "error") {
        clearTimeout(timer);
        reject(new Error("The static frame refused the document"));
      }
    };
    window.addEventListener("message", receive);
    document.body.append(frame);
  });
}

test("shipping binary has the L3 fuses and ignores hostile dev variables, NODE_OPTIONS and Node inspector arguments", async () => {
  test.skip(
    process.platform !== "darwin" && process.platform !== "linux",
    "macOS/Linux package smoke",
  );
  const pkg = shippingPackage(
    root,
    process.platform,
    process.arch,
    process.env.ORKESTRATOR_SHIPPED_APP_EXECUTABLE?.trim() || undefined,
  );
  const executable = pkg.executable;
  // Missing packages fail rather than turning a green task into skipped qualification.
  expect(existsSync(executable), "Build the shipping --dir package first (not packaged-test)").toBe(
    true,
  );
  // Security report L3: read the fuses this binary actually carries.
  const report = await verifyShippingPackage(pkg);
  expect(
    report.checks.filter((check) => !check.passed),
    report.checks.map((check) => `${check.check}: ${check.detail}`).join("; "),
  ).toEqual([]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "orkestrator-package-security-"));
  let browser: Browser | undefined;
  let policyBrowser: Browser | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  let requests = 0;
  const hostile = http.createServer((_req, res) => {
    requests++;
    res.end("hostile renderer");
  });
  await withCleanup(async () => {
    await new Promise<void>((resolve) => hostile.listen(0, "127.0.0.1", resolve));
    const address = hostile.address() as net.AddressInfo;
    const [rendererPort, gatewayPort, inspectPort] = await reserveLoopbackPorts(3);
    const profile = resolveRuntimeProfile({
      repositoryRoot: root,
      requestedId: "packaged-security",
      flavor: "agent-test",
      rendererPort: rendererPort!,
      gatewayPort: gatewayPort!,
      roots: {
        developmentRoot: path.join(scratch, "dev"),
        productionDataDir: path.join(scratch, "production"),
        homeDir: scratch,
      },
    });
    const profilePath = await initializeProfile(profile);
    const home = path.join(scratch, "home");
    await mkdir(home);
    const marker = path.join(scratch, "node-options-executed");
    const preload = path.join(scratch, "hostile.cjs");
    await writeFile(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    );
    let stderr = "";
    let spawnError = false;
    child = ownProcessGroup(
      spawn(
        executable,
        [
          ...ELECTRON_TEST_SWITCHES,
          ...packagedLaunchSwitches(process.platform),
          "--remote-debugging-port=0",
          `--inspect=127.0.0.1:${inspectPort}`,
        ],
        {
          detached: true,
          cwd: scratch,
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...packagedLaunchEnvironment(process.env, { home, profilePath }),
            ELECTRON_DEV: "1",
            VITE_DEV_SERVER_URL: `http://127.0.0.1:${address.port}`,
            ORKESTRATOR_RENDERER_DEV_SERVER_URL: `http://127.0.0.1:${address.port}`,
            NODE_OPTIONS: `--require=${preload}`,
          },
        },
      ),
    );
    child.on("error", () => {
      spawnError = true;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-256 * 1024);
    });
    await expect
      .poll(
        () => {
          expect(spawnError).toBe(false);
          expect(child!.exitCode).toBeNull();
          return /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1];
        },
        { timeout: 60_000 },
      )
      .toBeTruthy();
    browser = await chromium.connectOverCDP(
      /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)![1]!,
    );
    const renderer = pathToFileURL(path.join(pkg.resources, "web/index.html")).href;
    await expect
      .poll(
        () =>
          browser!
            .contexts()
            .flatMap((c) => c.pages())
            .map((p) => p.url()),
        { timeout: 60_000 },
      )
      .toContain(renderer);
    // Security report M6 and M7: the sandboxed CommonJS preload still exposes the
    // bridge, the document carries the policy, and that policy refuses script.
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url() === renderer)!;
    expect(
      await page.evaluate(async () => {
        const inline = document.createElement("script");
        inline.textContent = "window.__inlineScriptRan = true";
        document.head.append(inline);
        // CDP's evaluate lifts the eval restriction for its synchronous scope.
        await new Promise((resolve) => setTimeout(resolve));
        let evalRan = true;
        try {
          new Function("return 1")();
        } catch {
          evalRan = false;
        }
        return {
          bridge: typeof (window as unknown as { orkestrator?: { invoke?: unknown } }).orkestrator
            ?.invoke,
          nodeIntegration: typeof (window as unknown as { require?: unknown }).require,
          policy: document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute("content"),
          inlineScriptRan: "__inlineScriptRan" in window,
          evalRan,
        };
      }),
    ).toEqual({
      bridge: "function",
      nodeIntegration: "undefined",
      policy: RENDERER_CONTENT_SECURITY_POLICY,
      inlineScriptRan: false,
      evalRan: false,
    });
    // CSP file: 'self' must never make a sibling local script executable.
    const outside = path.join(scratch, "outside-renderer.js");
    await writeFile(outside, "window.__outsideRendererScriptRan = true");
    expect(
      await page.evaluate(async (src) => {
        const script = document.createElement("script");
        script.src = src;
        const outcome = new Promise<string>((resolve) => {
          script.onload = () => resolve("loaded");
          script.onerror = () => resolve("blocked");
        });
        document.head.append(script);
        const result = await outcome;
        script.remove();
        return { result, ran: "__outsideRendererScriptRan" in window };
      }, pathToFileURL(outside).href),
    ).toEqual({ result: "blocked", ran: false });

    // Exercise the emitted worker, including its real Oniguruma WebAssembly engine.
    const assets = await readdir(path.join(pkg.resources, "web/assets"));
    const highlight = assets.find((name) => /^highlight\.worker-.*\.js$/.test(name));
    expect(highlight).toBeDefined();
    const highlighted = await page.evaluate(
      async (src) => {
        const worker = new Worker(src, { type: "module" });
        try {
          return await new Promise<{ ok: boolean; lines: Array<Array<{ s?: string }>> }>(
            (resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error("Highlighter worker timed out")),
                15000,
              );
              worker.onmessage = ({ data }) => {
                clearTimeout(timer);
                resolve(data);
              };
              worker.onerror = () => {
                clearTimeout(timer);
                reject(new Error("Highlighter worker failed"));
              };
              worker.postMessage({
                id: 1,
                lang: "typescript",
                theme: "dark",
                code: "const answer: number = 42;",
              });
            },
          );
        } finally {
          worker.terminate();
        }
      },
      new URL(`assets/${highlight}`, renderer).href,
    );
    expect(highlighted.ok).toBe(true);
    expect(highlighted.lines.flat().some((token) => token.s)).toBe(true);

    const editorWorker = assets.find((name) => /^editor\.worker-.*\.js$/.test(name));
    expect(editorWorker).toBeDefined();
    expect(
      await page.evaluate(
        async (src) => {
          const worker = new Worker(src, { type: "module" });
          try {
            return await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("Monaco worker timed out")), 15000);
              worker.onmessage = ({ data }) => {
                if (data.type === 1 && data.seq === "1") {
                  clearTimeout(timer);
                  if (data.err) reject(new Error("Monaco initialization refused"));
                  else resolve(true);
                }
              };
              worker.onerror = () => {
                clearTimeout(timer);
                reject(new Error("Monaco worker failed"));
              };
              worker.postMessage("bootstrap");
              worker.postMessage({
                vsWorker: 1,
                type: 0,
                req: "1",
                channel: "default",
                method: "$initialize",
                args: [1],
              });
            });
          } finally {
            worker.terminate();
          }
        },
        new URL(`assets/${editorWorker}`, renderer).href,
      ),
    ).toBe(true);

    // The emitted document executes its hash-pinned bootstrap in an opaque frame.
    expect(
      await page.evaluate(async (src) => {
        const frame = document.createElement("iframe");
        frame.sandbox.add("allow-scripts");
        frame.src = src;
        frame.dataset.securityProbe = "design";
        frame.style.cssText =
          "position:fixed;inset:16px;width:400px;height:150px;z-index:2147483647;background:white;color:black";
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            frame.remove();
            reject(new Error("Design runtime timed out"));
          }, 15000);
          const receive = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.data?.requestId !== "security-probe")
              return;
            clearTimeout(timer);
            window.removeEventListener("message", receive);
            resolve({ result: event.data.result, origin: event.origin });
          };
          window.addEventListener("message", receive);
          frame.onload = () =>
            frame.contentWindow!.postMessage(
              {
                channel: "orkestrator-design",
                requestId: "security-probe",
                operation: { op: "render", html: "<!doctype html><p>Packaged design runtime</p>" },
              },
              "*",
            );
          document.body.append(frame);
        });
      }, new URL("design-frame.html", renderer).href),
    ).toEqual({ result: true, origin: "null" });
    await expect(
      page
        .locator('iframe[data-security-probe="design"]')
        .contentFrame()
        .getByText("Packaged design runtime"),
    ).toBeVisible();
    const previewDir = path.join(root, "output/visual-previews");
    await mkdir(previewDir, { recursive: true });
    await page.locator('iframe[data-security-probe="design"]').screenshot({
      path: path.join(previewDir, "renderer-security-packaged-design-runtime-visible.png"),
    });
    await page.locator('iframe[data-security-probe="design"]').evaluate((frame) => frame.remove());

    // The transcript's static document loads the same way, under its own policy.
    expect(
      await page.evaluate(probeStaticFrame, new URL(STATIC_HTML_FRAME_DOCUMENT, renderer).href),
    ).toEqual({ ready: true, rendered: true, origin: "null", authored: false });
    await expect(
      page
        .locator('iframe[data-security-probe="static"]')
        .contentFrame()
        .getByText("Packaged static document"),
    ).toBeVisible();
    await page.locator('iframe[data-security-probe="static"]').screenshot({
      path: path.join(previewDir, "renderer-security-packaged-static-document-visible.png"),
    });
    await page.locator('iframe[data-security-probe="static"]').evaluate((frame) => frame.remove());

    expect(stderr).not.toContain("preload-failed");
    // file:// startup alone does not exercise the backend's HTTP renderer path.
    // Authenticate locally without putting the disposable token in any artifact.
    let gatewayPolicy: string | null = null;
    await expect
      .poll(
        async () => {
          try {
            const { token } = JSON.parse(
              await readFile(path.join(profile.dataDir, "gateway-auth.json"), "utf8"),
            );
            const response = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(2_000),
              redirect: "manual",
            });
            await response.arrayBuffer();
            gatewayPolicy = response.headers.get("content-security-policy");
            return response.status;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(200);
    expect(gatewayPolicy).toBe(GATEWAY_RENDERER_CONTENT_SECURITY_POLICY);
    const { token: gatewayToken } = JSON.parse(
      await readFile(path.join(profile.dataDir, "gateway-auth.json"), "utf8"),
    );
    const designPath = process.platform === "darwin" ? "DESIGN-FRAME.HTML" : "design-frame.html";
    const designResponse = await fetch(`http://127.0.0.1:${gatewayPort}/${designPath}`, {
      headers: { Authorization: `Bearer ${gatewayToken}` },
    });
    expect(designResponse.status).toBe(200);
    expect(designResponse.headers.get("content-security-policy")).toBe(
      GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
    );
    // Replay the authenticated document and its actual policy without putting a
    // bearer in browser requests or traces. No iframe sandbox attribute: the
    // gateway header itself must make the document opaque.
    const designBody = await designResponse.text();
    const designUrl = "https://renderer-security.invalid/design-frame.html";
    policyBrowser = await chromium.launch({ headless: true });
    const policyPage = await policyBrowser.newPage();
    await policyPage.route("https://renderer-security.invalid/", (route) =>
      route.fulfill({
        body: "<!doctype html><title>Gateway policy probe</title>",
        contentType: "text/html",
        headers: { "content-security-policy": GATEWAY_RENDERER_CONTENT_SECURITY_POLICY },
      }),
    );
    await policyPage.goto("https://renderer-security.invalid/");
    await policyPage.route(designUrl, (route) =>
      route.fulfill({
        body: designBody,
        contentType: "text/html",
        headers: { "content-security-policy": GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY },
      }),
    );
    expect(
      await policyPage.evaluate(async (src) => {
        const frame = document.createElement("iframe");
        frame.src = src;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Gateway design bootstrap timed out")),
            15000,
          );
          const receive = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.data?.requestId !== "gateway-probe")
              return;
            clearTimeout(timer);
            window.removeEventListener("message", receive);
            frame.remove();
            resolve({ origin: event.origin, result: event.data.result });
          };
          window.addEventListener("message", receive);
          frame.onload = () =>
            frame.contentWindow!.postMessage(
              {
                channel: "orkestrator-design",
                requestId: "gateway-probe",
                operation: { op: "render", html: "<p>Gateway design runtime</p>" },
              },
              "*",
            );
          document.body.append(frame);
        });
      }, designUrl),
    ).toEqual({ origin: "null", result: true });
    const staticResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/${STATIC_HTML_FRAME_DOCUMENT}`,
      { headers: { Authorization: `Bearer ${gatewayToken}` } },
    );
    expect(staticResponse.status).toBe(200);
    expect(staticResponse.headers.get("content-security-policy")).toBe(
      GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
    );
    const staticBody = await staticResponse.text();
    const staticUrl = `https://renderer-security.invalid/${STATIC_HTML_FRAME_DOCUMENT}`;
    await policyPage.route(staticUrl, (route) =>
      route.fulfill({
        body: staticBody,
        contentType: "text/html",
        headers: { "content-security-policy": GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY },
      }),
    );
    expect(await policyPage.evaluate(probeStaticFrame, staticUrl)).toEqual({
      ready: true,
      rendered: true,
      origin: "null",
      authored: false,
    });
    await policyBrowser.close();
    policyBrowser = undefined;

    expect(requests).toBe(0);
    expect(stderr).toContain("dev-mode.ignored-packaged");
    expect(stderr).not.toContain("Debugger listening");
    expect(existsSync(marker)).toBe(false);
    // Chromium's CDP is available, but the independent Node inspector port must be closed.
    const inspectorOpen = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: inspectPort! });
      socket.setTimeout(2_000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(true);
      });
    });
    expect(inspectorOpen).toBe(false);
  }, [
    async () => {
      await policyBrowser?.close();
      await browser?.close();
    },
    async () => {
      if (child) await stopProcessGroup(child);
      stopped = true;
    },
    async () => {
      await new Promise<void>((resolve, reject) =>
        hostile.close((error) => (error ? reject(error) : resolve())),
      );
    },
    async () => {
      if (stopped) await rm(scratch, { recursive: true, force: true });
    },
  ]);
});

type TransportProbe = {
  protocol: string;
  host: string[] | null;
  hostOrigin: string | null;
  gatewayClient: boolean;
  streamState: string | null;
  eventResource: string | null;
  invokesOverHttp: string[];
};

/**
 * Page code: run one command through `window.orkestrator` and wait for the
 * `resource-changed` event its mutation announces. The preload's own listener,
 * which only main's relay feeds, stays installed after the probe returns and
 * counts config changes into `window.__relayedToHost`; the test reads that
 * counter only at its end ({@link readRelayedToHost}), so a relayed copy that
 * arrives at any point during the rest of the test fails it, rather than only
 * one inside a fixed sleep.
 */
async function probeTransport(): Promise<TransportProbe> {
  type Api = {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen(event: string, callback: (payload: unknown) => void): (() => void) | Promise<() => void>;
    eventStreamReady?: (event: string) => Promise<void>;
    eventStreamConnection?: { state(): string };
  };
  const page = window as unknown as {
    orkestrator: Api;
    orkestratorGateway?: unknown;
    orkestratorDesktopHost?: { api: Api; baseUrl: string };
  };
  const api = page.orkestrator;
  const host = page.orkestratorDesktopHost;
  const configChange = (value: unknown) => {
    const payload = (value as { payload?: unknown })?.payload ?? value;
    return (payload as { resource?: string })?.resource === "config";
  };
  const counter = window as unknown as { __relayedToHost?: number };
  counter.__relayedToHost = 0;
  if (host) {
    await host.api.listen("resource-changed", (value) => {
      if (configChange(value)) counter.__relayedToHost = (counter.__relayedToHost ?? 0) + 1;
    });
  }
  let unlisten: (() => void) | null = null;
  const received = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No resource-changed event arrived")), 30_000);
    void Promise.resolve(
      api.listen("resource-changed", (value) => {
        if (!configChange(value)) return;
        clearTimeout(timer);
        resolve("config");
      }),
    ).then((stop) => {
      unlisten = stop;
    }, reject);
  });
  await api.eventStreamReady?.("resource-changed");
  performance.clearResourceTimings();
  const before = await api.invoke<{ global?: { experimentalScheduling?: boolean } }>(
    "get_config",
    {},
  );
  await api.invoke("patch_global_config", {
    patch: { experimentalScheduling: before.global?.experimentalScheduling === true },
  });
  const eventResource = await received;
  (unlisten as (() => void) | null)?.();
  return {
    protocol: location.protocol,
    host: host ? Object.keys(host).sort() : null,
    hostOrigin: host ? new URL(host.baseUrl).origin : null,
    gatewayClient: "orkestratorGateway" in page,
    streamState: api.eventStreamConnection?.state() ?? null,
    eventResource,
    invokesOverHttp: performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.includes("/__orkestrator/invoke"))
      .map((name) => new URL(name).origin),
  };
}

/**
 * Page code, run at the end of the default-transport test: make one more
 * config change, wait for its event on the window's own stream, and return how
 * many config changes main relayed to the preload's listener since
 * {@link probeTransport} installed it. Waiting on an event rather than a timer
 * keeps the check from passing merely because a sleep was shorter than main.
 */
async function readRelayedToHost(): Promise<number> {
  type Api = {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen(event: string, callback: (payload: unknown) => void): (() => void) | Promise<() => void>;
  };
  const page = window as unknown as { orkestrator: Api; __relayedToHost?: number };
  const api = page.orkestrator;
  let unlisten: (() => void) | null = null;
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No resource-changed event arrived")), 30_000);
    void Promise.resolve(
      api.listen("resource-changed", (value) => {
        const payload = (value as { payload?: unknown })?.payload ?? value;
        if ((payload as { resource?: string })?.resource !== "config") return;
        clearTimeout(timer);
        resolve();
      }),
    ).then((stop) => {
      unlisten = stop;
    }, reject);
  });
  const before = await api.invoke<{ global?: { experimentalScheduling?: boolean } }>(
    "get_config",
    {},
  );
  await api.invoke("patch_global_config", {
    patch: { experimentalScheduling: before.global?.experimentalScheduling === true },
  });
  await received;
  (unlisten as (() => void) | null)?.();
  if (page.__relayedToHost === undefined) throw new Error("probeTransport did not run");
  return page.__relayedToHost;
}

/**
 * To-do 4501 task 1: the direct gateway transport on the shipping renderer,
 * which loads from `file://` under the packaged policy, rather than Vite's
 * `http://` page the other transport specs drive. With no config the window
 * takes the direct transport (the default since task 2); an explicit `false`,
 * as a release before the flip stored it, keeps main's relay. Windows stay
 * hidden on macOS (`ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS`), so the run never
 * takes the desktop's focus.
 */
for (const transport of ["default", "relay"] as const) {
  test(`packaged file:// window: ${transport === "default" ? "the direct gateway transport by default" : "an explicit false keeps main's relay"}`, async () => {
    test.skip(
      process.platform !== "darwin" && process.platform !== "linux",
      "macOS/Linux package smoke",
    );
    const pkg = shippingPackage(
      root,
      process.platform,
      process.arch,
      process.env.ORKESTRATOR_SHIPPED_APP_EXECUTABLE?.trim() || undefined,
    );
    expect(
      existsSync(pkg.executable),
      "Build the shipping --dir package first (not packaged-test)",
    ).toBe(true);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "orkestrator-package-transport-"));
    let browser: Browser | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let stopped = false;
    await withCleanup(async () => {
      // No fixed ports: the shipping window loads file://, so the renderer
      // port is unused, and gateway port 0 has the backend bind whatever the
      // OS hands it. The probe talks to main's control listener, which also
      // binds port 0, so no port is ever released for another process to take.
      const profile = resolveRuntimeProfile({
        repositoryRoot: root,
        requestedId: `packaged-transport-${transport}`,
        flavor: "agent-test",
        rendererPort: 0,
        gatewayPort: 0,
        roots: {
          developmentRoot: path.join(scratch, "dev"),
          productionDataDir: path.join(scratch, "production"),
          homeDir: scratch,
        },
      });
      const profilePath = await initializeProfile(profile);
      if (transport === "relay") {
        await mkdir(profile.dataDir, { recursive: true });
        await writeFile(
          path.join(profile.dataDir, "config.json"),
          JSON.stringify({ repositories: {}, global: { localWindowGatewayTransport: false } }),
        );
      }
      const home = path.join(scratch, "home");
      await mkdir(home);
      let stderr = "";
      let spawnError = false;
      child = ownProcessGroup(
        spawn(
          pkg.executable,
          [
            ...ELECTRON_TEST_SWITCHES,
            ...packagedLaunchSwitches(process.platform),
            "--remote-debugging-port=0",
          ],
          {
            detached: true,
            cwd: scratch,
            stdio: ["ignore", "ignore", "pipe"],
            env: {
              ...packagedLaunchEnvironment(process.env, { home, profilePath }),
              [AGENT_TEST_HIDDEN_WINDOWS_ENV]: "1",
            },
          },
        ),
      );
      child.on("error", () => {
        spawnError = true;
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-256 * 1024);
      });
      const devtools = /DevTools listening on (ws:\/\/[^\s]+)/;
      await expect
        .poll(
          () => {
            expect(spawnError).toBe(false);
            expect(child!.exitCode).toBeNull();
            return devtools.exec(stderr)?.[1];
          },
          { timeout: 60_000 },
        )
        .toBeTruthy();
      browser = await chromium.connectOverCDP(devtools.exec(stderr)![1]!);
      const renderer = pathToFileURL(path.join(pkg.resources, "web/index.html")).href;
      const pages = () => browser!.contexts().flatMap((c) => c.pages());
      await expect.poll(() => pages().map((p) => p.url()), { timeout: 60_000 }).toContain(renderer);
      const page = pages().find((p) => p.url() === renderer)!;
      await expect
        .poll(() => page.evaluate(() => "orkestrator" in window).catch(() => false), {
          timeout: 60_000,
        })
        .toBe(true);
      const probe = await page.evaluate(probeTransport);
      expect(probe.protocol).toBe("file:");
      expect(probe.gatewayClient, "a local window is never a remote gateway client").toBe(false);
      expect(probe.eventResource).toBe("config");
      if (transport === "default") {
        // Commands and events went straight to the local backend over HTTP,
        // from a file:// page: main's Origin rewrite and the packaged policy's
        // connect-src both let them through, and main relayed nothing.
        expect(probe.host).toEqual(["api", "baseUrl"]);
        expect(probe.streamState).not.toBeNull();
        expect(probe.invokesOverHttp.length).toBeGreaterThanOrEqual(2);
        // The control listener main already uses, on loopback; not the gateway port.
        expect(probe.hostOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(new Set(probe.invokesOverHttp)).toEqual(new Set([probe.hostOrigin]));
        // Settings shows the same default as main applied.
        dismissStartupDialogsOnPage(page);
        await page.getByRole("button", { name: "Global settings", exact: true }).click();
        await page
          .getByRole("navigation", { name: "Settings sections" })
          .getByRole("button", { name: "Experimental", exact: true })
          .click();
        const toggle = page.getByRole("switch", {
          name: "Use the direct transport for new windows",
        });
        await expect(toggle).toHaveAttribute("aria-checked", "true");
        const previewDir = path.join(root, "output/visual-previews");
        await mkdir(previewDir, { recursive: true });
        await toggle.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(previewDir, "local-transport-packaged-default-on.png"),
        });
        // Main relayed neither config change: the preload's listener has been
        // counting since the probe, through the Settings steps above.
        expect(
          await page.evaluate(readRelayedToHost),
          "main relayed a config change to a direct-transport window",
        ).toBe(0);
      } else {
        expect(probe.host).toBeNull();
        expect(probe.invokesOverHttp).toEqual([]);
      }
      expect(stderr).not.toContain("preload-failed");
    }, [
      async () => {
        await browser?.close();
      },
      async () => {
        if (child) await stopProcessGroup(child);
        stopped = true;
      },
      async () => {
        if (stopped) await rm(scratch, { recursive: true, force: true });
      },
    ]);
  });
}

for (const attack of ["asar-header", "app-folder"] as const) {
  test(`shipping binary rejects ${attack} tampering`, async () => {
    test.skip(
      process.platform !== "darwin" && process.platform !== "linux",
      "macOS/Linux package smoke",
    );
    test.skip(
      attack === "asar-header" && process.platform !== "darwin",
      "Electron does not enforce asar integrity on Linux",
    );
    const pkg = shippingPackage(
      root,
      process.platform,
      process.arch,
      process.env.ORKESTRATOR_SHIPPED_APP_EXECUTABLE?.trim() || undefined,
    );
    expect((await verifyShippingPackage(pkg)).passed).toBe(true);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "ork-tamper-"));
    const source =
      process.platform === "darwin"
        ? path.resolve(pkg.executable, "../../..")
        : path.dirname(pkg.executable);
    const copy = path.join(scratch, path.basename(source));
    let child: ReturnType<typeof spawn> | undefined;
    let stopped = false;
    await withCleanup(async () => {
      // Mutate a disposable copy only; retain symlinks inside the macOS bundle.
      await cp(source, copy, { recursive: true, verbatimSymlinks: true });
      const executable = path.join(copy, path.relative(source, pkg.executable));
      const resources = path.join(copy, path.relative(source, pkg.resources));
      const asar = path.join(resources, "app.asar");
      const marker = path.join(scratch, "replacement-ran");
      if (attack === "asar-header") {
        const file = await open(asar, "r+");
        try {
          const prefix = Buffer.alloc(16);
          await file.read(prefix, 0, 16, 0);
          const length = prefix.readUInt32LE(12);
          expect(length).toBeGreaterThan(0);
          expect(length).toBeLessThan(16 * 1024 * 1024);
          const header = Buffer.alloc(length);
          await file.read(header, 0, length, 16);
          const index = header.indexOf('"package.json"');
          expect(index).toBeGreaterThanOrEqual(0);
          // Same length, still valid JSON: only the embedded header hash changes.
          header[index + 1] = "P".charCodeAt(0);
          JSON.parse(header.toString());
          await file.write(header, 0, length, 16);
        } finally {
          await file.close();
        }
      } else {
        await rm(asar);
        const app = path.join(resources, "app");
        await mkdir(app);
        await writeFile(path.join(app, "package.json"), JSON.stringify({ main: "index.js" }));
        await writeFile(
          path.join(app, "index.js"),
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); require('electron').app.exit(0);`,
        );
      }
      const [rendererPort, gatewayPort] = await reserveLoopbackPorts(2);
      const profile = resolveRuntimeProfile({
        repositoryRoot: root,
        requestedId: "tamper",
        flavor: "agent-test",
        rendererPort: rendererPort!,
        gatewayPort: gatewayPort!,
        roots: {
          developmentRoot: path.join(scratch, "dev"),
          productionDataDir: path.join(scratch, "production"),
          homeDir: scratch,
        },
      });
      const profilePath = await initializeProfile(profile);
      const home = path.join(scratch, "home");
      await mkdir(home);
      let stderr = "";
      child = ownProcessGroup(
        spawn(
          executable,
          [
            ...ELECTRON_TEST_SWITCHES,
            ...packagedLaunchSwitches(process.platform),
            "--noerrdialogs",
          ],
          {
            detached: true,
            cwd: scratch,
            stdio: ["ignore", "ignore", "pipe"],
            env: packagedLaunchEnvironment(process.env, { home, profilePath }),
          },
        ),
      );
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child!.once("error", reject);
          child!.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      // Observe spawn errors immediately, including while polling for exit.
      void exited.catch(() => {});
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-256 * 1024);
      });
      await expect
        .poll(() => child!.exitCode !== null || child!.signalCode !== null, { timeout: 30_000 })
        .toBe(true);
      const outcome = await exited;
      expect(outcome.code === 0 && outcome.signal === null).toBe(false);
      expect(existsSync(marker)).toBe(false);
      if (attack === "asar-header") expect(stderr).toContain("Integrity check failed");
    }, [
      async () => {
        if (child) await stopProcessGroup(child);
        stopped = true;
      },
      async () => {
        if (stopped) await rm(scratch, { recursive: true, force: true });
      },
    ]);
  });
}
