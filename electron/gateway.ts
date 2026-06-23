import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http, {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

type BackendInvoker = {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown> | unknown;
};

type NetworkInterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface GatewayStartInfo {
  bindAddress: string;
  port: number;
  url: string;
  token: string;
  authFile: string;
}

export interface OrkestratorGatewayOptions {
  backend: BackendInvoker;
  dataDir: string;
  rendererRoot: string;
  rendererDevServerUrl?: string;
  bindAddress?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  interfaces?: NetworkInterfaceMap;
  logger?: Pick<Console, "debug" | "error" | "info" | "warn">;
  unsafeAllowNonTailscaleBind?: boolean;
}

const AUTH_COOKIE = "orkestrator_gateway_auth";
const API_PREFIX = "/__orkestrator";
const DEFAULT_GATEWAY_PORT = 34121;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const KEEPALIVE_MS = 25_000;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid gateway port: ${value}`);
  }
  return port;
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

export function isTailscaleAddress(address: string): boolean {
  const ipv4 = parseIPv4(address);
  if (ipv4) {
    // Tailscale assigns IPv4 addresses from 100.64.0.0/10.
    return ipv4[0] === 100 && ipv4[1] !== undefined && ipv4[1] >= 64 && ipv4[1] <= 127;
  }

  // Tailscale IPv6 addresses use this ULA prefix.
  return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export function selectTailscaleBindAddress(interfaces: NetworkInterfaceMap = networkInterfaces()): string | null {
  const candidates: NetworkInterfaceInfo[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && isTailscaleAddress(entry.address)) {
        candidates.push(entry);
      }
    }
  }

  return (
    candidates.find((entry) => entry.family === "IPv4")?.address ??
    candidates[0]?.address ??
    null
  );
}

function formatHostForUrl(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    default:
      return "application/octet-stream";
  }
}

function jsonResponse(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function textResponse(response: ServerResponse, statusCode: number, text: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(text);
}

function getCookie(headers: IncomingHttpHeaders, name: string): string | null {
  const cookieHeader = headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function getBearerToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  if (!authorization) return null;
  const [scheme, ...rest] = authorization.split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

function tokenMatches(actual: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const actualBytes = Buffer.from(actual);
  const candidateBytes = Buffer.from(candidate);
  return actualBytes.length === candidateBytes.length && timingSafeEqual(actualBytes, candidateBytes);
}

function authFilePath(dataDir: string): string {
  return path.join(dataDir, "gateway-auth.json");
}

export async function loadOrCreateGatewayToken(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<{ token: string; authFile: string }> {
  const authFile = authFilePath(dataDir);
  const envToken = env.ORKESTRATOR_GATEWAY_TOKEN?.trim();
  if (envToken) {
    if (envToken.length < 16) throw new Error("ORKESTRATOR_GATEWAY_TOKEN must be at least 16 characters");
    return { token: envToken, authFile };
  }

  const existing = await readFile(authFile, "utf8")
    .then((contents) => JSON.parse(contents) as { token?: unknown })
    .catch(() => null);
  if (typeof existing?.token === "string" && existing.token.length >= 16) {
    return { token: existing.token, authFile };
  }

  const token = randomBytes(32).toString("base64url");
  await mkdir(path.dirname(authFile), { recursive: true });
  await writeFile(authFile, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  return { token, authFile };
}

async function readRequestBody(request: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readRequestBody(request);
  if (body.length === 0) return {};
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object body");
  }
  return parsed as Record<string, unknown>;
}

async function readLoginToken(request: IncomingMessage): Promise<string> {
  const contentType = request.headers["content-type"] ?? "";
  const body = await readRequestBody(request);

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body.toString("utf8")) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : "";
  }

  const params = new URLSearchParams(body.toString("utf8"));
  return params.get("token") ?? "";
}

function loginPage(message = ""): string {
  const escapedMessage = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orkestrator Gateway</title>
    <style>
      :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #101214; color: #f4f4f5; }
      main { width: min(420px, calc(100vw - 32px)); }
      h1 { font-size: 20px; font-weight: 650; margin: 0 0 16px; }
      p { color: #a1a1aa; line-height: 1.5; margin: 0 0 20px; }
      label { display: block; font-size: 13px; color: #d4d4d8; margin-bottom: 8px; }
      input { box-sizing: border-box; width: 100%; height: 40px; border-radius: 6px; border: 1px solid #3f3f46; background: #18181b; color: #fafafa; padding: 0 12px; }
      button { height: 40px; margin-top: 12px; width: 100%; border: 0; border-radius: 6px; background: #fafafa; color: #18181b; font-weight: 650; cursor: pointer; }
      .error { color: #fca5a5; margin-bottom: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Orkestrator Gateway</h1>
      <p>Enter the gateway token from the host machine to continue.</p>
      ${escapedMessage ? `<p class="error">${escapedMessage}</p>` : ""}
      <form method="post" action="${API_PREFIX}/login">
        <label for="token">Gateway token</label>
        <input id="token" name="token" type="password" autocomplete="current-password" autofocus />
        <button type="submit">Connect</button>
      </form>
    </main>
  </body>
</html>`;
}

function wantsHtml(request: IncomingMessage): boolean {
  return request.headers.accept?.includes("text/html") ?? false;
}

function cookieHeader(token: string): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

function sanitizeTargetRequestHeaders(headers: IncomingHttpHeaders, target: URL): IncomingHttpHeaders {
  const sanitized: IncomingHttpHeaders = {
    ...headers,
    host: target.host,
  };
  delete sanitized.authorization;
  delete sanitized.cookie;
  delete sanitized.connection;
  delete sanitized["proxy-authorization"];
  return sanitized;
}

function sanitizeProxyResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const sanitized: OutgoingHttpHeaders = { ...headers };
  delete sanitized["set-cookie"];
  delete sanitized.connection;
  delete sanitized["transfer-encoding"];
  return sanitized;
}

export class OrkestratorGateway {
  private readonly backend: BackendInvoker;
  private readonly dataDir: string;
  private readonly rendererRoot: string;
  private readonly rendererDevServerUrl?: string;
  private readonly bindAddress?: string;
  private readonly port?: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly interfaces?: NetworkInterfaceMap;
  private readonly logger: Pick<Console, "debug" | "error" | "info" | "warn">;
  private readonly unsafeAllowNonTailscaleBind: boolean;
  private server: Server | null = null;
  private token = "";
  private authFile = "";
  private clients = new Set<ServerResponse>();
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(options: OrkestratorGatewayOptions) {
    this.backend = options.backend;
    this.dataDir = options.dataDir;
    this.rendererRoot = options.rendererRoot;
    this.rendererDevServerUrl = options.rendererDevServerUrl;
    this.bindAddress = options.bindAddress;
    this.port = options.port;
    this.env = options.env ?? process.env;
    this.interfaces = options.interfaces;
    this.logger = options.logger ?? console;
    this.unsafeAllowNonTailscaleBind = options.unsafeAllowNonTailscaleBind ?? false;
  }

  async start(): Promise<GatewayStartInfo | null> {
    if (this.env.ORKESTRATOR_GATEWAY_DISABLED === "1") {
      this.logger.info("[RemoteGateway] Disabled by ORKESTRATOR_GATEWAY_DISABLED=1");
      return null;
    }

    const bindAddress = this.bindAddress ?? this.env.ORKESTRATOR_GATEWAY_HOST ?? selectTailscaleBindAddress(this.interfaces);
    if (!bindAddress) {
      this.logger.warn("[RemoteGateway] No Tailscale address found; gateway not started");
      return null;
    }
    if (!this.unsafeAllowNonTailscaleBind && !isTailscaleAddress(bindAddress)) {
      throw new Error(`Refusing to bind gateway to non-Tailscale address: ${bindAddress}`);
    }

    const port = this.port ?? parsePort(this.env.ORKESTRATOR_GATEWAY_PORT, DEFAULT_GATEWAY_PORT);
    const auth = await loadOrCreateGatewayToken(this.dataDir, this.env);
    this.token = auth.token;
    this.authFile = auth.authFile;

    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.logger.error("[RemoteGateway] Request failed:", error);
        if (!response.headersSent) {
          jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
        } else {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, bindAddress, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    const url = `http://${formatHostForUrl(bindAddress)}:${resolvedPort}/`;
    this.logger.info(`[RemoteGateway] Listening on ${url}`);
    this.logger.info(`[RemoteGateway] Auth token stored at ${this.authFile}`);

    return { bindAddress, port: resolvedPort, url, token: this.token, authFile: this.authFile };
  }

  async stop(): Promise<void> {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  emit(event: string, payload: unknown): void {
    if (this.clients.size === 0) return;
    const message = `data: ${JSON.stringify({ event, payload })}\n\n`;
    for (const client of this.clients) {
      client.write(message);
    }
  }

  private authenticated(request: IncomingMessage): boolean {
    const token = getBearerToken(request.headers) ?? getCookie(request.headers, AUTH_COOKIE);
    return tokenMatches(this.token, token);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://orkestrator.local");

    if (url.pathname === `${API_PREFIX}/login`) {
      await this.handleLogin(request, response);
      return;
    }

    if (url.pathname === `${API_PREFIX}/logout`) {
      response.writeHead(303, {
        location: `${API_PREFIX}/login`,
        "set-cookie": `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (!this.authenticated(request)) {
      if (wantsHtml(request) && request.method === "GET") {
        textResponse(response, 401, loginPage(), "text/html; charset=utf-8");
      } else {
        jsonResponse(response, 401, { error: "Authentication required" });
      }
      return;
    }

    if (url.pathname === `${API_PREFIX}/invoke`) {
      await this.handleInvoke(request, response);
      return;
    }

    if (url.pathname === `${API_PREFIX}/events`) {
      this.handleEvents(request, response);
      return;
    }

    if (url.pathname.startsWith(`${API_PREFIX}/proxy/loopback/`)) {
      await this.handleLoopbackProxy(request, response, url);
      return;
    }

    await this.serveStatic(request, url, response);
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET") {
      textResponse(response, 200, loginPage(), "text/html; charset=utf-8");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
      return;
    }

    const token = await readLoginToken(request);
    if (!tokenMatches(this.token, token)) {
      textResponse(response, 401, loginPage("Invalid gateway token."), "text/html; charset=utf-8");
      return;
    }

    response.writeHead(303, {
      location: "/",
      "set-cookie": cookieHeader(this.token),
      "cache-control": "no-store",
    });
    response.end();
  }

  private async handleInvoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    const body = await readJsonBody(request);
    const command = body.command;
    const args = body.args;
    if (typeof command !== "string") {
      jsonResponse(response, 400, { error: "Expected command to be a string" });
      return;
    }
    const safeArgs = args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};

    try {
      const result = await this.backend.invoke(command, safeArgs);
      jsonResponse(response, 200, { result });
    } catch (error) {
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleEvents(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add(response);

    this.keepalive ??= setInterval(() => {
      for (const client of this.clients) client.write(": keepalive\n\n");
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();

    request.once("close", () => {
      this.clients.delete(response);
    });
  }

  private async handleLoopbackProxy(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const prefix = `${API_PREFIX}/proxy/loopback/`;
    const remaining = url.pathname.slice(prefix.length);
    const slashIndex = remaining.indexOf("/");
    const rawPort = slashIndex >= 0 ? remaining.slice(0, slashIndex) : remaining;
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      jsonResponse(response, 400, { error: "Invalid loopback proxy port" });
      return;
    }

    const restPath = slashIndex >= 0 ? remaining.slice(slashIndex) : "/";
    const targetPath = `${restPath}${url.search}`;
    await this.proxyToTarget(request, response, new URL(`http://127.0.0.1:${port}${targetPath}`));
  }

  private async proxyToTarget(request: IncomingMessage, response: ServerResponse, target: URL): Promise<void> {
    await new Promise<void>((resolve) => {
      const proxyRequest = http.request({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: sanitizeTargetRequestHeaders(request.headers, target),
      }, (proxyResponse) => {
        response.writeHead(proxyResponse.statusCode ?? 502, sanitizeProxyResponseHeaders(proxyResponse.headers));
        proxyResponse.pipe(response);
        proxyResponse.once("end", resolve);
      });

      proxyRequest.once("error", (error) => {
        if (!response.headersSent) {
          jsonResponse(response, 502, { error: error.message });
        } else {
          response.destroy(error);
        }
        resolve();
      });

      request.pipe(proxyRequest);
    });
  }

  private async serveStatic(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
    if (this.rendererDevServerUrl) {
      const target = new URL(this.rendererDevServerUrl);
      target.pathname = url.pathname;
      target.search = url.search;
      await this.proxyToTarget(request, response, target);
      return;
    }

    const root = path.resolve(this.rendererRoot);
    const decodedPath = decodeURIComponent(url.pathname);
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    let filePath = path.resolve(root, relativePath);

    if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
      textResponse(response, 403, "Forbidden");
      return;
    }

    let fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.isDirectory()) {
      if (path.extname(relativePath)) {
        textResponse(response, 404, "Not found");
        return;
      }
      filePath = path.join(root, "index.html");
      fileStat = await stat(filePath).catch(() => null);
    }

    if (!fileStat?.isFile()) {
      textResponse(response, 404, "Renderer build not found");
      return;
    }

    response.writeHead(200, {
      "content-type": mimeType(filePath),
      "content-length": fileStat.size,
    });
    createReadStream(filePath).pipe(response);
  }
}
