import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { isReservedPreviewCookieName } from "@orkestrator/protocol/preview-access";

import { BROWSER_RESTRICTED_PORTS } from "./preview-external-forward.js";

export interface ImportedCookie {
  name: string;
  value: string;
}

export interface SessionCookieWriteResult {
  imported: number;
  skipped: number;
}

/** How a one-time page ended. A cancelled import reports nothing. */
export type PreviewSessionImportResult =
  | { kind: "imported"; imported: number; skipped: number }
  | { kind: "empty" }
  | { kind: "expired" }
  | { kind: "failed" };

export interface PreviewSessionImportOptions {
  openExternal: (url: string) => Promise<void> | void;
  /** Store the cookies. Only names and values are known: a `Cookie` header has no attributes. */
  write: (cookies: ImportedCookie[]) => Promise<SessionCookieWriteResult>;
  onSettled: (result: PreviewSessionImportResult) => void;
  ttlMs?: number;
}

export interface PreviewSessionImportHandle {
  cancel(): void;
}

const IMPORT_TTL_MS = 2 * 60_000;
const BIND_ATTEMPTS = 8;
// The preview transport refuses more than this anyway (`PREVIEW_LIMITS`).
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_COOKIES = 64;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 6265 cookie-octets, plus the optional surrounding quotes.
const COOKIE_VALUE =
  /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$|^"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*"$/;

/**
 * Split a browser's `Cookie` header. Orkestrator's own cookies and anything
 * malformed are skipped. `localhost` cookies ignore ports, so another local
 * server's gateway cookie can be here and must never reach an application.
 */
export function parseBrowserCookies(header: string | undefined): {
  cookies: ImportedCookie[];
  skipped: number;
} {
  const cookies: ImportedCookie[] = [];
  let skipped = 0;
  for (const pair of (header ?? "").split(";")) {
    const text = pair.trim();
    if (!text) continue;
    const separator = text.indexOf("=");
    const name = separator > 0 ? text.slice(0, separator).trim() : "";
    const value = separator > 0 ? text.slice(separator + 1).trim() : "";
    if (
      !COOKIE_NAME.test(name) ||
      !COOKIE_VALUE.test(value) ||
      isReservedPreviewCookieName(name) ||
      cookies.length >= MAX_COOKIES
    ) {
      skipped += 1;
      continue;
    }
    cookies.push({ name, value });
  }
  return { cookies, skipped };
}

function first(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value?.toLowerCase();
}

/**
 * Only the user's browser opening the link it was handed: a top-level
 * navigation that no site started. A prefetch is refused without using up the
 * link, and so is anything addressed by another name: only `localhost` carries
 * the cookies this page is for, and a foreign `Host` is DNS rebinding.
 */
export function isSessionImportRequest(request: IncomingMessage, port: number): boolean {
  if (request.method !== "GET" || request.headers.host !== `localhost:${port}`) return false;
  const site = first(request, "sec-fetch-site");
  const mode = first(request, "sec-fetch-mode");
  const destination = first(request, "sec-fetch-dest");
  const purpose = `${first(request, "sec-purpose") ?? ""} ${first(request, "purpose") ?? ""}`;
  if (site !== undefined && site !== "none") return false;
  if (mode !== undefined && mode !== "navigate") return false;
  if (destination !== undefined && destination !== "document") return false;
  return !purpose.includes("prefetch") && !purpose.includes("prerender");
}

function page(response: ServerResponse, status: number, title: string, detail: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:15px/1.5 system-ui;max-width:32rem;margin:15vh auto;padding:0 1.5rem">` +
      `<h1 style="font-size:20px">${title}</h1><p>${detail}</p>`,
  );
}

/** One port on both loopback families, so `localhost` cannot reach another server. */
async function bindLoopback(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ servers: Server[]; port: number }> {
  const listen = (address: string, port: number) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, handler);
      server.headersTimeout = 30_000;
      server.once("error", reject);
      server.listen(port, address, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
    const ipv4 = await listen("127.0.0.1", 0);
    const port = (ipv4.address() as AddressInfo).port;
    const servers = [ipv4];
    let bound = !BROWSER_RESTRICTED_PORTS.has(port);
    if (bound) {
      try {
        servers.push(await listen("::1", port));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A host without IPv6 loopback has nothing to shadow.
        bound = code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT";
      }
    }
    if (bound) return { servers, port };
    closeServers(servers);
  }
  throw new Error("No free loopback port for the sign-in page.");
}

function closeServers(servers: Server[]): void {
  for (const server of servers) {
    server.close();
    server.closeAllConnections?.();
  }
}

/**
 * Copies the user's browser sign-in into a service preview, for sign-in
 * providers that refuse embedded browsers. Cookies ignore ports, so a page on
 * any `localhost` port receives what the browser holds for the application,
 * HttpOnly session cookies included.
 *
 * The listener exists for one import, answers one random path, and closes when
 * it has been used or has expired. Cookie values are handed to `write` and go
 * nowhere else: not to the page, not to a log.
 */
export async function startPreviewSessionImport(
  options: PreviewSessionImportOptions,
): Promise<PreviewSessionImportHandle> {
  const path = `/session-import/${randomBytes(32).toString("base64url")}`;
  let port = 0;
  let servers: Server[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  const finish = () => {
    finished = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const settle = (response: ServerResponse | null, result: PreviewSessionImportResult) => {
    const close = () => closeServers(servers);
    if (response && !response.writableFinished) response.once("close", close);
    else close();
    options.onSettled(result);
  };

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    if (finished) {
      page(response, 410, "This link has ended", "Start again from Orkestrator.");
      return;
    }
    if (request.url !== path) {
      page(response, 404, "Not found", "This page has nothing here.");
      return;
    }
    if (!isSessionImportRequest(request, port)) {
      page(response, 403, "Open this link directly", "Start again from Orkestrator.");
      return;
    }
    finish();
    const { cookies, skipped } = parseBrowserCookies(request.headers.cookie);
    if (cookies.length === 0) {
      page(
        response,
        200,
        "No sign-in found",
        "This browser has no cookies for localhost. Sign in to your app here first, then try again from Orkestrator.",
      );
      settle(response, { kind: "empty" });
      return;
    }
    options.write(cookies).then(
      (written) => {
        if (written.imported === 0) {
          page(response, 200, "Nothing copied", "Orkestrator could not use these cookies.");
          settle(response, { kind: "empty" });
          return;
        }
        page(response, 200, "Sign-in copied", "You can close this tab and return to Orkestrator.");
        settle(response, {
          kind: "imported",
          imported: written.imported,
          skipped: written.skipped + skipped,
        });
      },
      () => {
        page(response, 500, "Could not copy your sign-in", "Try again from Orkestrator.");
        settle(response, { kind: "failed" });
      },
    );
  };

  const bound = await bindLoopback(handler);
  servers = bound.servers;
  port = bound.port;
  timer = setTimeout(() => {
    finish();
    settle(null, { kind: "expired" });
  }, options.ttlMs ?? IMPORT_TTL_MS);
  timer.unref?.();
  try {
    await options.openExternal(`http://localhost:${port}${path}`);
  } catch (error) {
    finish();
    closeServers(servers);
    throw error;
  }
  return {
    cancel: () => {
      if (finished) return;
      finish();
      closeServers(servers);
    },
  };
}
