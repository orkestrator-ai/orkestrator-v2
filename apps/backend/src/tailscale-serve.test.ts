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
    expect(extractTailscaleServeUrl(
      "https://[bad then https://valid.example.ts.net:8443/path",
    )).toBe("https://valid.example.ts.net:8443/");
  });

  test("reads explicit and default IPv4 loopback listener ports", () => {
    expect(getTailscaleServeTargetPort("http://127.0.0.1:34121/")).toBe(34121);
    expect(getTailscaleServeTargetPort("http://127.0.0.1/")).toBe(80);
    expect(getTailscaleServeTargetPort("http://127.0.0.1:1/")).toBe(1);
    expect(getTailscaleServeTargetPort("http://127.0.0.1:65535/")).toBe(65535);
  });

  test("rejects listener URLs that Tailscale Serve cannot target safely", () => {
    expect(() => getTailscaleServeTargetPort("http://localhost:34121/")).toThrow("127.0.0.1");
    expect(() => getTailscaleServeTargetPort("http://[::1]:34121/")).toThrow("127.0.0.1");
    expect(() => getTailscaleServeTargetPort("https://127.0.0.1:34121/")).toThrow("127.0.0.1");
    expect(() => getTailscaleServeTargetPort("not a URL")).toThrow();
    expect(() => getTailscaleServeTargetPort("http://127.0.0.1:0/")).toThrow("Invalid");
    expect(() => getTailscaleServeTargetPort("http://127.0.0.1:65536/")).toThrow();
  });
});

describe("Tailscale Serve manager", () => {
  test("configures and removes only its owned HTTPS listener", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let configured = false;
    const run = mock(async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args.at(-1) === "--json") {
        return {
          stdout: configured ? JSON.stringify({
            TCP: { "8443": { HTTPS: true } },
            Web: {
              "workstation.example.ts.net:8443": {
                Handlers: {
                  "/": { Proxy: "http://127.0.0.1:34121" },
                  "/api": { Proxy: "http://127.0.0.1:9000" },
                },
              },
            },
          }) : "{}",
          stderr: "",
        };
      }
      if (args.includes("--bg")) configured = true;
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
      { command: "/opt/tailscale", args: ["serve", "status", "--json"] },
      {
        command: "/opt/tailscale",
        args: ["serve", "--yes", "--https=8443", "--set-path=/", "off"],
      },
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
      ["serve", "--yes", "--https=443", "--set-path=/api", "off"],
      ["serve", "--yes", "--https=443", "--set-path=/docs", "off"],
      ["serve", "--yes", "--https=443", "off"],
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
    const runMock = mock(async (_command: string, args: string[]) => {
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
    });
    const run: TailscaleCommandRunner = runMock;
    const manager = new TailscaleServeManager("tailscale", run);

    await expect(manager.start(34121, 443, { adoptExisting: true })).resolves.toBe(
      "https://workstation.example.ts.net/",
    );
    await manager.stop();

    expect(calls).toEqual([
      ["serve", "status", "--json"],
      ["serve", "status", "--json"],
      ["serve", "--yes", "--https=443", "--set-path=/", "off"],
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
                    Handlers: {
                      "/": { Proxy: "http://127.0.0.1:41234" },
                      "/unrelated": { Proxy: "http://127.0.0.1:5000" },
                    },
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
    expect(run).toHaveBeenCalledWith(
      "tailscale",
      ["serve", "--yes", "--https=8443", "--set-path=/", "off"],
    );
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
    let statusChecks = 0;
    const run = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        statusChecks += 1;
        return {
          stdout: statusChecks === 1 ? "{}" : JSON.stringify({
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

  test("revalidates ownership before stopping and preserves changed configuration", async () => {
    let statusChecks = 0;
    const runMock = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        statusChecks += 1;
        return {
          stdout: statusChecks === 1 ? "{}" : JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: {
              "workstation.example.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
              },
            },
          }),
          stderr: "",
        };
      }
      return { stdout: "https://workstation.example.ts.net", stderr: "" };
    });
    const run: TailscaleCommandRunner = runMock;
    const manager = new TailscaleServeManager("tailscale", run);

    await manager.start(34121);
    await expect(manager.stop()).rejects.toThrow("Refusing to remove a changed");
    expect(runMock.mock.calls.some((call) => call[1].includes("off"))).toBe(false);
  });

  test("normalizes non-object statuses and malformed nested status sections", async () => {
    for (const status of ["null", "true", "42", "[]", '{"TCP":null,"Web":[]}']) {
      const run = mock(async () => ({ stdout: status, stderr: "" })) as TailscaleCommandRunner;
      await expect(new TailscaleServeManager("tailscale", run).clearHttpsPort()).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  test("resets an HTTPS listener even when status reports no Web handlers", async () => {
    const run = mock(async (_command: string, args: string[]) => ({
      stdout: args.at(-1) === "--json"
        ? JSON.stringify({ TCP: { "443": { HTTPS: true } } })
        : "",
      stderr: "",
    })) as TailscaleCommandRunner;

    await new TailscaleServeManager("tailscale", run).clearHttpsPort();
    expect(run).toHaveBeenLastCalledWith(
      "tailscale",
      ["serve", "--yes", "--https=443", "off"],
    );
  });

  test("clears tracked state when stopOwned status no longer contains the active listener", async () => {
    let statusChecks = 0;
    const run = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        statusChecks += 1;
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "https://workstation.example.ts.net", stderr: "" };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await manager.start(34121);
    await expect(manager.stopOwned(34121)).resolves.toBe(false);
    await manager.stop();
    expect(statusChecks).toBe(2);
  });

  test("clears tracked state when reset status no longer contains the active listener", async () => {
    let statusChecks = 0;
    const run = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        statusChecks += 1;
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "https://workstation.example.ts.net", stderr: "" };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await manager.start(34121);
    await manager.clearHttpsPort();
    await manager.stop();
    expect(statusChecks).toBe(2);
  });

  test("reports stopOwned inspection, parsing, and removal failures", async () => {
    const rejectedStatus = mock(async () => {
      throw "daemon unavailable";
    }) as TailscaleCommandRunner;
    await expect(
      new TailscaleServeManager("tailscale", rejectedStatus).stopOwned(34121),
    ).rejects.toThrow("Unable to inspect Tailscale Serve configuration: daemon unavailable");

    const invalidStatus = mock(async () => ({ stdout: "not-json", stderr: "" })) as TailscaleCommandRunner;
    await expect(
      new TailscaleServeManager("tailscale", invalidStatus).stopOwned(34121),
    ).rejects.toThrow("invalid status JSON");

    const removalFailed = mock(async (_command: string, args: string[]) => {
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
      throw failure("off failed", "permission denied");
    }) as TailscaleCommandRunner;
    await expect(
      new TailscaleServeManager("tailscale", removalFailed).stopOwned(34121),
    ).rejects.toThrow("Unable to remove owned Tailscale Serve handler: permission denied");
  });

  test("includes non-Error command failures in configuration errors", async () => {
    const run = mock(async () => {
      throw "command rejected";
    }) as TailscaleCommandRunner;

    await expect(new TailscaleServeManager("tailscale", run).start(34121)).rejects.toThrow(
      "Unable to inspect Tailscale Serve configuration: command rejected",
    );
  });

  test("runs the default command runner through an executable boundary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ork-tailscale-runner-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "tailscale");
    const stateFile = `${executable}.active`;
    await writeFile(executable, `#!/bin/sh
if [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  if [ -f '${stateFile}' ]; then
    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:34121"}}}}}'
  else
    printf '{}'
  fi
elif [ "$2" = "--yes" ] && [ "$3" = "--https=443" ] && [ "$4" = "--set-path=/" ] && [ "$5" = "off" ]; then
  rm -f '${stateFile}'
  exit 0
else
  touch '${stateFile}'
  printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
fi
`);
    await chmod(executable, 0o755);

    const manager = new TailscaleServeManager(executable);
    await expect(manager.start(34121)).resolves.toBe("https://workstation.example.ts.net/");
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});
