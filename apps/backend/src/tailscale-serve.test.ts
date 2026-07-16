import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractTailscaleServeUrl,
  getTailscaleServeTargetPort,
  TailscaleServeConflictError,
  TailscaleServeManager,
  type TailscaleCommandRunner,
} from "./tailscale-serve.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function failure(message: string, stderr?: string): Error {
  const error = new Error(message) as Error & { stderr?: string };
  error.stderr = stderr;
  return error;
}

describe("Tailscale Serve helpers", () => {
  test("extracts and normalizes an advertised HTTPS origin", () => {
    expect(extractTailscaleServeUrl(`
      Available within your tailnet:
      https://workstation.example.ts.net:8443/path,
      |-- / proxy http://127.0.0.1:34121
    `)).toBe("https://workstation.example.ts.net:8443/");
    expect(extractTailscaleServeUrl("no HTTPS address here")).toBeNull();
  });

  test("reads explicit and default IPv4 loopback listener ports", () => {
    expect(getTailscaleServeTargetPort("http://127.0.0.1:34121/")).toBe(34121);
    expect(getTailscaleServeTargetPort("http://127.0.0.1/")).toBe(80);
  });

  test("rejects listener URLs that Tailscale Serve cannot target safely", () => {
    expect(() => getTailscaleServeTargetPort("http://localhost:34121/")).toThrow("127.0.0.1");
    expect(() => getTailscaleServeTargetPort("http://[::1]:34121/")).toThrow("127.0.0.1");
    expect(() => getTailscaleServeTargetPort("https://127.0.0.1:34121/")).toThrow("127.0.0.1");
    expect(() => getTailscaleServeTargetPort("not a URL")).toThrow();
  });
});

describe("Tailscale Serve manager", () => {
  test("configures and removes only its owned HTTPS listener", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = mock(async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args.at(-1) === "--json") return { stdout: "{}", stderr: "" };
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
    await manager.stop();

    expect(calls).toEqual([
      { command: "/opt/tailscale", args: ["serve", "status", "--json"] },
      {
        command: "/opt/tailscale",
        args: ["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:34121"],
      },
      { command: "/opt/tailscale", args: ["serve", "--https=8443", "off"] },
    ]);
  });

  test("refuses to overwrite a pre-existing listener", async () => {
    const run = mock(async () => ({
      stdout: JSON.stringify({ TCP: { "443": { HTTPS: true } } }),
      stderr: "",
    })) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.start(34121)).rejects.toThrow("Refusing to replace");
    await manager.stop();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("clears every path handler on only the selected HTTPS listener", async () => {
    const runMock = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        return {
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
            Web: {
              "workstation.example.ts.net:443": {
                Handlers: {
                  "/": { Proxy: "http://127.0.0.1:3000" },
                  "/api": { Proxy: "http://127.0.0.1:3001" },
                  "/docs": { Proxy: "http://127.0.0.1:3002" },
                },
              },
              "workstation.example.ts.net:8443": {
                Handlers: { "/other": { Proxy: "http://127.0.0.1:4000" } },
              },
            },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const run: TailscaleCommandRunner = runMock;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.clearHttpsPort(443)).resolves.toBeUndefined();
    expect(runMock.mock.calls.map((call) => call[1])).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--https=443", "--set-path=/api", "off"],
      ["serve", "--https=443", "--set-path=/docs", "off"],
      ["serve", "--https=443", "off"],
    ]);

    await expect(manager.clearHttpsPort(0)).rejects.toThrow("Invalid Tailscale Serve HTTPS port");
    expect(run).toHaveBeenCalledTimes(4);
  });

  test("no-ops an absent reset and refuses a non-HTTPS listener", async () => {
    const runMock = mock(async (_command: string, args: string[]) => ({
      stdout: args.at(-1) === "--json"
        ? JSON.stringify({ TCP: { "8443": { TCPForward: "127.0.0.1:3000" } } })
        : "",
      stderr: "",
    }));
    const run: TailscaleCommandRunner = runMock;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.clearHttpsPort(443)).resolves.toBeUndefined();
    await expect(manager.clearHttpsPort(8443)).rejects.toThrow("non-HTTPS");

    const conflict = await manager.start(34121, 8443).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(TailscaleServeConflictError);
    expect(conflict).toMatchObject({ resetAvailable: false });
    expect(runMock.mock.calls.every((call) => call[1]?.includes("--json"))).toBe(true);
  });

  test("surfaces status inspection and individual handler reset failures", async () => {
    const inspectionFailed = mock(async () => {
      throw failure("reset failed", "permission denied");
    }) as TailscaleCommandRunner;

    await expect(new TailscaleServeManager("tailscale", inspectionFailed).clearHttpsPort()).rejects.toThrow(
      "Unable to inspect Tailscale Serve configuration for reset: permission denied",
    );

    const handlerFailed = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        return {
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "workstation.example.ts.net:443": { Handlers: { "/api": {} } } },
          }),
          stderr: "",
        };
      }
      throw failure("reset failed", "daemon unavailable");
    }) as TailscaleCommandRunner;
    await expect(new TailscaleServeManager("tailscale", handlerFailed).clearHttpsPort()).rejects.toThrow(
      "Unable to reset Tailscale Serve handler /api: daemon unavailable",
    );
  });

  test("adopts and removes an existing listener only when its proxy target matches", async () => {
    const calls: string[][] = [];
    const run = mock(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args.at(-1) === "--json") {
        return {
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: {
              "workstation.example.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:34121" } },
              },
            },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.start(34121, 443, { adoptExisting: true })).resolves.toBe(
      "https://workstation.example.ts.net/",
    );
    await manager.stop();

    expect(calls).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--https=443", "off"],
    ]);
  });

  test("does not adopt or remove a listener whose proxy target changed", async () => {
    const run = mock(async () => ({
      stdout: JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: {
          "workstation.example.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
          },
        },
      }),
      stderr: "",
    })) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.start(34121, 443, { adoptExisting: true })).rejects.toThrow(
      "Refusing to replace",
    );
    await expect(manager.stopOwned(34121, 443)).rejects.toThrow(
      "Refusing to remove a changed",
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("removes a matching persisted listener and no-ops when it is absent", async () => {
    let configured = true;
    const run = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        return {
          stdout: configured
            ? JSON.stringify({
                TCP: { "8443": { HTTPS: true } },
                Web: {
                  "workstation.example.ts.net:8443": {
                    Handlers: { "/": { Proxy: "http://127.0.0.1:41234" } },
                  },
                },
              })
            : "{}",
          stderr: "",
        };
      }
      configured = false;
      return { stdout: "", stderr: "" };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.stopOwned(41234, 8443)).resolves.toBe(true);
    await expect(manager.stopOwned(41234, 8443)).resolves.toBe(false);
    expect(run).toHaveBeenCalledWith("tailscale", ["serve", "--https=8443", "off"]);
  });

  test("allows unrelated existing listeners", async () => {
    const run = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        return { stdout: JSON.stringify({ TCP: { "8443": { HTTPS: true } } }), stderr: "" };
      }
      return { stdout: "https://workstation.example.ts.net", stderr: "" };
    }) as TailscaleCommandRunner;

    await expect(new TailscaleServeManager("tailscale", run).start(34121, 443)).resolves.toBe(
      "https://workstation.example.ts.net/",
    );
  });

  test("falls back to text status when setup is quiet", async () => {
    const run = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") return { stdout: "{}", stderr: "" };
      return {
        stdout: args.includes("status")
          ? "https://workstation.example.ts.net |-- / proxy http://127.0.0.1:34121"
          : "",
        stderr: "",
      };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.start(34121)).resolves.toBe("https://workstation.example.ts.net/");
    expect(run).toHaveBeenCalledWith("tailscale", ["serve", "status"]);
  });

  test("reports invalid status JSON and status command failures", async () => {
    const invalid = mock(async () => ({ stdout: "not json", stderr: "" })) as TailscaleCommandRunner;
    await expect(new TailscaleServeManager("tailscale", invalid).start(34121)).rejects.toThrow(
      "invalid status JSON",
    );

    const failed = mock(async () => {
      throw failure("command failed", "Tailscale is not running");
    }) as TailscaleCommandRunner;
    await expect(new TailscaleServeManager("tailscale", failed).start(34121)).rejects.toThrow(
      "Unable to inspect Tailscale Serve configuration: Tailscale is not running",
    );
  });

  test("surfaces configure and URL discovery failures", async () => {
    const configureFailed = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") return { stdout: "{}", stderr: "" };
      throw failure("configure failed");
    }) as TailscaleCommandRunner;
    await expect(new TailscaleServeManager("tailscale", configureFailed).start(34121)).rejects.toThrow(
      "Unable to configure Tailscale Serve: configure failed",
    );

    const noUrl = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") return { stdout: "{}", stderr: "" };
      return { stdout: "", stderr: "" };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", noUrl);
    await expect(manager.start(34121)).rejects.toThrow("did not report an HTTPS URL");
    await manager.stop();

    let calls = 0;
    const statusFailed = mock(async (_command: string, args: string[]) => {
      calls += 1;
      if (args.at(-1) === "--json") return { stdout: "{}", stderr: "" };
      if (calls === 2) return { stdout: "", stderr: "" };
      throw failure("status failed", "daemon unavailable");
    }) as TailscaleCommandRunner;
    await expect(new TailscaleServeManager("tailscale", statusFailed).start(34121)).rejects.toThrow(
      "its HTTPS URL could not be read: daemon unavailable",
    );
  });

  test("validates target and HTTPS port boundaries", async () => {
    const run = mock(async () => ({ stdout: "{}", stderr: "" })) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      await expect(manager.start(port)).rejects.toThrow("Invalid Tailscale Serve target port");
    }
    await expect(manager.start(34121, 0)).rejects.toThrow("Invalid Tailscale Serve HTTPS port");
    expect(run).not.toHaveBeenCalled();
  });

  test("can retry cleanup after a transient stop failure", async () => {
    let stopAttempts = 0;
    const run = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") return { stdout: "{}", stderr: "" };
      if (args.includes("off")) {
        stopAttempts += 1;
        if (stopAttempts === 1) throw failure("temporary stop failure");
        return { stdout: "", stderr: "" };
      }
      return { stdout: "https://workstation.example.ts.net", stderr: "" };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await manager.start(34121);
    await expect(manager.stop()).rejects.toThrow("temporary stop failure");
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(stopAttempts).toBe(2);
  });

  test("runs the default command runner through an executable boundary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ork-tailscale-runner-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "tailscale");
    await writeFile(executable, `#!/bin/sh
if [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  printf '{}'
elif [ "$2" = "--https=443" ] && [ "$3" = "off" ]; then
  exit 0
else
  printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
fi
`);
    await chmod(executable, 0o755);

    const manager = new TailscaleServeManager(executable);
    await expect(manager.start(34121)).resolves.toBe("https://workstation.example.ts.net/");
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});
