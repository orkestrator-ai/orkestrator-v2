import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
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

const AGENT_TEST_SAFE_ENV_NAMES = new Set([
  "BUN_INSTALL",
  "CI",
  "COLORTERM",
  // Where the Docker daemon is, not who may talk to it. Stripping these sends
  // every `docker` call to the built-in default context, which is wrong for
  // Colima, Rancher Desktop, rootless Podman, a remote daemon, and Docker
  // Desktop without the default-socket shim.
  "DOCKER_CERT_PATH",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "FORCE_COLOR",
  "LANG",
  "LOGNAME",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "NODE_PATH",
  "NO_COLOR",
  "ORKESTRATOR_AGENT_INTERACTION_MONITOR_KILL_SWITCH",
  "ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY",
  "ORKESTRATOR_GATEWAY_DISABLED",
  "ORKESTRATOR_VERSION",
  "PATH",
  "PWD",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
]);

function retainSafeAgentTestEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (!AGENT_TEST_SAFE_ENV_NAMES.has(name) && !name.startsWith("LC_")) delete env[name];
  }
}

/** Isolated replacement for `~/.docker`, pointed at by `DOCKER_CONFIG`. */
export function agentTestDockerConfigDir(isolatedCredentialRoot: string): string {
  return path.join(isolatedCredentialRoot, "docker-disabled");
}

export function agentTestKeychainDir(isolatedCredentialRoot: string): string {
  return path.join(isolatedCredentialRoot, "home", "Library", "Keychains");
}

/**
 * Remove the legacy host-Keychain link created by older agent-test profiles.
 *
 * Linking the complete writable login Keychain into a HOME used by terminals and
 * repository-controlled subprocesses exposed unrelated services and survived a
 * later credential opt-out. Current profiles broker provider-specific secrets at
 * bridge startup instead, so every launch reconciles this managed target even
 * when no Keychain-backed provider is authorized.
 *
 * A real directory is profile-owned state and must never be removed here.
 */
export async function removeAgentTestHostKeychainLink(
  isolatedCredentialRoot: string,
): Promise<boolean> {
  const target = agentTestKeychainDir(isolatedCredentialRoot);
  const existing = await lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;
  await rm(target, { force: true });
  return true;
}

export function hostDockerConfigDir(
  parentEnv: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  return parentEnv.DOCKER_CONFIG?.trim() || path.join(homeDir, ".docker");
}

/**
 * Give the isolated `DOCKER_CONFIG` enough of the host's configuration to reach
 * the same daemon, and nothing more.
 *
 * `contexts/` and `currentContext` are topology: without them the CLI silently
 * falls back to the built-in `unix:///var/run/docker.sock`, which is not where
 * Colima, Rancher Desktop, or Docker Desktop without the default-socket shim
 * listen. `auths`, `credsStore`, and every other key are credentials and stay
 * behind — that is the point of the isolated directory.
 *
 * Best-effort: a profile whose Docker configuration cannot be read still starts,
 * it just falls back to the default context the way it did before.
 */
export async function seedAgentTestDockerConfig(options: {
  isolatedCredentialRoot: string;
  sourceDir: string;
}): Promise<void> {
  const target = agentTestDockerConfigDir(options.isolatedCredentialRoot);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(path.join(options.sourceDir, "contexts"), path.join(target, "contexts"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  const parsed = await readFile(path.join(options.sourceDir, "config.json"), "utf8")
    .then((contents) => JSON.parse(contents) as unknown)
    .catch(() => null);
  const currentContext =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { currentContext?: unknown }).currentContext
      : undefined;
  await writeFile(
    path.join(target, "config.json"),
    `${JSON.stringify(typeof currentContext === "string" && currentContext ? { currentContext } : {}, null, 2)}\n`,
    { mode: 0o600 },
  );
}

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
  appVersion?: string,
  runtime?: {
    flavor: "production" | "development" | "agent-test";
    credentialSources?: readonly string[];
    isolatedCredentialRoot?: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv, ORKESTRATOR_GATEWAY_DISABLED: "0" };
  const version = appVersion?.trim();
  if (version) {
    // Always prefer Electron's authoritative application version over a value
    // inherited from the shell that launched the desktop app.
    env.ORKESTRATOR_VERSION = version;
  } else {
    // An empty or blank version is absent, not a version. Exporting `""` would
    // leave the backend and both bridges reading a defined-but-useless value
    // instead of falling back to their own default, and it would still shadow
    // whatever the shell had set.
    delete env.ORKESTRATOR_VERSION;
  }
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
  delete env.ORKESTRATOR_RUNTIME_FLAVOR;
  delete env.ORKESTRATOR_WORKTREE_DIR;
  delete env.ORKESTRATOR_DOCKER_IMAGE;
  delete env.ORKESTRATOR_CREDENTIAL_SOURCE;
  delete env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
  delete env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
  if (runtime?.flavor === "agent-test") {
    const allowed = new Set(runtime.credentialSources ?? []);
    const inherited = { ...parentEnv };
    const inheritedHome = inherited.HOME?.trim();
    retainSafeAgentTestEnvironment(env);
    env.ORKESTRATOR_AGENT_TEST_ISOLATED = "1";
    if (runtime.isolatedCredentialRoot) {
      const isolatedHome = path.join(runtime.isolatedCredentialRoot, "home");
      env.HOME = isolatedHome;
      if (inheritedHome) env.ORKESTRATOR_AGENT_TEST_HOST_HOME = inheritedHome;
      env.GH_CONFIG_DIR = path.join(runtime.isolatedCredentialRoot, "github-disabled");
      env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
      env.NPM_CONFIG_USERCONFIG = path.join(runtime.isolatedCredentialRoot, "npmrc-disabled");
      env.DOCKER_CONFIG = agentTestDockerConfigDir(runtime.isolatedCredentialRoot);
      env.AWS_CONFIG_FILE = path.join(runtime.isolatedCredentialRoot, "aws", "config");
      env.AWS_SHARED_CREDENTIALS_FILE = path.join(
        runtime.isolatedCredentialRoot,
        "aws",
        "credentials",
      );
      env.AWS_EC2_METADATA_DISABLED = "true";
      env.KUBECONFIG = path.join(runtime.isolatedCredentialRoot, "kube", "config");
      env.AZURE_CONFIG_DIR = path.join(runtime.isolatedCredentialRoot, "azure");
      env.CLOUDSDK_CONFIG = path.join(runtime.isolatedCredentialRoot, "google");
    }
    if (allowed.has("claude")) {
      if (inherited.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = inherited.ANTHROPIC_API_KEY;
      const claudeConfigDir =
        inherited.CLAUDE_CONFIG_DIR?.trim() ||
        (inheritedHome ? path.join(inheritedHome, ".claude") : undefined);
      if (claudeConfigDir) {
        env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = claudeConfigDir;
      }
    }
    if (runtime.isolatedCredentialRoot) {
      env.CLAUDE_CONFIG_DIR = path.join(runtime.isolatedCredentialRoot, "claude");
    }
    if (allowed.has("codex")) {
      if (inherited.OPENAI_API_KEY) env.OPENAI_API_KEY = inherited.OPENAI_API_KEY;
      const codexHome =
        inherited.CODEX_HOME?.trim() ||
        (inheritedHome ? path.join(inheritedHome, ".codex") : undefined);
      if (codexHome) env.CODEX_HOME = codexHome;
    } else if (runtime.isolatedCredentialRoot) {
      env.CODEX_HOME = path.join(runtime.isolatedCredentialRoot, "codex");
    }
    if (allowed.has("opencode")) {
      if (inherited.OPENCODE_API_KEY) env.OPENCODE_API_KEY = inherited.OPENCODE_API_KEY;
      const configHome =
        inherited.XDG_CONFIG_HOME?.trim() ||
        (inheritedHome ? path.join(inheritedHome, ".config") : undefined);
      const dataHome =
        inherited.XDG_DATA_HOME?.trim() ||
        (inheritedHome ? path.join(inheritedHome, ".local", "share") : undefined);
      const stateHome =
        inherited.XDG_STATE_HOME?.trim() ||
        (inheritedHome ? path.join(inheritedHome, ".local", "state") : undefined);
      if (configHome) env.XDG_CONFIG_HOME = configHome;
      if (dataHome) env.XDG_DATA_HOME = dataHome;
      if (stateHome) env.XDG_STATE_HOME = stateHome;
    } else if (runtime.isolatedCredentialRoot) {
      env.XDG_CONFIG_HOME = path.join(runtime.isolatedCredentialRoot, "xdg-config");
      env.XDG_DATA_HOME = path.join(runtime.isolatedCredentialRoot, "xdg-data");
      env.XDG_STATE_HOME = path.join(runtime.isolatedCredentialRoot, "xdg-state");
    }
    if (allowed.has("cursor") && inherited.CURSOR_API_KEY) {
      env.CURSOR_API_KEY = inherited.CURSOR_API_KEY;
    }
  }
  return env;
}

type ReadyMessage = GatewayStartInfo & { type: "orkestrator-backend-ready" };

export class BackendHttpClient {
  private abortEvents: AbortController | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(new URL("/__orkestrator/invoke", this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    const payload = (await response.json()) as { result?: T; error?: string };
    if (!response.ok)
      throw new Error(payload.error ?? `Backend request failed with HTTP ${response.status}`);
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

  private async consumeEvents(
    signal: AbortSignal,
    onEvent: (event: string, payload: unknown) => void,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await fetch(new URL("/__orkestrator/events", this.baseUrl), {
          headers: { authorization: `Bearer ${this.token}` },
          signal,
        });
        if (!response.ok || !response.body)
          throw new Error(`Backend event stream returned HTTP ${response.status}`);
        // Keep this in sync with NATIVE_EVENT_STREAM_CONNECTED_EVENT in the
        // renderer's native/events module. The transport has no replay buffer,
        // so consumers must authoritatively refetch after every connection.
        onEvent("native-event-stream-connected", undefined);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let pending = "";
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += value;
          const messages = pending.split("\n\n");
          pending = messages.pop() ?? "";
          for (const message of messages) {
            const data = message
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6);
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

  private async gatewaySettings(
    method: "GET" | "PUT",
    body?: { token: string },
  ): Promise<GatewayTokenSettings> {
    const response = await fetch(new URL("/__orkestrator/gateway-settings", this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json()) as GatewayTokenSettings & { error?: string };
    if (!response.ok)
      throw new Error(
        payload.error ?? `Backend settings request failed with HTTP ${response.status}`,
      );
    return payload;
  }

  private async webClientAccess(
    method: "GET" | "PUT" | "DELETE",
    body?: { enabled: boolean },
  ): Promise<WebClientStatus> {
    const response = await fetch(new URL("/__orkestrator/web-client-access", this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json()) as WebClientStatus & { error?: string };
    if (!response.ok)
      throw new Error(
        payload.error ?? `Backend web client request failed with HTTP ${response.status}`,
      );
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
    appVersion?: string;
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
    runtimeFlavor?: "production" | "development" | "agent-test";
    runtimeProfileId?: string;
    worktreeDir?: string;
    dockerImage?: string;
    strictDockerOwner?: boolean;
    strictGatewayPort?: boolean;
    credentialSources?: AgentPlatform[];
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
    appVersion?: string;
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
    runtimeFlavor?: "production" | "development" | "agent-test";
    runtimeProfileId?: string;
    worktreeDir?: string;
    dockerImage?: string;
    strictDockerOwner?: boolean;
    strictGatewayPort?: boolean;
    credentialSources?: AgentPlatform[];
    onEvent: (event: string, payload: unknown) => void;
    onUnexpectedExit?: (error: Error) => void;
  }): Promise<BackendHttpClient> {
    const bun = options.isDev ? "bun" : path.join(options.resourceRoot, "bin", "bun");
    const entry = options.isDev
      ? path.join(options.appRoot, "apps", "backend", "src", "main.ts")
      : path.join(options.resourceRoot, "backend", "main.js");
    const args = [
      entry,
      "--port",
      String(options.gatewayPort ?? 34121),
      "--control-host",
      "127.0.0.1",
      "--control-port",
      "0",
      "--data-dir",
      options.dataDir,
      "--app-root",
      options.appRoot,
      "--resource-root",
      options.resourceRoot,
      "--renderer-root",
      options.isDev
        ? path.join(options.appRoot, "apps", "web", "dist")
        : path.join(options.resourceRoot, "web"),
    ];
    if (options.toolchainBinDir) args.push("--toolchain-bin-dir", options.toolchainBinDir);
    if (options.desktopWebClient) {
      args.push(
        "--desktop-web-client",
        "--host",
        "127.0.0.1",
        "--allow-non-tailscale-bind",
        "--allowed-origins",
        HOSTED_WEB_CLIENT_ORIGINS.join(","),
      );
      if (options.tailscaleExecutable) args.push("--tailscale-bin", options.tailscaleExecutable);
    } else if (options.gatewayHost) {
      args.push("--host", options.gatewayHost);
    } else {
      args.push("--fallback-host", options.fallbackGatewayHost ?? "127.0.0.1");
    }
    if (options.allowNonTailscaleBind) args.push("--allow-non-tailscale-bind");
    if (options.rendererDevServerUrl)
      args.push("--renderer-dev-server-url", options.rendererDevServerUrl);
    if (options.runtimeFlavor) args.push("--runtime-flavor", options.runtimeFlavor);
    if (options.runtimeProfileId) args.push("--runtime-profile-id", options.runtimeProfileId);
    if (options.worktreeDir) args.push("--worktree-dir", options.worktreeDir);
    if (options.dockerImage) args.push("--docker-image", options.dockerImage);
    if (options.strictDockerOwner) args.push("--strict-docker-owner");
    if (options.strictGatewayPort) args.push("--strict-gateway-port");
    if (options.credentialSources?.length)
      args.push("--credential-source", options.credentialSources.join(","));

    // Isolate desktop startup from any remote-service configuration in the parent shell.
    const isolatedCredentialRoot = path.join(options.dataDir, "agent-credentials");
    const env = createBackendProcessEnvironment(
      process.env,
      options.isDev,
      options.resourceRoot,
      options.appVersion,
      options.runtimeFlavor
        ? {
            flavor: options.runtimeFlavor,
            credentialSources: options.credentialSources,
            isolatedCredentialRoot,
          }
        : undefined,
    );
    if (options.runtimeFlavor === "agent-test") {
      await seedAgentTestDockerConfig({
        isolatedCredentialRoot,
        sourceDir: hostDockerConfigDir(process.env),
      }).catch((error: unknown) => {
        console.warn(
          "[Desktop] Could not seed the isolated Docker context; falling back to the default context:",
          error,
        );
      });
      await removeAgentTestHostKeychainLink(isolatedCredentialRoot).catch((error: unknown) => {
        console.warn(
          "[Desktop] Could not remove a legacy host Keychain link from the isolated profile:",
          error,
        );
      });
    }
    const child = spawn(bun, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stderr?.on("data", (chunk) => console.error(`[Backend] ${String(chunk)}`.trimEnd()));

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
    child.once("exit", (code, signal) =>
      childFailure(
        new Error(`Backend service exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})`),
      ),
    );

    try {
      const ready = await new Promise<ReadyMessage>((resolve, reject) => {
        rejectStartup = reject;
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for the backend service")),
          30_000,
        );
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
              message.type !== "orkestrator-backend-ready" ||
              typeof message.url !== "string" ||
              typeof message.authFile !== "string" ||
              typeof message.bindAddress !== "string" ||
              typeof message.port !== "number"
            )
              return;
            finish(message as ReadyMessage);
          } catch {
            console.log(`[Backend] ${line}`);
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

  getInfo(): GatewayStartInfo | null {
    return this.info;
  }

  getPid(): number | undefined {
    return this.child?.pid;
  }

  stop(): void {
    this.client?.stopListening();
    this.child?.kill("SIGTERM");
    this.client = null;
    this.child = null;
    this.info = null;
  }
}
