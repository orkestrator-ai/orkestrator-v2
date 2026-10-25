/**
 * The presentation channel between an interactive HTML artifact frame and the
 * trusted host that displays it.
 *
 * Exactly four message types exist: `ready`, `size` and `link-request` from
 * the frame, `theme` from the host. None of them can reach a tool, the
 * composer, model context, the clipboard, the filesystem or an application
 * API. A link request only creates a host-owned "Open link" control that the
 * user must click. The generation nonce prevents accidental cross-document
 * reuse; it is not a secret and confers no authority.
 */
import { FRAME_CHANNEL_POLICY } from "./rich-content-policy.js";

export const ARTIFACT_FRAME_CHANNEL = "orkestrator-artifact";
export const ARTIFACT_FRAME_PROTOCOL_VERSION = 1;

export interface ArtifactFrameIdentity {
  artifactId: string;
  revision: number;
  generation: string;
}

export type ArtifactFrameMessage =
  | {
      channel: typeof ARTIFACT_FRAME_CHANNEL;
      v: 1;
      type: "ready";
      protocolVersion: 1;
      nonce: string;
    }
  | ({
      channel: typeof ARTIFACT_FRAME_CHANNEL;
      v: 1;
      type: "size";
      height: number;
      width?: number;
    } & ArtifactFrameIdentity)
  | ({
      channel: typeof ARTIFACT_FRAME_CHANNEL;
      v: 1;
      type: "link-request";
      url: string;
      label: string;
    } & ArtifactFrameIdentity);

export interface ArtifactThemeMessage extends ArtifactFrameIdentity {
  channel: typeof ARTIFACT_FRAME_CHANNEL;
  v: 1;
  type: "theme";
  appearance: "light" | "dark";
  reducedMotion: boolean;
  viewport: { width: number; height: number };
  tokens: Record<string, string>;
}

export type ArtifactFrameRejection =
  | "not-object"
  | "wrong-channel"
  | "wrong-version"
  | "unknown-type"
  | "bad-shape"
  | "identity-mismatch"
  | "too-large";

const MESSAGE_KEYS: Record<ArtifactFrameMessage["type"], readonly string[]> = {
  ready: ["channel", "v", "type", "protocolVersion", "nonce"],
  size: ["channel", "v", "type", "height", "width", "artifactId", "revision", "generation"],
  "link-request": ["channel", "v", "type", "url", "label", "artifactId", "revision", "generation"],
};

/** Approximate serialized size without serializing hostile cyclic objects. */
function boundedSize(value: unknown, budget: number): number {
  let total = 0;
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (++visited > 64) return budget + 1;
    if (typeof current === "string") total += current.length + 2;
    else if (typeof current === "number" || typeof current === "boolean") total += 8;
    else if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        total += key.length + 3;
        stack.push(child);
      }
    }
    if (total > budget) return total;
  }
  return total;
}

/**
 * Validate one frame-to-host message. `expected` is null until the readiness
 * handshake completes; afterwards every message must carry the exact identity.
 */
export function parseArtifactFrameMessage(
  data: unknown,
  expected: ArtifactFrameIdentity | null,
): { ok: true; message: ArtifactFrameMessage } | { ok: false; reason: ArtifactFrameRejection } {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return { ok: false, reason: "not-object" };
  if (
    boundedSize(data, FRAME_CHANNEL_POLICY.maxMessageBytes) > FRAME_CHANNEL_POLICY.maxMessageBytes
  ) {
    return { ok: false, reason: "too-large" };
  }
  const record = data as Record<string, unknown>;
  if (record.channel !== ARTIFACT_FRAME_CHANNEL) return { ok: false, reason: "wrong-channel" };
  if (record.v !== ARTIFACT_FRAME_PROTOCOL_VERSION) return { ok: false, reason: "wrong-version" };
  const type = record.type;
  if (type !== "ready" && type !== "size" && type !== "link-request")
    return { ok: false, reason: "unknown-type" };
  const allowed = MESSAGE_KEYS[type];
  if (Object.keys(record).some((key) => !allowed.includes(key)))
    return { ok: false, reason: "bad-shape" };
  if (type === "ready") {
    if (
      record.protocolVersion !== 1 ||
      typeof record.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(record.nonce)
    ) {
      return { ok: false, reason: "bad-shape" };
    }
    return { ok: true, message: record as ArtifactFrameMessage };
  }
  if (
    !expected ||
    record.artifactId !== expected.artifactId ||
    record.revision !== expected.revision ||
    record.generation !== expected.generation
  ) {
    return { ok: false, reason: "identity-mismatch" };
  }
  if (type === "size") {
    const height = record.height;
    const width = record.width;
    if (typeof height !== "number" || !Number.isFinite(height) || height < 0 || height > 100_000) {
      return { ok: false, reason: "bad-shape" };
    }
    if (
      width !== undefined &&
      (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > 100_000)
    ) {
      return { ok: false, reason: "bad-shape" };
    }
    return { ok: true, message: record as ArtifactFrameMessage };
  }
  if (typeof record.url !== "string" || typeof record.label !== "string")
    return { ok: false, reason: "bad-shape" };
  if (record.label.length > FRAME_CHANNEL_POLICY.maxLinkLabelCharacters)
    return { ok: false, reason: "bad-shape" };
  if (normalizeArtifactLink(record.url) === null) return { ok: false, reason: "bad-shape" };
  return { ok: true, message: record as ArtifactFrameMessage };
}

/**
 * The one message the browser viewer shell (served on the content origin as
 * `/s/<capability>`) sends on its own behalf: it disposed the artifact frame
 * because of an unexpected load (any load after the first) or a navigation
 * its `frame-src` blocked. It is not part of the frame channel: the shell
 * relays only `ready`, `size` and `link-request` from the frame, so the frame
 * cannot forge it, and a forged one could only end the view (fail closed).
 */
export const ARTIFACT_SHELL_DISPOSED = "shell-disposed";
export const ARTIFACT_SHELL_DISPOSE_REASONS = ["unexpected-load", "blocked-navigation"] as const;
export type ArtifactShellDisposeReason = (typeof ARTIFACT_SHELL_DISPOSE_REASONS)[number];

export interface ArtifactShellDisposedMessage {
  channel: typeof ARTIFACT_FRAME_CHANNEL;
  v: 1;
  type: typeof ARTIFACT_SHELL_DISPOSED;
  reason: ArtifactShellDisposeReason;
}

const SHELL_DISPOSED_KEYS = ["channel", "v", "type", "reason"] as const;

/** Validate a shell-to-host message (exact keys, known reason). */
export function parseArtifactShellMessage(
  data: unknown,
): { ok: true; message: ArtifactShellDisposedMessage } | { ok: false } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false };
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== SHELL_DISPOSED_KEYS.length ||
    keys.some((key) => !(SHELL_DISPOSED_KEYS as readonly string[]).includes(key))
  ) {
    return { ok: false };
  }
  if (
    record.channel !== ARTIFACT_FRAME_CHANNEL ||
    record.v !== ARTIFACT_FRAME_PROTOCOL_VERSION ||
    record.type !== ARTIFACT_SHELL_DISPOSED ||
    typeof record.reason !== "string" ||
    !(ARTIFACT_SHELL_DISPOSE_REASONS as readonly string[]).includes(record.reason)
  ) {
    return { ok: false };
  }
  return { ok: true, message: record as unknown as ArtifactShellDisposedMessage };
}

/** Clamp a requested frame height to the inline viewer's bounds. */
export function clampArtifactFrameHeight(height: number): number {
  return Math.round(
    Math.min(
      FRAME_CHANNEL_POLICY.maxInlineHeight,
      Math.max(FRAME_CHANNEL_POLICY.minInlineHeight, height),
    ),
  );
}

/**
 * A link an artifact asked the host to offer: http(s) only, no credentials,
 * no control or bidirectional-format characters, bounded length.
 */
/** Control and bidirectional-format characters, written as escapes so formatters keep them visible. */
const UNSAFE_LINK_CHARACTERS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
);

export function normalizeArtifactLink(raw: string): { href: string; hostname: string } | null {
  if (raw.length === 0 || raw.length > FRAME_CHANNEL_POLICY.maxLinkCharacters) return null;
  if (UNSAFE_LINK_CHARACTERS.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return { href: url.href, hostname: url.hostname };
}

/** Token bucket for frame messages: 20/s, burst 40, size updates coalesced to 4/s. */
export class ArtifactFrameRateLimiter {
  private tokens: number = FRAME_CHANNEL_POLICY.burst;
  private last: number;
  private lastSize = -Infinity;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.last = now();
  }

  admit(type: ArtifactFrameMessage["type"]): boolean {
    const now = this.now();
    this.tokens = Math.min(
      FRAME_CHANNEL_POLICY.burst,
      this.tokens + ((now - this.last) / 1000) * FRAME_CHANNEL_POLICY.messagesPerSecond,
    );
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    if (type === "size") {
      if (now - this.lastSize < 1000 / FRAME_CHANNEL_POLICY.sizeUpdatesPerSecond) return false;
      this.lastSize = now;
    }
    return true;
  }
}

/**
 * The runtime installed in every prepared interactive document. Serialized
 * with `toString()` and authorized by its exact CSP hash. It exposes
 * presentation helpers only: theme, available width, readiness and a link
 * request. It never reads parent state and accepts theme messages only from
 * its parent window.
 */
export function installArtifactFrameRuntime(identity: {
  artifactId: string;
  revision: number;
  nonce: string;
}) {
  const CHANNEL = "orkestrator-artifact";
  let generation: string | null = null;
  let theme: { appearance: string; reducedMotion: boolean; tokens: Record<string, string> } = {
    appearance: "light",
    reducedMotion: true,
    tokens: {},
  };
  const listeners = new Set<(value: typeof theme) => void>();
  const post = (message: Record<string, unknown>) => {
    try {
      window.parent.postMessage({ channel: CHANNEL, v: 1, ...message }, "*");
    } catch {
      // A detached frame has no parent to report to.
    }
  };
  const identityFields = () =>
    generation
      ? { artifactId: identity.artifactId, revision: identity.revision, generation }
      : null;
  let pendingHeight = 0;
  let sizeTimer: ReturnType<typeof setTimeout> | null = null;
  const reportSize = () => {
    const fields = identityFields();
    if (!fields) return;
    const height = Math.ceil(document.documentElement.scrollHeight);
    if (height === pendingHeight) return;
    pendingHeight = height;
    if (sizeTimer) return;
    sizeTimer = setTimeout(() => {
      sizeTimer = null;
      const current = identityFields();
      if (current) post({ type: "size", height: pendingHeight, ...current });
    }, 250);
  };
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.channel !== CHANNEL || data.v !== 1 || data.type !== "theme") return;
    if (data.artifactId !== identity.artifactId || data.revision !== identity.revision) return;
    if (typeof data.generation !== "string") return;
    generation = data.generation;
    const tokens: Record<string, string> = {};
    if (data.tokens && typeof data.tokens === "object") {
      for (const [key, value] of Object.entries(data.tokens as Record<string, unknown>).slice(
        0,
        64,
      )) {
        if (/^--[a-z0-9-]{1,40}$/.test(key) && typeof value === "string" && value.length < 200) {
          tokens[key] = value;
          document.documentElement.style.setProperty(key, value);
        }
      }
    }
    theme = {
      appearance: data.appearance === "dark" ? "dark" : "light",
      reducedMotion: data.reducedMotion === true,
      tokens,
    };
    document.documentElement.dataset.theme = theme.appearance;
    document.documentElement.style.colorScheme = theme.appearance;
    listeners.forEach((listener) => listener(theme));
    reportSize();
  });
  const api = Object.freeze({
    theme: () => ({ ...theme, tokens: { ...theme.tokens } }),
    onTheme: (listener: (value: typeof theme) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    width: () => document.documentElement.clientWidth,
    requestLink: (url: string, label = "") => {
      const fields = identityFields();
      if (fields)
        post({
          type: "link-request",
          url: String(url).slice(0, 2048),
          label: String(label).slice(0, 200),
          ...fields,
        });
    },
  });
  Object.defineProperty(window, "orkestratorArtifact", {
    value: api,
    writable: false,
    configurable: false,
  });
  const start = () => {
    new ResizeObserver(reportSize).observe(document.documentElement);
    post({ type: "ready", protocolVersion: 1, nonce: identity.nonce });
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

/** Source of the runtime script for a prepared document. */
export function artifactFrameRuntimeScript(identity: {
  artifactId: string;
  revision: number;
  nonce: string;
}): string {
  return `(${installArtifactFrameRuntime.toString()})(${JSON.stringify(identity)});`;
}
