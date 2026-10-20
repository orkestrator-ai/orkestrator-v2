/**
 * Opt-in live qualification of the interactive-artifact host in real
 * Electron/Chromium (not run by `bun test`). It drives `ArtifactHostManager`
 * against a local content server that serves prepared-style documents with
 * the executable CSP (including `sandbox allow-scripts`), plus HTTP, UDP and
 * TCP sinks that must never be reached.
 *
 *   cd apps/desktop
 *   bun build tests/artifact-host-live-probe.ts --target=node --format=esm \
 *     --external electron --outfile /tmp/artifact-host-live-probe.mjs
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     --user-data-dir=/tmp/artifact-host-live-probe /tmp/artifact-host-live-probe.mjs
 *
 * (Linux: node_modules/electron/dist/electron.) Exits non-zero on failure.
 */
import { app, BrowserWindow, protocol, session, WebContentsView } from "electron";
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import type { ArtifactHostEvent } from "@orkestrator/protocol/artifact-host-ipc";
import { artifactFrameRuntimeScript } from "@orkestrator/protocol/artifact-frame-channel";
import { ArtifactHostManager } from "../electron/artifact-host-manager";
import {
  ARTIFACT_SHELL_ORIGIN,
  ARTIFACT_SHELL_SCHEME_PRIVILEGES,
} from "../electron/artifact-host-shell";

protocol.registerSchemesAsPrivileged([ARTIFACT_SHELL_SCHEME_PRIVILEGES]);

const NONCE = "nonce_12345678";
const IDENTITY = { artifactId: "art_probe", revision: 1 };
const failures: string[] = [];
const sinkHits: string[] = [];
const log = (message: string) => process.stdout.write(`[artifact-host-probe] ${message}\n`);
const check = (name: string, ok: boolean, detail: unknown = "") => {
  log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : JSON.stringify(detail)}`);
  if (!ok) failures.push(name);
};

const SCENARIOS: Record<string, string> = {
  normal: `window.orkestratorArtifact.onTheme(() => {
    const r = {};
    try { r.parent = String(!!parent.document); } catch { r.parent = "blocked"; }
    try { r.cookie = document.cookie; } catch { r.cookie = "blocked"; }
    try { r.storage = String(localStorage.length); } catch { r.storage = "blocked"; }
    r.opener = String(window.opener); r.origin = String(self.origin);
    try { r.bridge = typeof parent.orkestrator; } catch { r.bridge = "blocked"; }
    r.require = typeof require; r.process = typeof process;
    document.body.style.height = "900px";
    window.orkestratorArtifact.requestLink("https://probe.example/path", JSON.stringify(r));
  });`,
  escape: `window.orkestratorArtifact.onTheme(() => setTimeout(() => { location.href = "https://example.invalid/"; }, 50));`,
  data: `window.orkestratorArtifact.onTheme(() => setTimeout(() => { location.href = "data:text/html,x"; }, 50));`,
  reload: `window.orkestratorArtifact.onTheme(() => setTimeout(() => location.reload(), 50));`,
  egress: `window.orkestratorArtifact.onTheme(() => {
    try { fetch("http://127.0.0.1:HTTP/fetch").catch(() => {}); } catch {}
    try { new WebSocket("ws://127.0.0.1:HTTP/ws"); } catch {}
    try { navigator.sendBeacon("http://127.0.0.1:HTTP/beacon", "x"); } catch {}
    try { const i = new Image(); i.src = "http://127.0.0.1:HTTP/img"; document.body.append(i); } catch {}
    try { window.open("http://127.0.0.1:HTTP/popup"); } catch {}
    try { new Worker("http://127.0.0.1:HTTP/worker.js"); } catch {}
    setTimeout(() => window.orkestratorArtifact.requestLink("https://done.example/", "done"), 800);
  });`,
  rtc: `window.orkestratorArtifact.onTheme(() => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [
        { urls: "stun:127.0.0.1:UDP" },
        { urls: "turn:127.0.0.1:TCP?transport=tcp", username: "u", credential: "c" },
        { urls: "turn:127.0.0.1:UDP?transport=udp", username: "u", credential: "c" },
      ] });
      pc.createDataChannel("x");
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
    } catch {}
  });`,
  hang: `window.orkestratorArtifact.onTheme(() => setTimeout(() => { for (;;) {} }, 50));`,
};

const hash = (source: string) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`;

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as net.AddressInfo).port;
}

app.whenReady().then(async () => {
  const httpSink = http.createServer((request, response) => {
    sinkHits.push(`http ${request.url}`);
    response.end("ok");
  });
  httpSink.on("upgrade", (request, socket) => {
    sinkHits.push(`upgrade ${request.url}`);
    socket.destroy();
  });
  const httpPort = await listen(httpSink);
  const udp = dgram.createSocket("udp4");
  udp.on("message", () => sinkHits.push("udp"));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", () => resolve()));
  const tcpSink = net.createServer((socket) => {
    sinkHits.push("tcp");
    socket.destroy();
  });
  const tcpPort = await listen(tcpSink);
  let frameAncestors = ARTIFACT_SHELL_ORIGIN;
  const contentRequests: Array<{ referer: string; cookie: string }> = [];
  const content = http.createServer((request, response) => {
    const mode = new URL(request.url ?? "/", "http://x").pathname.split("/")[2] ?? "normal";
    const runtime = artifactFrameRuntimeScript({ ...IDENTITY, nonce: NONCE });
    const scenario = (SCENARIOS[mode] ?? "")
      .replaceAll("HTTP", String(httpPort))
      .replaceAll("UDP", String(udp.address().port))
      .replaceAll("TCP", String(tcpPort));
    contentRequests.push({
      referer: request.headers.referer ?? "",
      cookie: request.headers.cookie ?? "",
    });
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src ${hash(runtime)} ${hash(scenario)}`,
        "script-src-attr 'none'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        "media-src 'none'",
        "connect-src 'none'",
        "worker-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "sandbox allow-scripts",
        `frame-ancestors ${frameAncestors}`,
      ].join("; "),
    });
    response.end(
      `<!doctype html><html><body><p>${mode}</p><script>${runtime}</script><script>${scenario}</script></body></html>`,
    );
  });
  const contentPort = await listen(content);

  const window = new BrowserWindow({ show: true, width: 900, height: 700 });
  await window.loadURL("data:text/html,<p>host</p>");
  const events: ArtifactHostEvent[] = [];
  const manager = new ArtifactHostManager({
    getWindow: () => window,
    WebContentsViewCtor: WebContentsView,
    fromPartition: (partition) => session.fromPartition(partition, { cache: false }),
    emit: (event) => events.push(event),
  });
  const waitFor = async (predicate: () => boolean, ms: number) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > ms) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let sequence = 0;
  const open = async (mode: string) => {
    const hostId = `probe${++sequence}`;
    const generation = `gen_${sequence}_probe`;
    const result = await manager.open({
      hostId,
      contentUrl: `http://127.0.0.1:${contentPort}/a/${mode}/document`,
      ...IDENTITY,
      generation,
      readinessNonce: NONCE,
      bounds: { x: 0, y: 0, width: 800, height: 400 },
      visible: true,
    });
    check(`${mode}: open resolves ok`, result.ok, result);
    const of = () => events.filter((event) => event.hostId === hostId);
    await waitFor(() => of().some((event) => event.type !== "unresponsive"), 8_000);
    manager.postTheme(hostId, {
      channel: "orkestrator-artifact",
      v: 1,
      type: "theme",
      ...IDENTITY,
      generation,
      appearance: "dark",
      reducedMotion: true,
      viewport: { width: 800, height: 400 },
      tokens: { "--ork-bg": "#000000" },
    });
    return { hostId, of };
  };
  const blocked = (of: () => ArtifactHostEvent[]) =>
    waitFor(() => of().some((event) => event.type === "navigation-blocked"), 5_000);

  {
    const { hostId, of } = await open("normal");
    const contents = manager.activeHost()?.webContents();
    // Present at runtime; not in Electron's published typings.
    const preferences = (
      contents as unknown as { getLastWebPreferences?: () => Record<string, unknown> } | undefined
    )?.getLastWebPreferences?.();
    check(
      "effective sandbox preferences",
      Boolean(
        preferences?.sandbox === true &&
        preferences.contextIsolation === true &&
        preferences.nodeIntegration === false &&
        preferences.nodeIntegrationInSubFrames === false &&
        preferences.webSecurity === true &&
        !preferences.preload,
      ),
      preferences,
    );
    const shell = (await contents?.mainFrame.executeJavaScript(
      "JSON.stringify({ origin: self.origin, require: typeof require, process: typeof process, bridge: typeof orkestrator })",
    )) as string;
    check(
      "shell has a tuple origin and no bridge",
      shell ===
        JSON.stringify({
          origin: ARTIFACT_SHELL_ORIGIN,
          require: "undefined",
          process: "undefined",
          bridge: "undefined",
        }),
      shell,
    );
    await waitFor(() => of().some((event) => event.type === "size"), 6_000);
    const types = of().map((event) => event.type);
    check(
      "ready, theme, link request and size relay",
      (["ready", "link-request", "size"] as const).every((t) => types.includes(t)),
      types,
    );
    const link = of().find((event) => event.type === "link-request");
    const probe = link && link.type === "link-request" ? JSON.parse(link.label) : null;
    check(
      "artifact is opaque and isolated from the shell, storage and bridges",
      JSON.stringify(probe) ===
        JSON.stringify({
          parent: "blocked",
          cookie: "blocked",
          storage: "blocked",
          opener: "null",
          origin: "null",
          bridge: "blocked",
          require: "undefined",
          process: "undefined",
        }),
      probe,
    );
    check(
      "content request carries no referrer or cookies",
      contentRequests.every((request) => request.referer === "" && request.cookie === ""),
      contentRequests,
    );
    const before = contents?.id;
    manager.setBounds(hostId, { x: 10, y: 10, width: 700, height: 300 });
    manager.setVisible(hostId, false);
    manager.setVisible(hostId, true);
    check(
      "repositioning keeps the same web contents",
      manager.activeHost()?.webContents()?.id === before,
    );
  }
  for (const mode of ["escape", "data", "reload"]) {
    const { of } = await open(mode);
    check(`${mode}: frame navigation closes the host`, await blocked(of), of());
  }
  {
    sinkHits.length = 0;
    const { of } = await open("egress");
    await waitFor(
      () =>
        of().some((event) => event.type === "link-request" || event.type === "navigation-blocked"),
      5_000,
    );
    await sleep(1_000);
    check(
      "egress: fetch/WebSocket/beacon/image/popup/worker reach no sink",
      sinkHits.length === 0,
      sinkHits,
    );
  }
  {
    sinkHits.length = 0;
    await open("rtc");
    await sleep(3_000);
    check("rtc: STUN/TURN reach no UDP or TCP sink", sinkHits.length === 0, sinkHits);
  }
  {
    frameAncestors = "'none'";
    const { of } = await open("normal");
    check("content refusing the shell as ancestor never goes live", await blocked(of), of());
    frameAncestors = ARTIFACT_SHELL_ORIGIN;
  }
  {
    const { hostId, of } = await open("hang");
    const reported = await waitFor(
      () => of().some((event) => event.type === "unresponsive"),
      10_000,
    );
    check("hang after ready is reported unresponsive", reported, of());
    const contents = manager.activeHost()?.webContents();
    const pids = (contents?.mainFrame.framesInSubtree ?? []).map((frame) => frame.osProcessId);
    manager.close(hostId);
    await sleep(2_000);
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    check(
      "closing a hung host terminates its renderer processes",
      pids.length > 0 && alive.length === 0,
      { pids, alive },
    );
    check("the application window survives", !window.isDestroyed());
  }
  manager.dispose();
  log(failures.length === 0 ? "ALL PASSED" : `FAILED: ${failures.join(", ")}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
