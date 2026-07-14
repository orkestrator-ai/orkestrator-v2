import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;

export type TailscaleCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: TailscaleCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    // The macOS app bundle uses this flag to select CLI behavior when it is
    // launched from a non-interactive child process.
    env: { ...process.env, TAILSCALE_BE_CLI: process.env.TAILSCALE_BE_CLI ?? "true" },
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export function extractTailscaleServeUrl(output: string): string | null {
  for (const match of output.matchAll(/https:\/\/[^\s|]+/g)) {
    const candidate = match[0].replace(/[),.;]+$/, "");
    try {
      const url = new URL(candidate);
      return `${url.origin}/`;
    } catch {
      // Continue looking for a valid HTTPS origin.
    }
  }
  return null;
}

export function getTailscaleServeTargetPort(browserUrl: string): number {
  const target = new URL(browserUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    throw new Error("Tailscale Serve requires the backend browser listener to use http://127.0.0.1");
  }

  const port = target.port ? Number.parseInt(target.port, 10) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid backend browser listener port: ${target.port || "default"}`);
  }
  return port;
}

type ServeStatus = {
  TCP?: Record<string, unknown>;
  Web?: Record<string, {
    Handlers?: Record<string, { Proxy?: unknown }>;
  }>;
};

function parseServeStatus(output: string): ServeStatus {
  let status: unknown;
  try {
    status = JSON.parse(output);
  } catch {
    throw new Error("Tailscale Serve returned invalid status JSON");
  }
  if (!status || typeof status !== "object" || Array.isArray(status)) return {};
  return status as ServeStatus;
}

function configuredPort(status: ServeStatus, port: number): boolean {
  const tcp = status.TCP;
  return Boolean(tcp && typeof tcp === "object" && !Array.isArray(tcp) && String(port) in tcp);
}

function expectedProxyTarget(targetPort: number): string {
  return `http://127.0.0.1:${targetPort}`;
}

function ownedServeUrl(status: ServeStatus, targetPort: number, httpsPort: number): string | null {
  const expectedTarget = expectedProxyTarget(targetPort);
  for (const [hostPort, server] of Object.entries(status.Web ?? {})) {
    const separator = hostPort.lastIndexOf(":");
    if (separator < 0 || Number.parseInt(hostPort.slice(separator + 1), 10) !== httpsPort) continue;
    if (server?.Handlers?.["/"]?.Proxy !== expectedTarget) continue;
    try {
      return `${new URL(`https://${hostPort}`).origin}/`;
    } catch {
      return null;
    }
  }
  return null;
}

function commandError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string }).stderr?.trim();
  return stderr || error.message;
}

export class TailscaleServeManager {
  private activeHttpsPort: number | null = null;

  constructor(
    private readonly executable = "tailscale",
    private readonly run: TailscaleCommandRunner = defaultRunner,
  ) {}

  async start(
    targetPort: number,
    httpsPort = 443,
    options: { adoptExisting?: boolean } = {},
  ): Promise<string> {
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw new Error(`Invalid Tailscale Serve target port: ${targetPort}`);
    }
    if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) {
      throw new Error(`Invalid Tailscale Serve HTTPS port: ${httpsPort}`);
    }

    let existingStatus: { stdout: string; stderr: string };
    try {
      existingStatus = await this.run(this.executable, ["serve", "status", "--json"]);
    } catch (error) {
      throw new Error(`Unable to inspect Tailscale Serve configuration: ${commandError(error)}`);
    }
    const status = parseServeStatus(existingStatus.stdout);
    if (configuredPort(status, httpsPort)) {
      const existingUrl = ownedServeUrl(status, targetPort, httpsPort);
      if (options.adoptExisting && existingUrl) {
        this.activeHttpsPort = httpsPort;
        return existingUrl;
      }
      throw new Error(
        `Refusing to replace the existing Tailscale Serve configuration on HTTPS port ${httpsPort}`,
      );
    }

    const args = [
      "serve",
      "--bg",
      "--yes",
      `--https=${httpsPort}`,
      `http://127.0.0.1:${targetPort}`,
    ];

    let result: { stdout: string; stderr: string };
    try {
      result = await this.run(this.executable, args);
    } catch (error) {
      throw new Error(`Unable to configure Tailscale Serve: ${commandError(error)}`);
    }
    this.activeHttpsPort = httpsPort;

    let url = extractTailscaleServeUrl(`${result.stdout}\n${result.stderr}`);
    if (!url) {
      try {
        const status = await this.run(this.executable, ["serve", "status"]);
        url = extractTailscaleServeUrl(`${status.stdout}\n${status.stderr}`);
      } catch (error) {
        throw new Error(`Tailscale Serve started, but its HTTPS URL could not be read: ${commandError(error)}`);
      }
    }
    if (!url) {
      throw new Error("Tailscale Serve started, but did not report an HTTPS URL");
    }

    return url;
  }

  async stop(): Promise<void> {
    const httpsPort = this.activeHttpsPort;
    if (httpsPort === null) return;
    await this.run(this.executable, ["serve", `--https=${httpsPort}`, "off"]);
    this.activeHttpsPort = null;
  }

  async stopOwned(targetPort: number, httpsPort = 443): Promise<boolean> {
    let existingStatus: { stdout: string; stderr: string };
    try {
      existingStatus = await this.run(this.executable, ["serve", "status", "--json"]);
    } catch (error) {
      throw new Error(`Unable to inspect Tailscale Serve configuration: ${commandError(error)}`);
    }
    const status = parseServeStatus(existingStatus.stdout);
    if (!configuredPort(status, httpsPort)) return false;
    if (!ownedServeUrl(status, targetPort, httpsPort)) {
      throw new Error(
        `Refusing to remove a changed Tailscale Serve configuration on HTTPS port ${httpsPort}`,
      );
    }
    await this.run(this.executable, ["serve", `--https=${httpsPort}`, "off"]);
    if (this.activeHttpsPort === httpsPort) this.activeHttpsPort = null;
    return true;
  }
}
