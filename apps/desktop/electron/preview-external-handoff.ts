import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { PreviewBootstrapDescriptor } from "@orkestrator/protocol/preview-access";

interface PendingHandoff {
  action: string;
  attachmentId: string;
  grant: string;
  expiresAt: number;
}

const HANDOFF_TTL_MS = 60_000;
const MAX_PENDING = 16;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * Opens a service preview in the user's default browser without putting the
 * grant in a URL. `shell.openExternal` can only carry a URL, so main serves a
 * one-use loopback page (identified by a random nonce, not the grant) that
 * POSTs the grant to the bootstrap authority and is then forgotten. The page
 * sends no referrer, is never cached, and may only submit to the bootstrap
 * origin.
 */
export class PreviewExternalHandoff {
  private server: Server | null = null;
  private port = 0;
  private readonly pending = new Map<string, PendingHandoff>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly openExternal: (url: string) => Promise<void> | void,
    private readonly now: () => number = Date.now,
  ) {}

  async open(attachmentId: string, bootstrap: PreviewBootstrapDescriptor): Promise<void> {
    const action = new URL(bootstrap.action);
    if (action.protocol !== "https:")
      throw new Error("Preview sign-in requires an HTTPS bootstrap authority");
    this.sweep();
    if (this.pending.size >= MAX_PENDING) throw new Error("Too many preview sign-ins are pending");
    await this.listen();
    const nonce = randomBytes(24).toString("base64url");
    this.pending.set(nonce, {
      action: action.toString(),
      attachmentId,
      grant: bootstrap.grant,
      expiresAt: this.now() + HANDOFF_TTL_MS,
    });
    this.touch();
    await this.openExternal(`http://127.0.0.1:${this.port}/handoff/${nonce}`);
  }

  pendingCount(): number {
    this.sweep();
    return this.pending.size;
  }

  async close(): Promise<void> {
    this.pending.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private sweep(): void {
    const now = this.now();
    for (const [nonce, entry] of this.pending)
      if (entry.expiresAt <= now) this.pending.delete(nonce);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.sweep();
      if (this.pending.size === 0) void this.close();
      else this.touch();
    }, HANDOFF_TTL_MS);
    this.idleTimer.unref?.();
  }

  private async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      const match = /^\/handoff\/([A-Za-z0-9_-]{32})$/.exec(request.url ?? "");
      const entry = match && request.method === "GET" ? this.pending.get(match[1]!) : undefined;
      // One use: the page is served once and forgotten, successful or not.
      if (match) this.pending.delete(match[1]!);
      if (!entry || entry.expiresAt <= this.now()) {
        response.writeHead(410, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(
          "This preview link was already used or expired. Open the preview again from Orkestrator.\n",
        );
        return;
      }
      const scriptNonce = randomBytes(16).toString("base64");
      const actionOrigin = new URL(entry.action).origin;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${scriptNonce}'; form-action ${actionOrigin}; frame-ancestors 'none'`,
      });
      response.end(
        `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening preview…</title>
<form id="handoff" method="POST" action="${escape(entry.action)}">
<input type="hidden" name="attachment" value="${escape(entry.attachmentId)}">
<input type="hidden" name="grant" value="${escape(entry.grant)}">
<noscript><button type="submit">Continue to preview</button></noscript>
</form>
<p style="font:14px system-ui">Opening preview…</p>
<script nonce="${scriptNonce}">document.getElementById("handoff").submit();</script>`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }
}
