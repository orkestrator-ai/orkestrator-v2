import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";

export const HOSTED_WEB_CLIENT_ORIGINS = [
  "https://orkestrator.dev",
  "https://www.orkestrator.dev",
] as const;

export type GatewayStartInfo = {
  bindAddress: string;
  port: number;
  url: string;
  authFile: string;
  browserUrl?: string;
  browserError?: string;
};

export function getBrowserGatewayStatus(info: GatewayStartInfo | null) {
  return {
    enabled: true,
    running: Boolean(info?.browserUrl),
    url: info?.browserUrl ?? null,
    error: info?.browserError ?? null,
  };
}

export function createBackendProcessEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  isDev: boolean,
  resourceRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv, ORKESTRATOR_GATEWAY_DISABLED: "0" };
  if (!isDev) {
    env.NODE_PATH = [path.join(resourceRoot, "backend", "vendor"), env.NODE_PATH]
      .filter(Boolean)
      .join(path.delimiter);
  }
  delete env.ORKESTRATOR_GATEWAY_HOST;
  delete env.ORKESTRATOR_GATEWAY_PORT;
  delete env.ORKESTRATOR_GATEWAY_TOKEN;
  delete env.ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS;
  delete env.ORKESTRATOR_TAILSCALE_SERVE;
  delete env.ORKESTRATOR_TAILSCALE_SERVE_PORT;
  delete env.ORKESTRATOR_TAILSCALE_BIN;
  delete env.ORKESTRATOR_TOOLCHAIN_BIN;
  return env;
}

type ReadyMessage = GatewayStartInfo & { type: "orkestrator-backend-ready" };

export class BackendHttpClient {
  private abortEvents: AbortController | null = null;

  constructor(private baseUrl: string, private token: string) {}

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(new URL("/__orkestrator/invoke", this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    const payload = await response.json() as { result?: T; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Backend request failed with HTTP ${response.status}`);
    return payload.result as T;
  }

  async getTokenSettings(): Promise<GatewayTokenSettings> {
    return this.gatewaySettings("GET");
  }

  async setToken(token: string): Promise<GatewayTokenSettings> {
    const settings = await this.gatewaySettings("PUT", { token });
    this.token = settings.token;
    return settings;
  }

  async getWebClientStatus(): Promise<WebClientStatus> {
    return this.webClientAccess("GET");
  }

  async setWebClientEnabled(enabled: boolean): Promise<WebClientStatus> {
    return this.webClientAccess("PUT", { enabled });
  }

  async resetWebClientServe(): Promise<WebClientStatus> {
    return this.webClientAccess("DELETE");
  }

  listen(onEvent: (event: string, payload: unknown) => void): void {
    this.abortEvents?.abort();
    const controller = new AbortController();
    this.abortEvents = controller;
    void this.consumeEvents(controller.signal, onEvent);
  }

  stopListening(): void {
    this.abortEvents?.abort();
    this.abortEvents = null;
  }

  private async consumeEvents(signal: AbortSignal, onEvent: (event: string, payload: unknown) => void): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await fetch(new URL("/__orkestrator/events", this.baseUrl), {
          headers: { authorization: `Bearer ${this.token}` },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`Backend event stream returned HTTP ${response.status}`);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let pending = "";
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += value;
          const messages = pending.split("\n\n");
          pending = messages.pop() ?? "";
          for (const message of messages) {
            const data = message.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (!data) continue;
            const parsed = JSON.parse(data) as { event?: unknown; payload?: unknown };
            if (typeof parsed.event === "string") onEvent(parsed.event, parsed.payload);
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        console.error("[BackendClient] Event stream disconnected:", error);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  private async gatewaySettings(method: "GET" | "PUT", body?: { token: string }): Promise<GatewayTokenSettings> {
    const response = await fetch(new URL("/__orkestrator/gateway-settings", this.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json() as GatewayTokenSettings & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Backend settings request failed with HTTP ${response.status}`);
    return payload;
  }

  private async webClientAccess(method: "GET" | "PUT" | "DELETE", body?: { enabled: boolean }): Promise<WebClientStatus> {
    const response = await fetch(new URL("/__orkestrator/web-client-access", this.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json() as WebClientStatus & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Backend web client request failed with HTTP ${response.status}`);
    return payload;
  }
}

export class BackendProcess {
  private child: ChildProcess | null = null;
  private client: BackendHttpClient | null = null;
  private info: GatewayStartInfo | null = null;
  private starting: Promise<BackendHttpClient> | null = null;

  async start(options: {
    isDev: boolean;
    appRoot: string;
    resourceRoot: string;
    dataDir: string;
    toolchainBinDir?: string;
    rendererDevServerUrl?: string;
    gatewayHost?: string;
    gatewayPort?: number;
    fallbackGatewayHost?: string;
    allowNonTailscaleBind?: boolean;
    desktopWebClient?: boolean;
    tailscaleExecutable?: string;
    onEvent: (event: string, payload: unknown) => void;
    onUnexpectedExit?: (error: Error) => void;
  }): Promise<BackendHttpClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.launch(options).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(options: {
    isDev: boolean;
    appRoot: string;
    resourceRoot: string;
    dataDir: string;
    toolchainBinDir?: string;
    rendererDevServerUrl?: string;
    gatewayHost?: string;
    gatewayPort?: number;
    fallbackGatewayHost?: string;
    allowNonTailscaleBind?: boolean;
    desktopWebClient?: boolean;
    tailscaleExecutable?: string;
    onEvent: (event: string, payload: unknown) => void;
    onUnexpectedExit?: (error: Error) => void;
  }): Promise<BackendHttpClient> {
    const bun = options.isDev ? "bun" : path.join(options.resourceRoot, "bin", "bun");
    const entry = options.isDev
      ? path.join(options.appRoot, "apps", "backend", "src", "main.ts")
      : path.join(options.resourceRoot, "backend", "main.js");
    const args = [entry, "--port", String(options.gatewayPort ?? 34121),
      "--control-host", "127.0.0.1", "--control-port", "0",
      "--data-dir", options.dataDir, "--app-root", options.appRoot, "--resource-root", options.resourceRoot,
      "--renderer-root", options.isDev ? path.join(options.appRoot, "apps", "web", "dist") : path.join(options.resourceRoot, "web")];
    if (options.toolchainBinDir) args.push("--toolchain-bin-dir", options.toolchainBinDir);
    if (options.desktopWebClient) {
      args.push(
        "--desktop-web-client",
        "--host", "127.0.0.1",
        "--allow-non-tailscale-bind",
        "--allowed-origins", HOSTED_WEB_CLIENT_ORIGINS.join(","),
      );
      if (options.tailscaleExecutable) args.push("--tailscale-bin", options.tailscaleExecutable);
    } else if (options.gatewayHost) {
      args.push("--host", options.gatewayHost);
    } else {
      args.push("--fallback-host", options.fallbackGatewayHost ?? "127.0.0.1");
    }
    if (options.allowNonTailscaleBind) args.push("--allow-non-tailscale-bind");
    if (options.rendererDevServerUrl) args.push("--renderer-dev-server-url", options.rendererDevServerUrl);

    // Isolate desktop startup from any remote-service configuration in the parent shell.
    const env = createBackendProcessEnvironment(process.env, options.isDev, options.resourceRoot);
    const child = spawn(bun, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stderr?.on("data", (chunk) => process.stderr.write(`[Backend] ${chunk}`));

    let startupComplete = false;
    let unexpectedExitReported = false;
    let rejectStartup: ((error: Error) => void) | null = null;
    const clearState = () => {
      if (this.child !== child) return;
      this.client?.stopListening();
      this.client = null;
      this.child = null;
      this.info = null;
    };
    const childFailure = (error: Error) => {
      rejectStartup?.(error);
      if (this.child !== child) return;
      clearState();
      if (startupComplete && !unexpectedExitReported) {
        unexpectedExitReported = true;
        options.onUnexpectedExit?.(error);
      }
    };
    child.once("error", (error) => childFailure(error));
    child.once("exit", (code, signal) => childFailure(new Error(
      `Backend service exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})`,
    )));

    try {
      const ready = await new Promise<ReadyMessage>((resolve, reject) => {
        rejectStartup = reject;
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for the backend service")), 30_000);
        if (!child.stdout) {
          clearTimeout(timeout);
          reject(new Error("Backend service stdout is unavailable"));
          return;
        }
        const lines = createInterface({ input: child.stdout });
        const finish = (message: ReadyMessage) => {
          clearTimeout(timeout);
          rejectStartup = null;
          resolve(message);
        };
        lines.on("line", (line) => {
          try {
            const message = JSON.parse(line) as Partial<ReadyMessage>;
            if (
              message.type !== "orkestrator-backend-ready"
              || typeof message.url !== "string"
              || typeof message.authFile !== "string"
              || typeof message.bindAddress !== "string"
              || typeof message.port !== "number"
            ) return;
            finish(message as ReadyMessage);
          } catch {
            process.stdout.write(`[Backend] ${line}\n`);
          }
        });
      });
      const auth = JSON.parse(await readFile(ready.authFile, "utf8")) as { token?: unknown };
      if (typeof auth.token !== "string" || auth.token.length < 16) {
        throw new Error("Backend authentication file does not contain a valid token");
      }
      if (this.child !== child || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Backend service exited during startup");
      }
      this.info = ready;
      this.client = new BackendHttpClient(ready.url, auth.token);
      this.client.listen(options.onEvent);
      startupComplete = true;
      return this.client;
    } catch (error) {
      rejectStartup = null;
      clearState();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw error;
    }
  }

  getInfo(): GatewayStartInfo | null { return this.info; }

  stop(): void {
    this.client?.stopListening();
    this.child?.kill("SIGTERM");
    this.client = null;
    this.child = null;
    this.info = null;
  }
}
