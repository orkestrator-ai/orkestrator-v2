import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { GatewayTokenSettings } from "@orkestrator/protocol/web-client";

export type GatewayStartInfo = {
  bindAddress: string;
  port: number;
  url: string;
  token: string;
  authFile: string;
};

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
}

export class BackendProcess {
  private child: ChildProcess | null = null;
  private client: BackendHttpClient | null = null;
  private info: GatewayStartInfo | null = null;

  async start(options: {
    isDev: boolean;
    appRoot: string;
    resourceRoot: string;
    dataDir: string;
    rendererDevServerUrl?: string;
    onEvent: (event: string, payload: unknown) => void;
  }): Promise<BackendHttpClient> {
    if (this.client) return this.client;
    const bun = options.isDev ? "bun" : path.join(options.resourceRoot, "bin", "bun");
    const entry = options.isDev
      ? path.join(options.appRoot, "apps", "backend", "src", "main.ts")
      : path.join(options.resourceRoot, "backend", "main.js");
    const args = [entry, "--host", "127.0.0.1", "--port", "0", "--unsafe-allow-non-tailscale-bind",
      "--data-dir", options.dataDir, "--app-root", options.appRoot, "--resource-root", options.resourceRoot,
      "--renderer-root", options.isDev ? path.join(options.appRoot, "apps", "web", "dist") : path.join(options.resourceRoot, "web")];
    if (options.rendererDevServerUrl) args.push("--renderer-dev-server-url", options.rendererDevServerUrl);

    // Isolate desktop startup from any remote-service configuration in the parent shell.
    const env: NodeJS.ProcessEnv = { ...process.env, ORKESTRATOR_GATEWAY_DISABLED: "0" };
    if (!options.isDev) {
      env.NODE_PATH = [path.join(options.resourceRoot, "backend", "vendor"), env.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter);
    }
    delete env.ORKESTRATOR_GATEWAY_HOST;
    delete env.ORKESTRATOR_GATEWAY_PORT;
    delete env.ORKESTRATOR_GATEWAY_TOKEN;
    this.child = spawn(bun, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stderr?.on("data", (chunk) => process.stderr.write(`[Backend] ${chunk}`));

    const ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the backend service")), 30_000);
      if (!this.child?.stdout) return reject(new Error("Backend service stdout is unavailable"));
      const lines = createInterface({ input: this.child.stdout });
      const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
      this.child!.once("error", fail);
      this.child!.once("exit", (code) => fail(new Error(`Backend service exited before startup (code ${code ?? "unknown"})`)));
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line) as Partial<ReadyMessage>;
          if (message.type !== "orkestrator-backend-ready" || typeof message.url !== "string" || typeof message.token !== "string") return;
          clearTimeout(timeout);
          resolve(message as ReadyMessage);
        } catch {
          process.stdout.write(`[Backend] ${line}\n`);
        }
      });
    });
    this.info = ready;
    this.client = new BackendHttpClient(ready.url, ready.token);
    this.client.listen(options.onEvent);
    return this.client;
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
