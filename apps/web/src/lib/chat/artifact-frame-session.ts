import {
  ARTIFACT_FRAME_CHANNEL,
  ARTIFACT_SHELL_DISPOSED,
  ArtifactFrameRateLimiter,
  parseArtifactFrameMessage,
  parseArtifactShellMessage,
  type ArtifactFrameIdentity,
  type ArtifactFrameRejection,
  type ArtifactShellDisposeReason,
  type ArtifactThemeMessage,
} from "@orkestrator/protocol/artifact-frame-channel";
import type { ArtifactLiveSessionResponse } from "@orkestrator/protocol/transcript-artifact-commands";

/**
 * Host side of the presentation channel for one live interactive document
 * (browser mode). One instance per mounted frame generation. The captured
 * window is the trusted viewer shell on the content origin, which relays the
 * artifact frame's messages (backend `content-shell.ts`):
 *
 *  - only messages whose `source` is the captured window, and whose
 *    `origin` is the expected content origin when one is given, are read;
 *  - the shell's own `shell-disposed` (an unexpected load or a blocked
 *    navigation of the artifact frame) invalidates the channel;
 *  - every message passes the strict protocol parser and a rate limiter;
 *  - `ready` must carry the session's readiness nonce, and only then does
 *    the channel accept identity-bearing messages and send a theme;
 *  - `invalidate()` (reload, unexpected navigation, disposal, revision or
 *    scope change) drops the identity so nothing more is accepted.
 *
 * Outcomes are presentation effects only. Nothing here can reach the
 * composer, a tool, the clipboard or a backend API.
 */

export type ArtifactFrameOutcome =
  | { kind: "ready" }
  | { kind: "size"; height: number; width?: number }
  | { kind: "link"; href: string; hostname: string; label: string }
  | { kind: "disposed"; reason: ArtifactShellDisposeReason }
  | {
      kind: "rejected";
      reason:
        | ArtifactFrameRejection
        | "wrong-source"
        | "wrong-origin"
        | "wrong-nonce"
        | "invalidated"
        | "duplicate-ready";
    }
  | { kind: "rate-limited" };

export interface ArtifactFrameSessionInit {
  artifactId: string;
  revision: number;
  generation: string;
  readinessNonce: string;
  /** Exact origin every message must come from (the shell's content origin). */
  expectedOrigin?: string;
  now?: () => number;
}

export class ArtifactFrameSession {
  private identity: ArtifactFrameIdentity | null = null;
  private invalidated = false;
  private readonly limiter: ArtifactFrameRateLimiter;
  /** Content-free counters for diagnostics. */
  readonly counters = { accepted: 0, rejected: 0, rateLimited: 0 };

  constructor(private readonly init: ArtifactFrameSessionInit) {
    this.limiter = new ArtifactFrameRateLimiter(init.now);
  }

  get ready(): boolean {
    return this.identity !== null && !this.invalidated;
  }

  invalidate(): void {
    this.invalidated = true;
    this.identity = null;
  }

  handle(
    event: { source: unknown; data: unknown; origin?: string },
    frameWindow: unknown,
  ): ArtifactFrameOutcome {
    if (frameWindow == null || event.source !== frameWindow) return this.reject("wrong-source");
    if (this.init.expectedOrigin !== undefined && event.origin !== this.init.expectedOrigin)
      return this.reject("wrong-origin");
    if (this.invalidated) return this.reject("invalidated");
    const record = event.data as { type?: unknown } | null;
    if (typeof record === "object" && record !== null && record.type === ARTIFACT_SHELL_DISPOSED) {
      const disposed = parseArtifactShellMessage(event.data);
      if (!disposed.ok) return this.reject("bad-shape");
      this.invalidate();
      return { kind: "disposed", reason: disposed.message.reason };
    }
    const parsed = parseArtifactFrameMessage(event.data, this.identity);
    if (!parsed.ok) return this.reject(parsed.reason);
    if (!this.limiter.admit(parsed.message.type)) {
      this.counters.rateLimited++;
      return { kind: "rate-limited" };
    }
    const message = parsed.message;
    switch (message.type) {
      case "ready":
        if (this.identity) return this.reject("duplicate-ready");
        if (message.nonce !== this.init.readinessNonce) return this.reject("wrong-nonce");
        this.identity = {
          artifactId: this.init.artifactId,
          revision: this.init.revision,
          generation: this.init.generation,
        };
        this.counters.accepted++;
        return { kind: "ready" };
      case "size":
        this.counters.accepted++;
        return {
          kind: "size",
          height: message.height,
          ...(message.width !== undefined ? { width: message.width } : {}),
        };
      case "link-request": {
        // The parser already normalized and bounded the URL; re-derive the
        // trusted display form here rather than trusting the frame's text.
        const url = new URL(message.url);
        this.counters.accepted++;
        return { kind: "link", href: url.href, hostname: url.hostname, label: message.label };
      }
    }
  }

  /** Theme for the frame; null until the readiness handshake completes. */
  themeMessage(input: {
    appearance: "light" | "dark";
    reducedMotion: boolean;
    viewport: { width: number; height: number };
    tokens: Record<string, string>;
  }): ArtifactThemeMessage | null {
    if (!this.ready || !this.identity) return null;
    return {
      channel: ARTIFACT_FRAME_CHANNEL,
      v: 1,
      type: "theme",
      ...this.identity,
      appearance: input.appearance,
      reducedMotion: input.reducedMotion,
      viewport: {
        width: Math.round(input.viewport.width),
        height: Math.round(input.viewport.height),
      },
      tokens: input.tokens,
    };
  }

  private reject(
    reason: Extract<ArtifactFrameOutcome, { kind: "rejected" }>["reason"],
  ): ArtifactFrameOutcome {
    this.counters.rejected++;
    return { kind: "rejected", reason };
  }
}

/**
 * Where browser mode loads a live session: the trusted viewer shell. It must
 * be an http(s) URL on the document's origin and never on the application's
 * own origin (the shell iframe is sandboxed with `allow-scripts
 * allow-same-origin`, which is only safe cross-origin). Null fails closed:
 * the host shows the saved preview instead.
 */
export function artifactShellLocation(
  session: Pick<ArtifactLiveSessionResponse, "contentUrl" | "shellUrl">,
  applicationOrigin: string,
): { url: string; origin: string } | null {
  if (typeof session.shellUrl !== "string" || typeof session.contentUrl !== "string") return null;
  let shell: URL;
  let content: URL;
  try {
    shell = new URL(session.shellUrl);
    content = new URL(session.contentUrl);
  } catch {
    return null;
  }
  if (shell.protocol !== "http:" && shell.protocol !== "https:") return null;
  if (shell.username || shell.password || shell.hash) return null;
  if (shell.origin !== content.origin || shell.origin === applicationOrigin) return null;
  return { url: shell.href, origin: shell.origin };
}
