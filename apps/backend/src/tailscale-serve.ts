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

  async start(targetPort: number, httpsPort = 443): Promise<string> {
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
    this.activeHttpsPort = null;
    await this.run(this.executable, ["serve", `--https=${httpsPort}`, "off"]);
  }
}
