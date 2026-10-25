import { createHash } from "node:crypto";
import { FRAME_CHANNEL_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { ARTIFACT_FRAME_CHANNEL } from "@orkestrator/protocol/artifact-frame-channel";

/**
 * The trusted viewer shell for live interactive artifacts.
 *
 * The shell is a fixed document owned by the main process and served only on
 * the private session of one live host, from a dedicated custom scheme. It
 * embeds the artifact in an opaque-origin `sandbox="allow-scripts"` iframe and
 * relays exactly the presentation messages. It has no preload and no bridge:
 * the main process pulls validated frame messages with a long-poll
 * (`mainFrame.executeJavaScript`) and pushes theme messages the same way. The
 * artifact frame is cross-origin to the shell and cannot reach its globals.
 *
 * The scheme must be registered as a standard scheme before `app` is ready
 * (see `ARTIFACT_SHELL_SCHEME_PRIVILEGES`) so the shell has a tuple origin
 * the content server's `frame-ancestors` can name. It is deliberately not
 * `secure`, so a plain-HTTP loopback/remote content origin is not mixed content.
 */
export const ARTIFACT_SHELL_SCHEME = "orkestrator-artifact-shell";
export const ARTIFACT_SHELL_HOST = "viewer";
export const ARTIFACT_SHELL_ORIGIN = `${ARTIFACT_SHELL_SCHEME}://${ARTIFACT_SHELL_HOST}`;
export const ARTIFACT_SHELL_URL = `${ARTIFACT_SHELL_ORIGIN}/shell.html`;
/** Main-world global the shell defines for main-process calls (never visible to the frame). */
export const ARTIFACT_SHELL_GLOBAL = "__orkestratorArtifactShell";
/** Upper bound on queued frame messages the shell holds between drains. */
export const ARTIFACT_SHELL_QUEUE_LIMIT = 64;
/** A pending drain resolves (possibly empty) after this long so no call is held forever. */
export const ARTIFACT_SHELL_DRAIN_TIMEOUT_MS = 20_000;

export const ARTIFACT_SHELL_SCHEME_PRIVILEGES = {
  scheme: ARTIFACT_SHELL_SCHEME,
  privileges: {
    standard: true,
    secure: false,
    bypassCSP: false,
    allowServiceWorkers: false,
    supportFetchAPI: false,
    corsEnabled: false,
    stream: false,
    codeCache: false,
  },
} as const;

/**
 * The shell's relay. Self-contained: no imports, no references to bundled
 * identifiers. Checks mirror `parseArtifactFrameMessage`'s envelope rules
 * (source, opaque origin, plain object, channel, version, known type, size,
 * rate); the main process re-validates every message with the protocol parser.
 */
const SHELL_SCRIPT = `(() => {
  "use strict";
  const CHANNEL = ${JSON.stringify(ARTIFACT_FRAME_CHANNEL)};
  const MAX_BYTES = ${FRAME_CHANNEL_POLICY.maxMessageBytes};
  const RATE = ${FRAME_CHANNEL_POLICY.messagesPerSecond};
  const BURST = ${FRAME_CHANNEL_POLICY.burst};
  const QUEUE_LIMIT = ${ARTIFACT_SHELL_QUEUE_LIMIT};
  const DRAIN_TIMEOUT = ${ARTIFACT_SHELL_DRAIN_TIMEOUT_MS};
  const frame = document.getElementById("artifact");
  const queue = [];
  let dropped = 0;
  let waiter = null;
  let timer = null;
  let tokens = BURST;
  let last = Date.now();
  const admit = () => {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - last) / 1000) * RATE);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
  const boundedSize = (value) => {
    let total = 0;
    let visited = 0;
    const stack = [value];
    while (stack.length > 0) {
      const current = stack.pop();
      if (++visited > 64) return MAX_BYTES + 1;
      if (typeof current === "string") total += current.length + 2;
      else if (typeof current === "number" || typeof current === "boolean") total += 8;
      else if (current && typeof current === "object") {
        for (const key of Object.keys(current)) {
          total += key.length + 3;
          stack.push(current[key]);
        }
      }
      if (total > MAX_BYTES) return total;
    }
    return total;
  };
  const settle = () => {
    if (!waiter) return;
    const resolve = waiter;
    waiter = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const batch = { messages: queue.splice(0), dropped };
    dropped = 0;
    resolve(batch);
  };
  const drop = () => {
    dropped += 1;
  };
  window.addEventListener("message", (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.origin !== "null") return drop();
    if (event.ports && event.ports.length > 0) return drop();
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return drop();
    if (data.channel !== CHANNEL || data.v !== 1) return drop();
    if (data.type !== "ready" && data.type !== "size" && data.type !== "link-request") return drop();
    if (boundedSize(data) > MAX_BYTES) return drop();
    if (!admit()) return drop();
    let copy;
    try {
      const json = JSON.stringify(data);
      if (typeof json !== "string" || json.length > MAX_BYTES) return drop();
      copy = JSON.parse(json);
    } catch {
      return drop();
    }
    if (queue.length >= QUEUE_LIMIT) return drop();
    queue.push(copy);
    settle();
  });
  const api = Object.freeze({
    drain: () =>
      new Promise((resolve) => {
        if (waiter) settle();
        waiter = resolve;
        if (queue.length > 0) {
          settle();
          return;
        }
        timer = setTimeout(settle, DRAIN_TIMEOUT);
      }),
    theme: (message) => {
      if (!message || typeof message !== "object") return false;
      if (message.channel !== CHANNEL || message.v !== 1 || message.type !== "theme") return false;
      const target = frame && frame.contentWindow;
      if (!target) return false;
      target.postMessage(message, "*");
      return true;
    },
  });
  Object.defineProperty(window, ${JSON.stringify(ARTIFACT_SHELL_GLOBAL)}, {
    value: api,
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();`;

const SHELL_STYLE =
  "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}" +
  "iframe{display:block;border:0;width:100%;height:100%;background:transparent}";

function sha256Source(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

const SCRIPT_HASH = sha256Source(SHELL_SCRIPT);
const STYLE_HASH = sha256Source(SHELL_STYLE);

/** Expression the main process evaluates to pull the next batch of frame messages. */
export const ARTIFACT_SHELL_DRAIN_EXPRESSION = `globalThis.${ARTIFACT_SHELL_GLOBAL}.drain()`;

/** Expression that hands one validated theme message to the shell. */
export function artifactShellThemeExpression(theme: unknown): string {
  // JSON is a valid JavaScript expression; the value was validated in main.
  return `globalThis.${ARTIFACT_SHELL_GLOBAL}.theme(${JSON.stringify(theme)})`;
}

/**
 * The shell's policy. `frame-src` names exactly the artifact content origin;
 * the shell itself loads nothing else, runs only its hashed script, and cannot
 * be framed. `frame-ancestors` is meaningful only in the HTTP header.
 */
export function artifactShellContentSecurityPolicy(
  contentOrigin: string,
  { header }: { header: boolean },
): string {
  const directives = [
    "default-src 'none'",
    `script-src ${SCRIPT_HASH}`,
    "script-src-attr 'none'",
    `style-src ${STYLE_HASH}`,
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    `frame-src ${contentOrigin}`,
    `child-src ${contentOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (header) directives.push("frame-ancestors 'none'");
  return directives.join("; ");
}

/** Origin of an `http(s)` content URL, in a form safe to place in a CSP source list. */
export function artifactContentOrigin(contentUrl: string): string {
  const url = new URL(contentUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Artifact content must be served over HTTP(S)");
  }
  if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(url.origin)) {
    throw new Error("Artifact content origin cannot be expressed in a policy");
  }
  return url.origin;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "bluetooth=()",
  "camera=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "display-capture=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
].join(", ");

/** The complete shell document for one content URL. */
export function artifactShellDocument(contentUrl: string): string {
  const contentOrigin = artifactContentOrigin(contentUrl);
  const metaPolicy = artifactShellContentSecurityPolicy(contentOrigin, { header: false });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(metaPolicy)}">`,
    '<meta name="referrer" content="no-referrer">',
    "<title>Interactive artifact</title>",
    `<style>${SHELL_STYLE}</style>`,
    "</head>",
    "<body>",
    `<iframe id="artifact" title="Interactive artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="eager" src="${escapeHtmlAttribute(contentUrl)}"></iframe>`,
    `<script>${SHELL_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("");
}

/** Response headers for the shell document. */
export function artifactShellHeaders(contentUrl: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": artifactShellContentSecurityPolicy(
      artifactContentOrigin(contentUrl),
      { header: true },
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
  };
}

/** Exposed for tests that execute the shell relay in a DOM. */
export const ARTIFACT_SHELL_SCRIPT_SOURCE = SHELL_SCRIPT;
