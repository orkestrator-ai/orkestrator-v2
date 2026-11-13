/**
 * Qualifies the executable-document policy in every supported browser engine
 * (Chromium, Firefox, WebKit through playwright-core), not only in jsdom:
 *
 * - the prepared document runs only in a `sandbox="allow-scripts"` frame of a
 *   permitted ancestor and is refused by any other (`frame-ancestors`);
 * - an injected inline script or event handler whose hash is not in the
 *   policy never runs, and `eval` is refused;
 * - fetch, XHR, beacon, EventSource, WebSocket, images, fonts, CSS, forms,
 *   popups and top navigation reach a local sink zero times;
 * - the frame cannot read the parent's DOM, cookies or storage, or its own;
 * - only `ready`, `size` and `link-request` from the frame pass the real
 *   validator (`parseArtifactFrameMessage`), and the real frame runtime
 *   accepts the host's `theme`;
 * - the header's CSP `sandbox` applies even when the iframe has no sandbox
 *   attribute;
 * - through the browser viewer shell (`/s/<capability>`), self-navigation
 *   (meta refresh, `location.href`/`replace`), data: and blob: navigation, a
 *   redirect, another capability URL on the content origin, `window.open`
 *   and form submission reach their sinks zero times, an unexpected load
 *   disposes the frame with a `shell-disposed` message, and the presentation
 *   channel still works through the relay.
 *
 * Every adversarial probe first runs as a deliberately unrestricted control
 * (the same bytes served without the policy, same-origin with the parent and
 * unsandboxed) to show the sink or observer would see the prohibited event.
 * Sinks are observed from outside the page. An engine whose browser is not
 * installed is skipped with a printed reason (`bunx playwright install
 * firefox webkit` for the repository's pinned playwright-core).
 *
 * Shared by the `content-server.engines-<engine>-<n>.test.ts` parts: one file per engine and
 * lane, so `bun test --parallel` overlaps the engines' fixed negative-observation windows. Every part
 * starts its own sink, parent servers and content server, and launches its own browser.
 */
import { afterAll, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Browser,
  type BrowserContext,
  type BrowserType,
  chromium,
  firefox,
  type Frame,
  type Page,
  webkit,
} from "playwright-core";
import { resolveDesignChromiumPath } from "../design/index.js";
import { LoopbackArtifactContentServer } from "./content-server.js";
import { TranscriptInteractivePreparer } from "./interactive-prepare.js";

export const CANARY = `canary${Math.random().toString(36).slice(2, 12)}`;

export const GENERATION = "gen-engine-qualification";

export const PROTOCOL_SOURCE = path.resolve(
  import.meta.dir,
  "../../../../../packages/protocol/src/artifact-frame-channel.ts",
);

export interface EngineSpec {
  name: "chromium" | "firefox" | "webkit";
  type: BrowserType;
  executablePath: string | null;
}

export function installed(type: BrowserType): string | null {
  try {
    const executable = type.executablePath();
    return existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

export const ENGINES: EngineSpec[] = [
  {
    name: "chromium",
    type: chromium,
    // The shipped desktop engine is Chromium; prefer the configured browser.
    executablePath: resolveDesignChromiumPath() ?? installed(chromium),
  },
  { name: "firefox", type: firefox, executablePath: installed(firefox) },
  { name: "webkit", type: webkit, executablePath: installed(webkit) },
];

/* ----------------------------- local servers ----------------------------- */

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

/** Records every request and WebSocket upgrade it receives (path only). */
export class Sink {
  readonly hits: string[] = [];
  origin = "";
  private readonly server = createServer((request, response) => {
    this.hits.push(`${request.method} ${request.url}`);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `${this.origin}/redirected` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // A data-URL icon: Firefox otherwise requests a control page's
    // /favicon.ico after its context closes, landing in the next observation.
    response.end('<!doctype html><title>sink</title><link rel="icon" href="data:,">');
  });

  async start(): Promise<void> {
    this.server.on("upgrade", (request, socket) => {
      this.hits.push(`UPGRADE ${request.url}`);
      socket.destroy();
    });
    this.origin = await listen(this.server);
  }

  reset(): void {
    this.hits.length = 0;
  }

  close(): void {
    this.server.close();
  }
}

export interface Fixture {
  artifactId: string;
  nonce: string;
  /** Capability URL on the content origin (policy applied). */
  url: string;
  /** The browser viewer shell for the same capability. */
  shellUrl: string;
  /** The capability's generation (the shell checks it on every message). */
  generation: string;
  /** The same bytes, for the unrestricted control. */
  bytes: Uint8Array;
}

/**
 * The "application": seeds a cookie, storage and DOM canary, embeds one
 * frame, validates every message with the real validator and, on a valid
 * `ready`, sends the host's `theme`. Also serves controls: prepared bytes
 * without any policy, same-origin with this page.
 */
export class ParentApp {
  origin = "";
  private readonly controls = new Map<string, Uint8Array>();
  private readonly server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://parent.invalid");
    if (url.pathname === "/validator.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(this.validator);
      return;
    }
    const control = this.controls.get(url.pathname);
    if (control) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(control);
      return;
    }
    if (url.pathname !== "/page") {
      response.writeHead(404).end();
      return;
    }
    const frame = url.searchParams.get("frame") ?? "about:blank";
    const sandbox = url.searchParams.get("sandbox");
    const config = {
      artifactId: url.searchParams.get("artifactId") ?? "",
      revision: 1,
      nonce: url.searchParams.get("nonce") ?? "",
      generation: url.searchParams.get("generation") ?? GENERATION,
      canary: CANARY,
    };
    const frameSrc = url.searchParams.get("frameSrc");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `ork_session=${CANARY}; Path=/; SameSite=Lax`,
      // Optional application-side policy: which origins its frames may load.
      ...(frameSrc ? { "content-security-policy": `frame-src ${frameSrc}` } : {}),
    });
    response.end(`<!doctype html><html><body>
<div id="secret">${CANARY}</div>
<script src="/validator.js"></script>
<script>
  const config = ${JSON.stringify(config)};
  window.secret = config.canary;
  localStorage.setItem("canary", config.canary);
  sessionStorage.setItem("canary", config.canary);
  window.messages = [];
  let identity = null;
  window.addEventListener("message", (event) => {
    const iframe = document.querySelector("iframe");
    const fromFrame = event.source === iframe.contentWindow;
    const verdict = window.__artifactFrame.parse(event.data, identity);
    let data;
    try { data = JSON.parse(JSON.stringify(event.data)); } catch { data = "[unserializable]"; }
    window.messages.push({ fromFrame, origin: event.origin, data,
      verdict: verdict.ok ? verdict.message.type : "rejected:" + verdict.reason });
    if (fromFrame && verdict.ok && verdict.message.type === "ready" && verdict.message.nonce === config.nonce && !identity) {
      identity = { artifactId: config.artifactId, revision: config.revision, generation: config.generation };
      iframe.contentWindow.postMessage({ channel: "orkestrator-artifact", v: 1, type: "theme",
        artifactId: config.artifactId, revision: config.revision, generation: config.generation,
        appearance: "dark", reducedMotion: true, viewport: { width: 800, height: 600 },
        tokens: { "--accent": "#123456" } }, "*");
    }
  });
</script>
<iframe ${sandbox === null ? "" : `sandbox="${sandbox}"`} referrerpolicy="no-referrer" src="${frame.replace(/"/g, "&quot;")}"></iframe>
</body></html>`);
  });

  constructor(private readonly validator: string) {}

  async start(): Promise<void> {
    this.origin = await listen(this.server);
  }

  /** Serve `bytes` unrestricted at `/control/<name>` (same origin as the page). */
  control(name: string, bytes: Uint8Array): string {
    this.controls.set(`/control/${name}`, bytes);
    return `${this.origin}/control/${name}`;
  }

  page(
    frame: string,
    fixture: Fixture | null,
    sandbox: string | null,
    options: { frameSrc?: string; generation?: string } = {},
  ): string {
    const query = new URLSearchParams({ frame });
    if (sandbox !== null) query.set("sandbox", sandbox);
    if (options.frameSrc) query.set("frameSrc", options.frameSrc);
    if (options.generation) query.set("generation", options.generation);
    if (fixture) {
      query.set("artifactId", fixture.artifactId);
      query.set("nonce", fixture.nonce);
    }
    return `${this.origin}/page?${query}`;
  }

  close(): void {
    this.server.close();
  }
}

/* ------------------------------ fixtures -------------------------------- */

export function doc(body: string, script: string): string {
  return `<!doctype html><html><head><title>probe</title></head><body>${body}<script>${script}</script></body></html>`;
}

export const SINK = "__SINK__";

/** Every network channel the policy closes; each hits a distinct sink path. */
export const NETWORK_SCRIPT = `
  const sink = ${JSON.stringify(SINK)};
  const attempt = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch {} };
  attempt(() => fetch(sink + "/fetch", { mode: "no-cors" }));
  attempt(() => { const x = new XMLHttpRequest(); x.open("GET", sink + "/xhr"); x.send(); });
  attempt(() => navigator.sendBeacon(sink + "/beacon", "x"));
  attempt(() => new EventSource(sink + "/eventsource"));
  attempt(() => new WebSocket(sink.replace("http", "ws") + "/websocket"));
  attempt(() => { new Image().src = sink + "/image"; });
  attempt(() => new FontFace("probe", "url(" + sink + "/font)").load());
  attempt(() => {
    const style = document.createElement("style");
    style.textContent = "@font-face{font-family:p2;src:url(" + sink + "/css-font)}" +
      "body{font-family:p2;background-image:url(" + sink + "/css-background)}";
    document.head.append(style);
    document.body.append("text");
  });
`;

export const NETWORK_PATHS = [
  "/fetch",
  "/xhr",
  "/beacon",
  "/eventsource",
  "/websocket",
  "/image",
  "/font",
  "/css-font",
  "/css-background",
];

export const FORM_SCRIPT = `
  const form = document.createElement("form");
  form.method = "POST";
  form.action = ${JSON.stringify(SINK)} + "/form";
  const field = document.createElement("input");
  field.name = "d";
  field.value = "x";
  form.append(field);
  document.body.append(form);
  try { form.submit(); } catch {}
`;

/** Navigation needs user activation for popups; each runs on a click. */
export const NAVIGATION_BODY = `<button id="popup">popup</button><button id="blank">blank</button>
<button id="top">top</button><button id="self">self</button><button id="refresh">refresh</button>`;

export const NAVIGATION_SCRIPT = `
  const sink = ${JSON.stringify(SINK)};
  // Each handler first reports that it ran (and whether the click carried
  // user activation), so a zero at the sink cannot come from a missed click.
  const on = (id, action) => document.getElementById(id).addEventListener("click", () => {
    const activated = Boolean(navigator.userActivation && navigator.userActivation.isActive);
    try { parent.postMessage({ probe: "clicked", id, activated }, "*"); } catch {}
    try { action(); } catch {}
  });
  on("popup", () => window.open(sink + "/popup"));
  on("blank", () => {
    const a = document.createElement("a"); a.href = sink + "/anchor-blank"; a.target = "_blank";
    document.body.append(a); a.click();
  });
  on("top", () => { window.top.location.href = sink + "/top"; });
  on("self", () => { location.href = sink + "/self"; });
  on("refresh", () => {
    const meta = document.createElement("meta"); meta.httpEquiv = "refresh";
    meta.content = "0;url=" + sink + "/meta-refresh"; document.head.append(meta);
  });
`;

export const DECOY = "__DECOY__";

/**
 * Every way a frame can navigate itself (plus a popup and a form), each on
 * its own button. The handler records that it ran in the frame's DOM (the
 * shell relays no probe messages) and acts on a short timer, so the
 * test's evaluation returns before the frame navigates away. The popup acts
 * synchronously to keep its user activation.
 */
export const SHELL_ATTACKS = [
  "refresh",
  "self",
  "replace",
  "data",
  "blob",
  "redirect",
  "decoy",
  "popup",
  "form",
] as const;

export type ShellAttack = (typeof SHELL_ATTACKS)[number] | "reload";

export const SHELL_NAVIGATION_SCRIPT = `
  const sink = ${JSON.stringify(SINK)};
  const decoy = ${JSON.stringify(DECOY)};
  const later = (fn) => setTimeout(() => { try { fn(); } catch {} }, 50);
  const refreshTo = (target) => '<meta http-equiv="refresh" content="0;url=' + target + '">';
  const actions = {
    refresh: () => later(() => {
      const meta = document.createElement("meta"); meta.httpEquiv = "refresh";
      meta.content = "0;url=" + sink + "/meta-refresh"; document.head.append(meta);
    }),
    self: () => later(() => { location.href = sink + "/self"; }),
    replace: () => later(() => { location.replace(sink + "/replace"); }),
    data: () => later(() => {
      location.href = "data:text/html," + encodeURIComponent(refreshTo(sink + "/data-refresh"));
    }),
    blob: () => later(() => {
      const blob = new Blob([refreshTo(sink + "/blob-refresh")], { type: "text/html" });
      location.href = URL.createObjectURL(blob);
    }),
    redirect: () => later(() => { location.href = sink + "/redirect"; }),
    decoy: () => later(() => { location.href = decoy; }),
    reload: () => later(() => { location.reload(); }),
    popup: () => { window.open(sink + "/popup"); },
    form: () => later(() => {
      const form = document.createElement("form");
      form.method = "POST"; form.action = sink + "/form";
      const field = document.createElement("input"); field.name = "d"; field.value = "x";
      form.append(field); document.body.append(form); form.submit();
    }),
  };
  for (const [id, action] of Object.entries(actions)) {
    const button = document.createElement("button");
    button.id = id; button.textContent = id;
    button.addEventListener("click", () => {
      document.body.dataset.clicked = id;
      try { action(); } catch {}
    });
    document.body.append(button);
  }
`;

export const ISOLATION_SCRIPT = `
  const out = [];
  const read = (name, fn) => { try { out.push(name + "=" + String(fn())); } catch (error) { out.push(name + "!" + (error && error.name)); } };
  read("parentDom", () => parent.document.getElementById("secret").textContent);
  read("parentVar", () => parent.secret);
  read("parentCookie", () => parent.document.cookie);
  read("parentStorage", () => parent.localStorage.getItem("canary"));
  read("cookie", () => document.cookie);
  read("storage", () => localStorage.getItem("canary"));
  read("session", () => sessionStorage.getItem("canary"));
  read("opener", () => window.opener);
  parent.postMessage({ probe: "isolation", out }, "*");
`;

export const EVAL_SCRIPT = `
  let result;
  try { result = String(eval("6 * 7")); } catch (error) { result = "refused:" + (error && error.name); }
  let fn;
  try { fn = String(new Function("return 7")()); } catch (error) { fn = "refused:" + (error && error.name); }
  parent.postMessage({ probe: "eval", result, fn }, "*");
`;

/** Bytes appended after preparation: their hashes are not in the policy. */
export const INJECTED =
  `<script>parent.postMessage({ probe: "injected-script" }, "*");</script>` +
  `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" ` +
  `onload="parent.postMessage({ probe: 'injected-attribute' }, '*')" ` +
  `onerror="parent.postMessage({ probe: 'injected-attribute' }, '*')">`;

/** Hostile and valid channel traffic, sent once the host's theme arrived. */
export function channelScript(artifactId: string): string {
  return `
  const id = ${JSON.stringify(artifactId)};
  let generation = null;
  window.addEventListener("message", (event) => {
    if (generation || !event.data || event.data.type !== "theme") return;
    generation = event.data.generation;
    const base = { channel: "orkestrator-artifact", v: 1 };
    const ids = { artifactId: id, revision: 1, generation };
    window.orkestratorArtifact.requestLink("https://example.com/docs", "Docs");
    document.body.style.minHeight = "900px";
    parent.postMessage({ ...base, type: "tool-call", tool: "bash", ...ids }, "*");
    parent.postMessage({ ...base, type: "prompt", text: "send this", ...ids }, "*");
    parent.postMessage({ ...base, type: "theme", appearance: "dark", ...ids }, "*");
    parent.postMessage({ ...base, type: "size", height: 300, ...ids, generation: "forged" }, "*");
    parent.postMessage({ ...base, type: "size", height: 300, extra: true, ...ids }, "*");
    parent.postMessage({ ...base, type: "link-request", url: "javascript:alert(1)", label: "x", ...ids }, "*");
    parent.postMessage({ ...base, type: "link-request", url: "https://user:pw@example.com/", label: "x", ...ids }, "*");
    parent.postMessage({ ...base, type: "size", height: 1e9, ...ids }, "*");
    parent.postMessage({ channel: "other", v: 1, type: "size", height: 1 }, "*");
    parent.postMessage({ ...base, v: 2, type: "size", height: 1, ...ids }, "*");
    parent.postMessage({ ...base, type: "size", height: 1, ...ids, padding: "x".repeat(20000) }, "*");
    parent.postMessage("plain string", "*");
  });
  `;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* ------------------------------- harness -------------------------------- */

export interface PageMessage {
  fromFrame: boolean;
  origin: string;
  data: unknown;
  verdict: string;
}

export async function messages(page: Page): Promise<PageMessage[]> {
  return (await page.evaluate(
    () => (window as unknown as { messages: unknown[] }).messages,
  )) as PageMessage[];
}

export async function waitForMessages(
  page: Page,
  predicate: string,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(`(window.messages || []).some((m) => ${predicate})`, undefined, {
    timeout,
  });
}

export function childFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error("no child frame");
  return frame;
}

/**
 * A real click (user activation) that is retried until the handler confirms
 * it ran. Under heavy parallel load Chromium occasionally drops input routed
 * to an out-of-process frame before its hit-test data is ready; a retry only
 * repeats the attempt, every sink assertion is unchanged.
 */
export async function realClick(
  frame: Frame,
  selector: string,
  ran: () => Promise<boolean>,
  attempts = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await frame.click(selector);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await ran()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

/** The artifact document's frame: the deepest frame (inside the shell when there is one). */
export function artifactFrame(page: Page): Frame {
  const frame = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame() && candidate.childFrames().length === 0);
  if (!frame) throw new Error("no artifact frame");
  return frame;
}

/** The shell's sandbox in the application page: scripts and its own (content) origin only. */
export const SHELL_SANDBOX = "allow-scripts allow-same-origin";

/** The privileges the policy withholds, granted to the unrestricted control. */
export const CONTROL_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-top-navigation allow-forms";

/** Per-engine observations recorded for docs/architecture/transcript-artifacts-runtime.md. */
export const report: Record<string, Record<string, unknown>> = {};

export let validatorBundle = "";

export let sink: Sink;

export let allowed: ParentApp;

export let denied: ParentApp;

export let content: LoopbackArtifactContentServer;

export const fixtures = new Map<string, Fixture>();

export let buildDir = "";

export function fixture(name: string): Fixture {
  const value = fixtures.get(name);
  if (!value) throw new Error(`no fixture ${name}`);
  return value;
}

export const SANDBOX = "allow-scripts";

/** The deliberately unrestricted control: same origin, no sandbox, no CSP. */
export const UNRESTRICTED = null;

export async function settle(page: Page, ms = 1_500): Promise<void> {
  await page.waitForTimeout(ms);
}

export async function waitUntil(condition: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function sinkHits(prefix?: string): string[] {
  return sink.hits.filter((hit) => !prefix || hit.includes(prefix));
}

/**
 * Sink hits on exactly these paths. Attempts observed at the same time each
 * target their own sink paths, so every hit stays attributable to one.
 */
export function pathHits(paths: readonly string[]): number {
  return sink.hits.filter((hit) => paths.includes(hit.split(" ")[1] ?? "")).length;
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The sink paths each navigation attempt reaches when it is not stopped. */
export const NAVIGATION_PATHS = {
  popup: ["/popup"],
  blank: ["/anchor-blank"],
  top: ["/top"],
  self: ["/self"],
  refresh: ["/meta-refresh"],
} as const satisfies Record<string, readonly string[]>;

/** The sink paths of each shell attack (the decoy is counted at its capability instead). */
export const SHELL_ATTACK_PATHS: Record<(typeof SHELL_ATTACKS)[number], readonly string[]> = {
  refresh: ["/meta-refresh"],
  self: ["/self"],
  replace: ["/replace"],
  data: ["/data-refresh"],
  blob: ["/blob-refresh"],
  redirect: ["/redirect", "/redirected"],
  decoy: [],
  popup: ["/popup"],
  form: ["/form"],
};

/** The engine named `name`, with a printed reason when its browser is not installed. */
export function enginesNamed(name: EngineSpec["name"]): EngineSpec[] {
  const matching = ENGINES.filter((engine) => engine.name === name);
  for (const engine of matching) {
    if (!engine.executablePath) {
      process.stderr.write(
        `[content-server.engines.test] ${engine.name} skipped: browser not installed (run \`bunx playwright install ${engine.name}\`)\n`,
      );
    }
  }
  return matching;
}

/**
 * Starts the servers and builds the fixtures the `engineName` parts share, once per test file,
 * and stops them afterwards. `onDecoyRequest` counts a request that reaches the decoy
 * capability (another document on the content origin); the part owns that count.
 */
export function registerEngineFixtures(engineName: string, onDecoyRequest: () => void): void {
  const anyEngine = ENGINES.some((engine) => engine.name === engineName && engine.executablePath);

  beforeAll(async () => {
    if (!anyEngine) return;
    buildDir = mkdtempSync(path.join(tmpdir(), "artifact-engines-"));
    const entry = path.join(buildDir, "validator-entry.ts");
    writeFileSync(
      entry,
      `import { parseArtifactFrameMessage } from ${JSON.stringify(PROTOCOL_SOURCE)};\n` +
        `(globalThis as unknown as { __artifactFrame: unknown }).__artifactFrame = { parse: parseArtifactFrameMessage };\n`,
    );
    const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" });
    if (!built.success || !built.outputs[0]) throw new Error("validator bundle failed");
    validatorBundle = await built.outputs[0].text();

    sink = new Sink();
    await sink.start();
    allowed = new ParentApp(validatorBundle);
    denied = new ParentApp(validatorBundle);
    await allowed.start();
    await denied.start();
    content = await LoopbackArtifactContentServer.start({ frameAncestors: [allowed.origin] });
    const preparer = new TranscriptInteractivePreparer({ frameAncestors: [allowed.origin] });

    // A second capability on the same content origin: the shell's path-exact
    // frame-src must keep the artifact frame from navigating to it.
    const decoyPrepared = await preparer.prepare({
      artifactId: "art_engdecoy01",
      revision: 1,
      html: doc("<p>decoy</p>", ""),
      dependencyIds: [],
      assets: [],
    });
    if (!decoyPrepared.ok) throw new Error("preparation of the decoy failed");
    const decoyBytes = new TextEncoder().encode(decoyPrepared.prepared.document);
    const decoy = content.mint({
      artifactId: "art_engdecoy01",
      revision: 1,
      preparedSha256: sha256(decoyBytes),
      contentSecurityPolicy: decoyPrepared.prepared.contentSecurityPolicy,
      load: async () => decoyBytes,
      authorize: async () => {
        onDecoyRequest();
        return true;
      },
    });

    const sources: Record<string, { html: string; inject?: string }> = {
      network: { html: doc("", NETWORK_SCRIPT) },
      form: { html: doc("", FORM_SCRIPT) },
      navigation: { html: doc(NAVIGATION_BODY, NAVIGATION_SCRIPT) },
      isolation: { html: doc("", ISOLATION_SCRIPT) },
      hash: { html: doc("<p>hash</p>", EVAL_SCRIPT), inject: INJECTED },
      channel: { html: doc("<p>channel</p>", channelScript("art_engchan01")) },
      shellNavigation: { html: doc("", SHELL_NAVIGATION_SCRIPT) },
    };
    let index = 0;
    for (const [name, source] of Object.entries(sources)) {
      const artifactId =
        name === "channel" ? "art_engchan01" : `art_eng${String(++index).padStart(6, "0")}`;
      const prepared = await preparer.prepare({
        artifactId,
        revision: 1,
        html: source.html.replaceAll(SINK, sink.origin).replaceAll(DECOY, decoy.url),
        dependencyIds: [],
        assets: [],
      });
      if (!prepared.ok) {
        throw new Error(`preparation of ${name} failed: ${JSON.stringify(prepared.diagnostics)}`);
      }
      let document = prepared.prepared.document;
      if (source.inject) document = document.replace("</body>", `${source.inject}</body>`);
      const bytes = new TextEncoder().encode(document);
      const capability = content.mint({
        artifactId,
        revision: 1,
        preparedSha256: sha256(bytes),
        contentSecurityPolicy: prepared.prepared.contentSecurityPolicy,
        load: async () => bytes,
      });
      fixtures.set(name, {
        artifactId,
        nonce: prepared.prepared.readinessNonce,
        url: capability.url,
        shellUrl: capability.shellUrl,
        generation: capability.generation,
        bytes,
      });
    }
  });

  afterAll(async () => {
    if (!anyEngine) return;
    sink.close();
    allowed.close();
    denied.close();
    await content.close();
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
    // Content-free observations per engine (versions, verdicts, counts).
    const summary = JSON.stringify(report, null, 2);
    // Each engine part reports only its own engine, so merge into what its siblings wrote.
    const reportFile = process.env.ARTIFACT_ENGINE_REPORT;
    if (reportFile)
      writeFileSync(reportFile, JSON.stringify(mergedEngineReport(reportFile), null, 2));
    process.stderr.write(`[content-server.engines.test] results\n${summary}\n`);
  });
}

/** What this part's `report` adds to the report file its sibling parts already wrote. */
function mergedEngineReport(reportFile: string): Record<string, Record<string, unknown>> {
  let existing: Record<string, Record<string, unknown>> = {};
  try {
    existing = JSON.parse(readFileSync(reportFile, "utf8")) as typeof existing;
  } catch {
    // No sibling has written it yet.
  }
  const merged = { ...existing };
  for (const [name, results] of Object.entries(report))
    merged[name] = { ...merged[name], ...results };
  return merged;
}

/**
 * One engine's browser for one part: launched before its tests and closed after them, with the
 * helpers that open pages in it. `resetDecoyRequests` zeroes the part's decoy count along with
 * the sink.
 */
export function useEngineBrowser(
  engine: EngineSpec,
  resetDecoyRequests: () => void,
): {
  open: (url: string) => Promise<Page>;
  resetObservations: () => Promise<void>;
  openIsolated: (url: string) => Promise<{ context: BrowserContext; page: Page }>;
  closeIsolated: () => Promise<void>;
  results: Record<string, unknown>;
} {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const results: Record<string, unknown> = {};

  // A cold browser launch on a CI runner takes longer than Bun's 5 s default
  // hook timeout (flake 0507); the tests themselves already allow 60 s.
  beforeAll(async () => {
    if (!engine.executablePath) return;
    browser = await engine.type.launch({
      headless: true,
      ...(engine.name === "chromium" ? { executablePath: engine.executablePath } : {}),
      // Firefox's own UI fetches a page's /favicon.ico, sometimes after the
      // page's context has closed, so the request lands in a later
      // observation (flake 0697). It is the browser's request, not the
      // document's, so the policy cannot govern it; switch it off instead of
      // ignoring sink hits.
      ...(engine.name === "firefox"
        ? { firefoxUserPrefs: { "browser.chrome.site_icons": false } }
        : {}),
    });
    results.version = browser.version();
    report[engine.name] = results;
  }, 60_000);
  /** Contexts opened by `openIsolated`, closed by `closeIsolated`. */
  const isolated: BrowserContext[] = [];
  afterAll(async () => {
    await closeIsolated();
    await context?.close();
    await browser?.close();
  });

  async function open(url: string): Promise<Page> {
    await context?.close();
    context = await browser!.newContext();
    const page = await context.newPage();
    await page.goto(url);
    return page;
  }

  /**
   * Closes the shared context and empties the sink (and decoy count), in
   * that order, so a late request from an earlier page (a control's
   * favicon) cannot be counted against the next observation.
   */
  async function resetObservations(): Promise<void> {
    await context?.close();
    context = undefined;
    sink.reset();
    resetDecoyRequests();
  }

  /**
   * A page in a context of its own, so several attempts can be observed at
   * once: each has its own windows (popups) and activation.
   */
  async function openIsolated(url: string): Promise<{ context: BrowserContext; page: Page }> {
    const own = await browser!.newContext();
    isolated.push(own);
    const page = await own.newPage();
    await page.goto(url);
    return { context: own, page };
  }

  async function closeIsolated(): Promise<void> {
    await Promise.all(isolated.splice(0).map((own) => own.close().catch(() => undefined)));
  }

  return { open, resetObservations, openIsolated, closeIsolated, results };
}
