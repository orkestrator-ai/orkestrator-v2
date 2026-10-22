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
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Frame,
  type Page,
} from "playwright-core";

import { resolveDesignChromiumPath } from "../design/index.js";
import { LoopbackArtifactContentServer } from "./content-server.js";
import { TranscriptInteractivePreparer } from "./interactive-prepare.js";

const CANARY = `canary${Math.random().toString(36).slice(2, 12)}`;
const GENERATION = "gen-engine-qualification";
const PROTOCOL_SOURCE = path.resolve(
  import.meta.dir,
  "../../../../../packages/protocol/src/artifact-frame-channel.ts",
);

interface EngineSpec {
  name: "chromium" | "firefox" | "webkit";
  type: BrowserType;
  executablePath: string | null;
}

function installed(type: BrowserType): string | null {
  try {
    const executable = type.executablePath();
    return existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

const ENGINES: EngineSpec[] = [
  {
    name: "chromium",
    type: chromium,
    // The shipped desktop engine is Chromium; prefer the configured browser.
    executablePath: resolveDesignChromiumPath() ?? installed(chromium),
  },
  { name: "firefox", type: firefox, executablePath: installed(firefox) },
  { name: "webkit", type: webkit, executablePath: installed(webkit) },
];
for (const engine of ENGINES) {
  if (!engine.executablePath) {
    console.warn(
      `[content-server.engines.test] ${engine.name} skipped: browser not installed (run \`bunx playwright install ${engine.name}\`)`,
    );
  }
}

/* ----------------------------- local servers ----------------------------- */

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

/** Records every request and WebSocket upgrade it receives (path only). */
class Sink {
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
    response.end("<!doctype html><title>sink</title>");
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

interface Fixture {
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
class ParentApp {
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

function doc(body: string, script: string): string {
  return `<!doctype html><html><head><title>probe</title></head><body>${body}<script>${script}</script></body></html>`;
}

const SINK = "__SINK__";

/** Every network channel the policy closes; each hits a distinct sink path. */
const NETWORK_SCRIPT = `
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
const NETWORK_PATHS = [
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

const FORM_SCRIPT = `
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
const NAVIGATION_BODY = `<button id="popup">popup</button><button id="blank">blank</button>
<button id="top">top</button><button id="self">self</button><button id="refresh">refresh</button>`;
const NAVIGATION_SCRIPT = `
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

const DECOY = "__DECOY__";

/**
 * Every way a frame can navigate itself (plus a popup and a form), each on
 * its own button. The handler records that it ran in the frame's DOM (the
 * shell relays no probe messages) and acts on a short timer, so the
 * test's evaluation returns before the frame navigates away. The popup acts
 * synchronously to keep its user activation.
 */
const SHELL_ATTACKS = [
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
type ShellAttack = (typeof SHELL_ATTACKS)[number] | "reload";
const SHELL_NAVIGATION_SCRIPT = `
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

const ISOLATION_SCRIPT = `
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

const EVAL_SCRIPT = `
  let result;
  try { result = String(eval("6 * 7")); } catch (error) { result = "refused:" + (error && error.name); }
  let fn;
  try { fn = String(new Function("return 7")()); } catch (error) { fn = "refused:" + (error && error.name); }
  parent.postMessage({ probe: "eval", result, fn }, "*");
`;
/** Bytes appended after preparation: their hashes are not in the policy. */
const INJECTED =
  `<script>parent.postMessage({ probe: "injected-script" }, "*");</script>` +
  `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" ` +
  `onload="parent.postMessage({ probe: 'injected-attribute' }, '*')" ` +
  `onerror="parent.postMessage({ probe: 'injected-attribute' }, '*')">`;

/** Hostile and valid channel traffic, sent once the host's theme arrived. */
function channelScript(artifactId: string): string {
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* ------------------------------- harness -------------------------------- */

interface PageMessage {
  fromFrame: boolean;
  origin: string;
  data: unknown;
  verdict: string;
}

async function messages(page: Page): Promise<PageMessage[]> {
  return (await page.evaluate(
    () => (window as unknown as { messages: unknown[] }).messages,
  )) as PageMessage[];
}

async function waitForMessages(page: Page, predicate: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(`(window.messages || []).some((m) => ${predicate})`, undefined, {
    timeout,
  });
}

function childFrame(page: Page): Frame {
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
async function realClick(
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
function artifactFrame(page: Page): Frame {
  const frame = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame() && candidate.childFrames().length === 0);
  if (!frame) throw new Error("no artifact frame");
  return frame;
}

/** The shell's sandbox in the application page: scripts and its own (content) origin only. */
const SHELL_SANDBOX = "allow-scripts allow-same-origin";
/** The privileges the policy withholds, granted to the unrestricted control. */
const CONTROL_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-top-navigation allow-forms";

/** Per-engine observations recorded for docs/architecture/transcript-artifacts-runtime.md. */
const report: Record<string, Record<string, unknown>> = {};

let validatorBundle = "";
let sink: Sink;
let allowed: ParentApp;
let denied: ParentApp;
let content: LoopbackArtifactContentServer;
const fixtures = new Map<string, Fixture>();
/** Requests that reached the decoy capability (another document on the content origin). */
let decoyRequests = 0;
let buildDir = "";

const anyEngine = ENGINES.some((engine) => engine.executablePath);

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
      decoyRequests += 1;
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
  if (process.env.ARTIFACT_ENGINE_REPORT)
    writeFileSync(process.env.ARTIFACT_ENGINE_REPORT, summary);
  process.stderr.write(`[content-server.engines.test] results\n${summary}\n`);
});

function fixture(name: string): Fixture {
  const value = fixtures.get(name);
  if (!value) throw new Error(`no fixture ${name}`);
  return value;
}

const SANDBOX = "allow-scripts";
/** The deliberately unrestricted control: same origin, no sandbox, no CSP. */
const UNRESTRICTED = null;

async function settle(page: Page, ms = 1_500): Promise<void> {
  await page.waitForTimeout(ms);
}

async function waitUntil(condition: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sinkHits(prefix?: string): string[] {
  return sink.hits.filter((hit) => !prefix || hit.includes(prefix));
}

/**
 * Sink hits on exactly these paths. Attempts observed at the same time each
 * target their own sink paths, so every hit stays attributable to one.
 */
function pathHits(paths: readonly string[]): number {
  return sink.hits.filter((hit) => paths.includes(hit.split(" ")[1] ?? "")).length;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The sink paths each navigation attempt reaches when it is not stopped. */
const NAVIGATION_PATHS = {
  popup: ["/popup"],
  blank: ["/anchor-blank"],
  top: ["/top"],
  self: ["/self"],
  refresh: ["/meta-refresh"],
} as const satisfies Record<string, readonly string[]>;

/** The sink paths of each shell attack (the decoy is counted at its capability instead). */
const SHELL_ATTACK_PATHS: Record<(typeof SHELL_ATTACKS)[number], readonly string[]> = {
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

for (const engine of ENGINES) {
  const engineTest = engine.executablePath ? test : test.skip;

  describe(`executable document policy in ${engine.name}`, () => {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    const results: Record<string, unknown> = {};

    beforeAll(async () => {
      if (!engine.executablePath) return;
      browser = await engine.type.launch({
        headless: true,
        ...(engine.name === "chromium" ? { executablePath: engine.executablePath } : {}),
      });
      results.version = browser.version();
      report[engine.name] = results;
    });
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
      decoyRequests = 0;
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

    engineTest(
      "loads only in a permitted ancestor; refused by any other (frame-ancestors)",
      async () => {
        const target = fixture("isolation");
        const page = await open(allowed.page(target.url, target, SANDBOX));
        await waitForMessages(page, `m.verdict === "ready"`);
        const ready = (await messages(page)).find((message) => message.verdict === "ready")!;
        expect(ready).toMatchObject({ fromFrame: true, origin: "null" });

        const refused = await open(denied.page(target.url, target, SANDBOX));
        await settle(refused, 2_000);
        expect(await messages(refused)).toEqual([]);
        results.frameAncestors = "refused outside the permitted ancestor";
      },
      60_000,
    );

    engineTest(
      "an inline script or handler whose hash is not in the policy never runs; eval is refused",
      async () => {
        const target = fixture("hash");
        // Control: the same bytes without the policy run the injected code.
        const control = await open(
          allowed.page(allowed.control(`hash-${engine.name}`, target.bytes), null, UNRESTRICTED),
        );
        await waitForMessages(control, `m.data && m.data.probe === "injected-script"`);
        await waitForMessages(control, `m.data && m.data.probe === "injected-attribute"`);
        const controlEval = (await messages(control)).find(
          (message) => (message.data as { probe?: string })?.probe === "eval",
        );
        expect(controlEval?.data).toMatchObject({ result: "42", fn: "7" });

        const page = await open(allowed.page(target.url, target, SANDBOX));
        await waitForMessages(page, `m.data && m.data.probe === "eval"`);
        await settle(page);
        const probes = (await messages(page)).map(
          (message) => (message.data as { probe?: string })?.probe,
        );
        expect(probes).not.toContain("injected-script");
        expect(probes).not.toContain("injected-attribute");
        const evaluated = (await messages(page)).find(
          (message) => (message.data as { probe?: string })?.probe === "eval",
        )!.data as { result: string; fn: string };
        expect(evaluated.result.startsWith("refused:")).toBe(true);
        expect(evaluated.fn.startsWith("refused:")).toBe(true);
        results.scriptHashes = { injectedBlocked: true, eval: evaluated.result, fn: evaluated.fn };
      },
      60_000,
    );

    engineTest(
      "network, image, font and WebSocket attempts reach the sink zero times",
      async () => {
        const target = fixture("network");
        sink.reset();
        await open(
          allowed.page(allowed.control(`network-${engine.name}`, target.bytes), null, UNRESTRICTED),
        );
        const reachedPaths = () =>
          NETWORK_PATHS.filter((sinkPath) =>
            sink.hits.some((hit) => hit.split(" ")[1] === sinkPath),
          );
        // A positive observation: stop as soon as every channel has arrived,
        // else after the full window (a channel the engine never attempts).
        await waitUntil(() => reachedPaths().length === NETWORK_PATHS.length, 2_500).catch(
          () => undefined,
        );
        const reached = reachedPaths();
        results.networkControlReached = reached;
        // The unrestricted control proves the sink observes every channel the
        // engine implements (a channel the engine never attempts is noted).
        expect(reached).toEqual(
          expect.arrayContaining(["/fetch", "/xhr", "/websocket", "/image", "/font"]),
        );

        sink.reset();
        const page = await open(allowed.page(target.url, target, SANDBOX));
        await waitForMessages(page, `m.verdict === "ready"`);
        await settle(page, 2_500);
        expect(sink.hits).toEqual([]);
        results.networkRestrictedHits = sink.hits.length;
      },
      60_000,
    );

    engineTest(
      "form submission reaches the sink zero times",
      async () => {
        const target = fixture("form");
        sink.reset();
        const control = await open(
          allowed.page(allowed.control(`form-${engine.name}`, target.bytes), null, UNRESTRICTED),
        );
        await waitUntil(() => sinkHits("/form").length > 0);
        await settle(control, 500);
        expect(sinkHits("POST /form").length).toBeGreaterThan(0);

        sink.reset();
        const page = await open(allowed.page(target.url, target, SANDBOX));
        await waitForMessages(page, `m.verdict === "ready"`);
        await settle(page, 2_000);
        expect(sink.hits).toEqual([]);
        results.form = "blocked";
      },
      60_000,
    );

    engineTest(
      "popups, new-window links and top navigation reach the sink zero times",
      async () => {
        const target = fixture("navigation");
        const attempts = ["popup", "blank", "top"] as const;
        const control: Record<string, number> = {};
        for (const attempt of attempts) {
          sink.reset();
          const page = await open(
            allowed.page(
              allowed.control(`navigation-${engine.name}`, target.bytes),
              null,
              // The control grants the navigation privileges the policy withholds.
              "allow-scripts allow-same-origin allow-popups allow-top-navigation allow-forms",
            ),
          );
          await page.waitForLoadState("load");
          await childFrame(page).click(`#${attempt}`);
          // A positive observation: done once this attempt's own path arrived.
          await waitUntil(() => pathHits(NAVIGATION_PATHS[attempt]) > 0, 10_000).catch(
            () => undefined,
          );
          control[attempt] = pathHits(NAVIGATION_PATHS[attempt]);
        }
        results.navigationControl = control;
        for (const attempt of attempts) expect(control[attempt]).toBeGreaterThan(0);

        // Every attempt at once, each in its own context and on its own sink path.
        try {
          await resetObservations();
          const opened = await Promise.all(
            attempts.map(async (attempt) => {
              const { context: own, page } = await openIsolated(
                allowed.page(target.url, target, SANDBOX),
              );
              await waitForMessages(page, `m.verdict === "ready"`);
              // The handler ran on a real click (activation where the engine reports it).
              const clicked = await realClick(childFrame(page), `#${attempt}`, async () =>
                (await messages(page)).some(
                  (message) =>
                    (message.data as { probe?: string; id?: string })?.probe === "clicked" &&
                    (message.data as { id?: string }).id === attempt,
                ),
              );
              expect(clicked).toBe(true);
              return { attempt, context: own, page };
            }),
          );
          // One no-hit window after the last click: every attempt gets at least its full window.
          await pause(1_500);
          const restricted: Record<string, number> = {};
          for (const { attempt, context: own, page } of opened) {
            restricted[attempt] = pathHits(NAVIGATION_PATHS[attempt]);
            expect(page.url().startsWith(allowed.origin)).toBe(true);
            expect(own.pages()).toHaveLength(1);
          }
          results.navigationRestricted = restricted;
          for (const attempt of attempts) expect(restricted[attempt]).toBe(0);
          // Nothing reached the sink on any path.
          expect(sink.hits).toEqual([]);
        } finally {
          await closeIsolated();
        }
      },
      90_000,
    );

    engineTest(
      "self-navigation of the frame: not prevented by the document's policy; the application's frame-src stops it",
      async () => {
        const target = fixture("navigation");
        // Both attempts at once, each in its own context and on its own sink path.
        const observe = async (frameSrc?: string) => {
          try {
            await resetObservations();
            const opened = await Promise.all(
              (["self", "refresh"] as const).map(async (attempt) => {
                const { context: own, page } = await openIsolated(
                  allowed.page(target.url, target, SANDBOX, frameSrc ? { frameSrc } : {}),
                );
                await waitForMessages(page, `m.verdict === "ready"`);
                // Self-navigation needs no user activation; a DOM click does not
                // depend on routing real input into the out-of-process frame.
                await childFrame(page).evaluate(
                  (id) => document.getElementById(id)?.click(),
                  attempt,
                );
                await waitForMessages(
                  page,
                  `m.data && m.data.probe === "clicked" && m.data.id === "${attempt}"`,
                );
                return { attempt, context: own, page };
              }),
            );
            // One window after the last click: each attempt gets at least its full window.
            if (frameSrc) await pause(2_500);
            else
              await waitUntil(
                () => opened.every(({ attempt }) => pathHits(NAVIGATION_PATHS[attempt]) > 0),
                5_000,
              ).catch(() => undefined);
            const observed: Record<string, number> = {};
            for (const { attempt, context: own, page } of opened) {
              observed[attempt] = pathHits(NAVIGATION_PATHS[attempt]);
              // Whatever the frame loads stays inside the sandboxed frame.
              expect(page.url().startsWith(allowed.origin)).toBe(true);
              expect(own.pages()).toHaveLength(1);
            }
            return { observed, total: sink.hits.length };
          } finally {
            await closeIsolated();
          }
        };
        // The document's own CSP has no navigation directive (navigate-to was
        // never shipped) and the sandbox allows a frame to navigate itself, so
        // this is recorded rather than asserted: at least the meta refresh
        // reaches the sink in every engine.
        const unrestricted = await observe();
        results.selfNavigationReachedSink = unrestricted.observed;
        expect(unrestricted.observed.refresh).toBeGreaterThan(0);
        // The embedding page's `frame-src` governs what its frames may load.
        const contained = await observe(new URL(target.url).origin);
        results.selfNavigationWithParentFrameSrc = contained.observed;
        expect(contained.observed).toEqual({ self: 0, refresh: 0 });
        expect(contained.total).toBe(0);
      },
      90_000,
    );

    engineTest(
      "the frame cannot read the parent's DOM, cookies or storage, nor its own",
      async () => {
        const target = fixture("isolation");
        const control = await open(
          allowed.page(
            allowed.control(`isolation-${engine.name}`, target.bytes),
            null,
            UNRESTRICTED,
          ),
        );
        await waitForMessages(control, `m.data && m.data.probe === "isolation"`);
        const controlOut = (
          (await messages(control)).find(
            (message) => (message.data as { probe?: string })?.probe === "isolation",
          )!.data as { out: string[] }
        ).out;
        // The unrestricted control does read every canary.
        for (const name of [
          "parentDom",
          "parentVar",
          "parentCookie",
          "parentStorage",
          "cookie",
          "storage",
        ]) {
          expect(controlOut.find((entry) => entry.startsWith(`${name}=`))).toContain(CANARY);
        }

        for (const sandbox of [SANDBOX, null]) {
          const page = await open(allowed.page(target.url, target, sandbox));
          await waitForMessages(page, `m.data && m.data.probe === "isolation"`);
          const all = await messages(page);
          const out = (
            all.find((message) => (message.data as { probe?: string })?.probe === "isolation")!
              .data as { out: string[] }
          ).out;
          expect(JSON.stringify(all)).not.toContain(CANARY);
          expect(sink.hits.join(" ")).not.toContain(CANARY);
          for (const name of ["parentDom", "parentVar", "parentCookie", "parentStorage"]) {
            expect(out.find((entry) => entry.startsWith(name))).toMatch(new RegExp(`^${name}!`));
          }
          // Opaque origin: no cookie jar or storage of its own.
          const own = out.filter((entry) => /^(cookie|storage|session)[=!]/.test(entry));
          for (const entry of own) expect(entry === "cookie=" || entry.includes("!")).toBe(true);
          results[sandbox ? "isolationWithSandboxAttribute" : "isolationWithoutSandboxAttribute"] =
            out;
        }
      },
      60_000,
    );

    engineTest(
      "the header's CSP sandbox applies without an iframe sandbox attribute",
      async () => {
        const target = fixture("isolation");
        // Control: the same bytes unsandboxed run with a real origin.
        const control = await open(
          allowed.page(
            allowed.control(`sandbox-${engine.name}`, target.bytes),
            target,
            UNRESTRICTED,
          ),
        );
        await waitForMessages(control, `m.verdict === "ready"`);
        expect(
          (await messages(control)).find((message) => message.verdict === "ready")!.origin,
        ).toBe(allowed.origin);

        const page = await open(allowed.page(target.url, target, null));
        await waitForMessages(page, `m.verdict === "ready"`);
        const ready = (await messages(page)).find((message) => message.verdict === "ready")!;
        expect(ready.origin).toBe("null");
        results.cspSandboxWithoutAttribute = "opaque origin (null)";
      },
      60_000,
    );

    engineTest(
      "only ready, size and link-request pass the validator; the runtime accepts the host's theme",
      async () => {
        const target = fixture("channel");
        const page = await open(allowed.page(target.url, target, SANDBOX));
        await waitForMessages(page, `m.verdict === "link-request"`);
        await waitForMessages(page, `m.verdict === "size"`);
        await settle(page, 1_000);
        const all = (await messages(page)).filter((message) => message.fromFrame);
        const accepted = new Set(
          all.filter((message) => !message.verdict.startsWith("rejected:")).map((m) => m.verdict),
        );
        expect([...accepted].sort()).toEqual(["link-request", "ready", "size"]);
        const accept = all.filter((message) => !message.verdict.startsWith("rejected:"));
        // Every accepted size/link carries the host's generation and identity.
        for (const message of accept) {
          if (message.verdict === "ready") continue;
          expect(message.data).toMatchObject({
            artifactId: target.artifactId,
            revision: 1,
            generation: GENERATION,
          });
        }
        const rejected = all
          .filter((message) => message.verdict.startsWith("rejected:"))
          .map((message) => message.verdict);
        expect(rejected).toEqual(
          expect.arrayContaining([
            "rejected:unknown-type",
            "rejected:identity-mismatch",
            "rejected:bad-shape",
            "rejected:wrong-channel",
            "rejected:wrong-version",
            "rejected:too-large",
            "rejected:not-object",
          ]),
        );
        // tool-call, prompt and a frame-sent theme are unknown types.
        expect(rejected.filter((verdict) => verdict === "rejected:unknown-type")).toHaveLength(3);
        // The real runtime applied the host's theme inside the frame.
        const theme = await childFrame(page).evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          accent: document.documentElement.style.getPropertyValue("--accent"),
        }));
        expect(theme).toEqual({ theme: "dark", accent: "#123456" });
        results.channel = { accepted: [...accepted].sort(), rejected: rejected.length };
      },
      60_000,
    );
    /** Click one attack button in the artifact frame; returns the id the handler recorded. */
    async function trigger(page: Page, attack: ShellAttack): Promise<string | null> {
      const frame = artifactFrame(page);
      if (attack === "popup") {
        // A real click, so the popup has user activation where the engine requires it.
        await realClick(
          frame,
          "#popup",
          async () => (await frame.evaluate(() => document.body.dataset.clicked ?? null)) !== null,
        );
        return frame.evaluate(() => document.body.dataset.clicked ?? null);
      }
      return frame.evaluate((id) => {
        document.getElementById(id)?.click();
        return document.body.dataset.clicked ?? null;
      }, attack);
    }

    function disposals(all: PageMessage[]): string[] {
      return all
        .filter((message) => (message.data as { type?: string })?.type === "shell-disposed")
        .map((message) => (message.data as { reason: string }).reason);
    }

    engineTest(
      "through the shell, every self-navigation, popup, form and redirect reaches the sink zero times",
      async () => {
        const target = fixture("shellNavigation");
        const reach = () => sink.hits.length + decoyRequests;
        /** Reach of one attack: its own sink paths (and the decoy capability for the decoy). */
        const reachOf = (attack: (typeof SHELL_ATTACKS)[number]) =>
          pathHits(SHELL_ATTACK_PATHS[attack]) + (attack === "decoy" ? decoyRequests : 0);
        const run = async (mode: "control" | "direct" | "shell") => {
          const observed: Record<string, number> = {};
          const disposed: Record<string, string[]> = {};
          if (mode === "control") {
            // Positive observations, one at a time: each stops once it reached a sink.
            for (const attack of SHELL_ATTACKS) {
              sink.reset();
              decoyRequests = 0;
              const page = await open(
                allowed.page(
                  allowed.control(`shell-navigation-${engine.name}`, target.bytes),
                  null,
                  CONTROL_SANDBOX,
                ),
              );
              await waitForMessages(page, `m.verdict === "ready"`);
              // The handler ran (on a real click for the popup).
              expect(await trigger(page, attack)).toBe(attack);
              await waitUntil(() => reach() > 0, 5_000).catch(() => {});
              observed[attack] = reach();
            }
            return { observed, disposed, total: 0 };
          }
          // Every attack at once, each in its own context and on its own sink
          // path (or the decoy capability), so each hit names its attack.
          try {
            await resetObservations();
            const url =
              mode === "direct"
                ? allowed.page(target.url, target, SANDBOX)
                : allowed.page(target.shellUrl, target, SHELL_SANDBOX, {
                    generation: target.generation,
                  });
            const opened = await Promise.all(
              SHELL_ATTACKS.map(async (attack) => {
                const { context: own, page } = await openIsolated(url);
                await waitForMessages(page, `m.verdict === "ready"`);
                // The handler ran (on a real click for the popup).
                expect(await trigger(page, attack)).toBe(attack);
                return { attack, context: own, page };
              }),
            );
            // One no-hit window after the last trigger: every attack gets at least its full window.
            await pause(2_000);
            for (const { attack, context: own, page } of opened) {
              observed[attack] = reachOf(attack);
              if (mode === "shell") {
                disposed[attack] = disposals(await messages(page));
                // Whatever happened stayed inside the frame: same page, no new window.
                expect(page.url().startsWith(allowed.origin)).toBe(true);
                expect(own.pages()).toHaveLength(1);
              }
            }
            return { observed, disposed, total: reach() };
          } finally {
            await closeIsolated();
          }
        };
        // Control: same bytes, no policy, same origin as the page, with the
        // withheld sandbox privileges: every attack reaches its sink.
        const control = await run("control");
        results.shellAttackControl = control.observed;
        for (const attack of SHELL_ATTACKS) expect(control.observed[attack]).toBeGreaterThan(0);
        // The document framed directly by the page (browser mode before the
        // shell): its own policy stops the popup and the form only.
        const direct = await run("direct");
        results.shellAttackWithoutShell = direct.observed;
        expect(direct.observed.refresh).toBeGreaterThan(0);
        // Through the shell: nothing reaches any sink.
        const shell = await run("shell");
        results.shellAttackThroughShell = shell.observed;
        results.shellAttackDisposals = shell.disposed;
        for (const attack of SHELL_ATTACKS) expect(shell.observed[attack]).toBe(0);
        // Nor did anything reach the sink or the decoy on any other path.
        expect(shell.total).toBe(0);
        // Every attempted frame navigation also disposed the frame (the reason
        // depends on whether the engine reports the violation or loads an
        // error page); the popup and the form never navigated the frame.
        for (const attack of SHELL_ATTACKS) {
          if (attack === "popup" || attack === "form") expect(shell.disposed[attack]).toEqual([]);
          else expect(shell.disposed[attack]).toHaveLength(1);
        }
      },
      240_000,
    );

    engineTest(
      "through the shell, an unexpected load disposes the frame and notifies the host",
      async () => {
        const target = fixture("shellNavigation");
        const page = await open(
          allowed.page(target.shellUrl, target, SHELL_SANDBOX, { generation: target.generation }),
        );
        await waitForMessages(page, `m.verdict === "ready"`);
        // Reloading its own (permitted) URL is the one navigation frame-src allows.
        expect(await trigger(page, "reload")).toBe("reload");
        await waitForMessages(page, `m.data && m.data.type === "shell-disposed"`);
        const all = await messages(page);
        expect(disposals(all)).toEqual(["unexpected-load"]);
        expect(all.find((message) => message.verdict === "ready")).toMatchObject({
          fromFrame: true,
          origin: new URL(target.shellUrl).origin,
        });
        // The shell tore the artifact frame down.
        await page.waitForFunction(
          () => document.querySelector("iframe")?.contentWindow?.frames.length === 0,
          undefined,
          { timeout: 5_000 },
        );
        expect(page.frames()).toHaveLength(2);
        results.shellUnexpectedLoad = disposals(all);
      },
      60_000,
    );

    engineTest(
      "through the shell, the channel works: ready, size and link-request out, theme in",
      async () => {
        const target = fixture("channel");
        const page = await open(
          allowed.page(target.shellUrl, target, SHELL_SANDBOX, { generation: target.generation }),
        );
        await waitForMessages(page, `m.verdict === "link-request"`);
        await waitForMessages(page, `m.verdict === "size"`);
        await settle(page, 1_000);
        const all = (await messages(page)).filter((message) => message.fromFrame);
        // The relay dropped every hostile message: the host saw only valid ones.
        expect(
          all.map((message) => message.verdict).filter((v) => v.startsWith("rejected:")),
        ).toEqual([]);
        expect(Array.from(new Set(all.map((message) => message.verdict))).sort()).toEqual([
          "link-request",
          "ready",
          "size",
        ]);
        const contentOrigin = new URL(target.shellUrl).origin;
        for (const message of all) {
          expect(message.origin).toBe(contentOrigin);
          if (message.verdict === "ready") continue;
          expect(message.data).toMatchObject({
            artifactId: target.artifactId,
            revision: 1,
            generation: target.generation,
          });
        }
        expect(all.find((message) => message.verdict === "link-request")?.data).toMatchObject({
          url: "https://example.com/docs",
          label: "Docs",
        });
        // The host's theme reached the real runtime through the shell.
        const theme = await artifactFrame(page).evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          accent: document.documentElement.style.getPropertyValue("--accent"),
        }));
        expect(theme).toEqual({ theme: "dark", accent: "#123456" });
        // Neither frame can reach its parent: the artifact is opaque, the shell cross-site.
        const reads = async (frame: Frame) =>
          frame.evaluate(() => {
            try {
              return String(parent.document.title);
            } catch (error) {
              return `denied:${(error as Error).name}`;
            }
          });
        expect(await reads(artifactFrame(page))).toBe("denied:SecurityError");
        const shellFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!;
        expect(await reads(shellFrame)).toBe("denied:SecurityError");
        results.shellChannel = Array.from(new Set(all.map((message) => message.verdict))).sort();
      },
      60_000,
    );

    engineTest(
      "the shell is refused by a non-permitted ancestor and frames nothing at the top level",
      async () => {
        const target = fixture("isolation");
        const refused = await open(
          denied.page(target.shellUrl, target, SHELL_SANDBOX, { generation: target.generation }),
        );
        await settle(refused, 2_000);
        expect(await messages(refused)).toEqual([]);
        expect(refused.frames().length).toBeLessThanOrEqual(2);

        const top = await open(target.shellUrl);
        await settle(top, 1_000);
        expect(top.frames()).toHaveLength(1);
        results.shellAncestors = "refused outside the permitted ancestor; no frame at top level";
      },
      60_000,
    );
  });
}
