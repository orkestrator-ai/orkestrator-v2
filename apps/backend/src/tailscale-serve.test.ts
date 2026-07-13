import { describe, expect, mock, test } from "bun:test";
import {
  extractTailscaleServeUrl,
  TailscaleServeManager,
  type TailscaleCommandRunner,
} from "./tailscale-serve.js";

describe("Tailscale Serve manager", () => {
  test("extracts the advertised HTTPS origin", () => {
    expect(extractTailscaleServeUrl(`
      Available within your tailnet:
      https://workstation.example.ts.net
      |-- / proxy http://127.0.0.1:34121
    `)).toBe("https://workstation.example.ts.net/");
  });

  test("configures and removes an owned HTTPS listener", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = mock(async (command: string, args: string[]) => {
      calls.push({ command, args });
      return {
        stdout: args.includes("off") ? "" : "Available within your tailnet:\nhttps://workstation.example.ts.net\n",
        stderr: "",
      };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("/opt/tailscale", run);

    await expect(manager.start(34121, 8443)).resolves.toBe(
      "https://workstation.example.ts.net/",
    );
    await manager.stop();

    expect(calls).toEqual([
      {
        command: "/opt/tailscale",
        args: [
          "serve",
          "--bg",
          "--yes",
          "--https=8443",
          "http://127.0.0.1:34121",
        ],
      },
      {
        command: "/opt/tailscale",
        args: ["serve", "--https=8443", "off"],
      },
    ]);
  });

  test("falls back to the Serve status output when setup is quiet", async () => {
    const run = mock(async (_command: string, args: string[]) => ({
      stdout: args.includes("status")
        ? "https://workstation.example.ts.net |-- / proxy http://127.0.0.1:34121"
        : "",
      stderr: "",
    })) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.start(34121)).resolves.toBe(
      "https://workstation.example.ts.net/",
    );
    expect(run).toHaveBeenCalledWith("tailscale", ["serve", "status"]);
  });

  test("surfaces command failures without claiming a listener", async () => {
    const run = mock(async () => {
      const error = new Error("command failed") as Error & { stderr?: string };
      error.stderr = "Tailscale is not running";
      throw error;
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.start(34121)).rejects.toThrow(
      "Unable to configure Tailscale Serve: Tailscale is not running",
    );
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});
