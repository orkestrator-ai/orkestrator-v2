/**
 * The trusted viewer shell for live interactive artifacts in browser mode.
 *
 * Served by the content server on the content origin as `/s/<capability>`
 * (the same capability as the document at `/a/<capability>`, with the same
 * expiry, revocation and serve-time authorization). The application page
 * frames the shell, never the document: the shell's `frame-src` names exactly
 * the one prepared-document URL (a path-exact source expression), so the
 * artifact frame cannot navigate itself anywhere else (meta refresh,
 * `location`, data:/blob: URLs, redirects) — the embedding document's
 * `frame-src` governs every navigation of its child frame, and the
 * application's own pages cannot carry one because Browser tabs frame
 * arbitrary URLs.
 *
 * The shell runs one fixed script, authorized by its hash. It creates the
 * artifact frame (`sandbox="allow-scripts"`, no referrer) only when it is
 * itself framed, relays exactly `ready`, `size` and `link-request` from that
 * exact frame window to its parent and `theme` from its exact parent to the
 * frame, re-validating each in both directions (envelope, exact keys,
 * identity, bounds, rate), and rebuilds every relayed message from its
 * validated fields. Any load of the artifact frame after the first, or a
 * frame navigation its policy blocked, disposes the frame and sends the
 * parent one `shell-disposed` message so the host shows the saved preview.
 *
 * The shell has the content origin (its policy sandboxes it with
 * `allow-scripts allow-same-origin`): a real origin lets the host check
 * `event.origin` and address the shell exactly, and lets the document's
 * `frame-ancestors` (which never matches an opaque ancestor) name it. That
 * origin is never the application's site, holds no cookies or storage, and
 * the shell may fetch nothing (`connect-src 'none'`).
 */
import { createHash } from "node:crypto";

import {
  ARTIFACT_FRAME_CHANNEL,
  ARTIFACT_SHELL_DISPOSED,
} from "@orkestrator/protocol/artifact-frame-channel";
import { FRAME_CHANNEL_POLICY } from "@orkestrator/protocol/rich-content-policy";

export interface ArtifactShellIdentity {
  artifactId: string;
  revision: number;
  generation: string;
}

export interface ArtifactShellRelayConfig {
  /** The exact prepared-document URL the shell frames (`<origin>/a/<capability>`). */
  documentUrl: string;
  /** Permitted parent origins (the normalized `frame-ancestors` list). */
  parentOrigins: string[];
  identity: ArtifactShellIdentity;
  channel: string;
  disposedType: string;
  maxMessageBytes: number;
  messagesPerSecond: number;
  burst: number;
  maxLinkCharacters: number;
  maxLinkLabelCharacters: number;
}

/**
 * The shell relay. Serialized with `toString()` into the shell document and
 * authorized by its exact CSP hash, so it must stay self-contained: no
 * imports and no references to module identifiers; everything it needs
 * arrives in `config`. Its checks mirror `parseArtifactFrameMessage` (see
 * content-shell.test.ts, which compares them on a corpus); the host
 * re-validates every relayed message with the protocol parser and nonce.
 */
export function installArtifactShellRelay(config: ArtifactShellRelayConfig): void {
  "use strict";
  const win = window;
  const doc = document;
  // Never run the artifact outside an embedding page: framed only (and
  // `frame-ancestors` admits only the application's origins).
  if (win.parent === win) return;
  const id = config.identity;
  const CHANNEL = config.channel;
  const MAX = config.maxMessageBytes;
  const UNSAFE = new RegExp(
    "[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
  );
  const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
  const TOKEN_KEY = /^--[a-z0-9-]{1,40}$/;
  const IDENTITY_KEYS = ["artifactId", "revision", "generation"];
  const parentAllowed = (origin: string): boolean => {
    for (const entry of config.parentOrigins) {
      if (entry === origin) return true;
      if (entry.endsWith(":*")) {
        const base = entry.slice(0, -2);
        if (origin === base) return true;
        if (origin.startsWith(`${base}:`) && /^\d{1,5}$/.test(origin.slice(base.length + 1)))
          return true;
      }
    }
    return false;
  };
  // Exact target origins when every permitted parent is exact; a loopback
  // port wildcard cannot be a target, so then the (frame-ancestors-checked)
  // parent is addressed with "*". Payloads are presentation data only.
  const targets = config.parentOrigins.some((entry) => entry.endsWith(":*"))
    ? ["*"]
    : config.parentOrigins.filter((entry) => /^https?:\/\//.test(entry));
  const toParent = (message: Record<string, unknown>) => {
    for (const target of targets) {
      try {
        win.parent.postMessage(message, target);
      } catch {
        // An unparsable target is simply not addressed.
      }
    }
  };
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const onlyKeys = (record: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(record).every((key) => keys.includes(key));
  const boundedSize = (value: unknown): number => {
    let total = 0;
    let visited = 0;
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const current = stack.pop();
      if (++visited > 64) return MAX + 1;
      if (typeof current === "string") total += current.length + 2;
      else if (typeof current === "number" || typeof current === "boolean") total += 8;
      else if (current && typeof current === "object") {
        for (const key of Object.keys(current)) {
          total += key.length + 3;
          stack.push((current as Record<string, unknown>)[key]);
        }
      }
      if (total > MAX) return total;
    }
    return total;
  };
  const dimension = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000;
  const sameIdentity = (record: Record<string, unknown>) =>
    record.artifactId === id.artifactId &&
    record.revision === id.revision &&
    record.generation === id.generation;
  const linkAllowed = (raw: unknown) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > config.maxLinkCharacters)
      return false;
    if (UNSAFE.test(raw)) return false;
    try {
      const url = new URL(raw);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        url.hostname.length > 0
      );
    } catch {
      return false;
    }
  };

  let readySeen = false;
  /** A validated frame message, rebuilt from its fields; null when refused. */
  const frameMessage = (data: unknown): Record<string, unknown> | null => {
    if (!isRecord(data) || boundedSize(data) > MAX) return null;
    if (data.channel !== CHANNEL || data.v !== 1) return null;
    const base = { channel: CHANNEL, v: 1 };
    if (data.type === "ready") {
      if (!onlyKeys(data, ["channel", "v", "type", "protocolVersion", "nonce"])) return null;
      if (data.protocolVersion !== 1 || typeof data.nonce !== "string") return null;
      if (!NONCE.test(data.nonce) || readySeen) return null;
      return { ...base, type: "ready", protocolVersion: 1, nonce: data.nonce };
    }
    if (!readySeen || !sameIdentity(data)) return null;
    const identity = {
      artifactId: id.artifactId,
      revision: id.revision,
      generation: id.generation,
    };
    if (data.type === "size") {
      const keys = ["channel", "v", "type", "height", "width", ...IDENTITY_KEYS];
      if (!onlyKeys(data, keys)) return null;
      if (!dimension(data.height)) return null;
      if (data.width !== undefined && !dimension(data.width)) return null;
      return {
        ...base,
        type: "size",
        height: data.height,
        ...(data.width !== undefined ? { width: data.width } : {}),
        ...identity,
      };
    }
    if (data.type === "link-request") {
      const keys = ["channel", "v", "type", "url", "label", ...IDENTITY_KEYS];
      if (!onlyKeys(data, keys)) return null;
      if (typeof data.label !== "string" || data.label.length > config.maxLinkLabelCharacters)
        return null;
      if (!linkAllowed(data.url)) return null;
      return { ...base, type: "link-request", url: data.url, label: data.label, ...identity };
    }
    return null;
  };
  /** A validated host theme, rebuilt from its fields; null when refused. */
  const themeMessage = (data: unknown): Record<string, unknown> | null => {
    if (!isRecord(data) || boundedSize(data) > MAX) return null;
    const presentation = ["appearance", "reducedMotion", "viewport", "tokens"];
    if (!onlyKeys(data, ["channel", "v", "type", ...IDENTITY_KEYS, ...presentation])) return null;
    if (data.channel !== CHANNEL || data.v !== 1 || data.type !== "theme") return null;
    if (!sameIdentity(data)) return null;
    if (data.appearance !== "light" && data.appearance !== "dark") return null;
    if (typeof data.reducedMotion !== "boolean") return null;
    const viewport = data.viewport;
    if (!isRecord(viewport) || !onlyKeys(viewport, ["width", "height"])) return null;
    if (!dimension(viewport.width) || !dimension(viewport.height)) return null;
    if (!isRecord(data.tokens)) return null;
    const entries = Object.keys(data.tokens);
    if (entries.length > 64) return null;
    const tokens: Record<string, string> = {};
    for (const key of entries) {
      const value = data.tokens[key];
      if (!TOKEN_KEY.test(key) || typeof value !== "string" || value.length >= 200) return null;
      tokens[key] = value;
    }
    return {
      channel: CHANNEL,
      v: 1,
      type: "theme",
      artifactId: id.artifactId,
      revision: id.revision,
      generation: id.generation,
      appearance: data.appearance,
      reducedMotion: data.reducedMotion,
      viewport: { width: viewport.width, height: viewport.height },
      tokens,
    };
  };

  let tokens = config.burst;
  let last = Date.now();
  const admit = () => {
    const now = Date.now();
    tokens = Math.min(config.burst, tokens + ((now - last) / 1000) * config.messagesPerSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const frame = doc.createElement("iframe");
  let disposed = false;
  let loads = 0;
  const dispose = (reason: string) => {
    if (disposed) return;
    disposed = true;
    frame.remove();
    toParent({ channel: CHANNEL, v: 1, type: config.disposedType, reason });
  };
  frame.addEventListener("load", () => {
    loads += 1;
    // The document loads exactly once; anything else is a reload or navigation.
    if (loads > 1) dispose("unexpected-load");
  });
  doc.addEventListener("securitypolicyviolation", (event: SecurityPolicyViolationEvent) => {
    const directive = event.effectiveDirective || event.violatedDirective;
    if (directive === "frame-src" || directive === "child-src") dispose("blocked-navigation");
  });
  win.addEventListener("message", (event: MessageEvent) => {
    if (disposed) return;
    const target = frame.contentWindow;
    if (target !== null && event.source === target) {
      // The artifact frame is sandboxed without allow-same-origin.
      if (event.origin !== "null" || (event.ports && event.ports.length > 0)) return;
      const message = frameMessage(event.data);
      if (!message || !admit()) return;
      if (message.type === "ready") readySeen = true;
      toParent(message);
      return;
    }
    if (event.source === win.parent && target !== null) {
      if (!parentAllowed(event.origin) || (event.ports && event.ports.length > 0)) return;
      if (!readySeen) return;
      const message = themeMessage(event.data);
      // The frame's origin is opaque; it is addressed as the captured window.
      if (message) target.postMessage(message, "*");
    }
  });
  frame.setAttribute("id", "artifact");
  frame.setAttribute("title", "Interactive artifact");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");
  frame.setAttribute("src", config.documentUrl);
  doc.body.appendChild(frame);
}

const SHELL_STYLE =
  "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}" +
  "iframe{display:block;border:0;width:100%;height:100%;background:transparent}";

const DOCUMENT_URL_PATTERN = /^https?:\/\/[A-Za-z0-9.\-[\]:]+\/a\/[A-Za-z0-9_-]{43}$/;

function sha256Source(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

/** The relay script for one shell; JSON is escaped so it cannot end the element. */
export function artifactShellScript(input: {
  documentUrl: string;
  parentOrigins: readonly string[];
  identity: ArtifactShellIdentity;
}): string {
  if (!DOCUMENT_URL_PATTERN.test(input.documentUrl)) throw new Error("Invalid document URL");
  const config: ArtifactShellRelayConfig = {
    documentUrl: input.documentUrl,
    parentOrigins: [...input.parentOrigins],
    identity: {
      artifactId: input.identity.artifactId,
      revision: input.identity.revision,
      generation: input.identity.generation,
    },
    channel: ARTIFACT_FRAME_CHANNEL,
    disposedType: ARTIFACT_SHELL_DISPOSED,
    maxMessageBytes: FRAME_CHANNEL_POLICY.maxMessageBytes,
    messagesPerSecond: FRAME_CHANNEL_POLICY.messagesPerSecond,
    burst: FRAME_CHANNEL_POLICY.burst,
    maxLinkCharacters: FRAME_CHANNEL_POLICY.maxLinkCharacters,
    maxLinkLabelCharacters: FRAME_CHANNEL_POLICY.maxLinkLabelCharacters,
  };
  const json = JSON.stringify(config)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return `(${installArtifactShellRelay.toString()})(${json});`;
}

/**
 * The shell's policy: only its hashed script and style; it frames exactly the
 * one document URL (`frame-src`/`child-src` path-exact with no scheme source,
 * so data: and blob: documents, other capabilities on this origin and every
 * other URL are refused; qualified in content-server.engines.test.ts); it
 * loads nothing else; it is sandboxed (scripts and
 * its own origin only: no forms, popups, modals, downloads or top
 * navigation); and only the permitted application origins may frame it.
 */
export function artifactShellContentSecurityPolicy(input: {
  documentUrl: string;
  frameAncestors: readonly string[];
  scriptHash: string;
}): string {
  if (!DOCUMENT_URL_PATTERN.test(input.documentUrl)) throw new Error("Invalid document URL");
  return [
    "default-src 'none'",
    `script-src ${input.scriptHash}`,
    "script-src-attr 'none'",
    `style-src ${sha256Source(SHELL_STYLE)}`,
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    `frame-src ${input.documentUrl}`,
    `child-src ${input.documentUrl}`,
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts allow-same-origin",
    `frame-ancestors ${input.frameAncestors.length ? input.frameAncestors.join(" ") : "'none'"}`,
  ].join("; ");
}

/** The complete shell document and its policy for one capability. */
export function artifactShellResponse(input: {
  documentUrl: string;
  frameAncestors: readonly string[];
  identity: ArtifactShellIdentity;
}): { html: string; contentSecurityPolicy: string } {
  const script = artifactShellScript({
    documentUrl: input.documentUrl,
    parentOrigins: input.frameAncestors,
    identity: input.identity,
  });
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    "<title>Interactive artifact</title>",
    `<style>${SHELL_STYLE}</style>`,
    "</head>",
    "<body>",
    `<script>${script}</script>`,
    "</body>",
    "</html>",
  ].join("");
  return {
    html,
    contentSecurityPolicy: artifactShellContentSecurityPolicy({
      documentUrl: input.documentUrl,
      frameAncestors: input.frameAncestors,
      scriptHash: sha256Source(script),
    }),
  };
}
