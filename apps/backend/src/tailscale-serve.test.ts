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
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function failure(message: string, stderr?: string): Error {
  const error = new Error(message) as Error & { stderr?: string };
  error.stderr = stderr;
  return error;
}

/**
 * A `tailscale serve` stand-in that tracks handlers per HTTPS port the way the
 * real CLI does: `--set-path=<path> off` removes one mount, a bare `off` removes
 * the port, and the TCP entry only disappears once its last handler is gone.
 *
 * Modelling teardown as a single boolean — as these tests previously did — makes
 * a scoped removal look like it deletes handlers this manager does not own,
 * which is precisely the behaviour under test.
 */
function createFakeTailscale(initial: Record<number, Record<string, string>> = {}) {
  const ports = new Map<number, Map<string, string>>();
  for (const [port, handlers] of Object.entries(initial)) {
    ports.set(Number(port), new Map(Object.entries(handlers)));
  }
  const calls: string[][] = [];

  const flagValue = (args: string[], prefix: string): string | undefined => {
    const flag = args.find((arg) => arg.startsWith(prefix));
    return flag?.slice(prefix.length);
  };

  const statusJson = () => {
    const TCP: Record<string, { HTTPS: boolean }> = {};
    const Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> = {};
    for (const [port, handlers] of ports) {
      if (handlers.size === 0) continue;
      TCP[String(port)] = { HTTPS: true };
      Web[`workstation.example.ts.net:${port}`] = {
        Handlers: Object.fromEntries(
          [...handlers].map(([handlerPath, proxy]) => [handlerPath, { Proxy: proxy }]),
        ),
      };
    }
    return JSON.stringify({ TCP, Web });
  };

  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "status") {
      return args.at(-1) === "--json"
        ? { stdout: statusJson(), stderr: "" }
        : { stdout: "https://workstation.example.ts.net |-- / proxy", stderr: "" };
    }

    const port = Number(flagValue(args, "--https=") ?? 443);
    const handlerPath = flagValue(args, "--set-path=");
    const handlers = ports.get(port) ?? new Map<string, string>();
    ports.set(port, handlers);

    if (args.at(-1) === "off") {
      if (handlerPath) handlers.delete(handlerPath);
      else handlers.clear();
      return { stdout: "", stderr: "" };
    }

    handlers.set(handlerPath ?? "/", args.at(-1)!);
    return {
      stdout: "Available within your tailnet:\nhttps://workstation.example.ts.net\n",
      stderr: "",
    };
  });

  return {
    run: run as TailscaleCommandRunner,
    calls,
    /** Handler paths still configured on `port`, sorted for stable assertions. */
    handlerPaths: (port: number) => [...(ports.get(port)?.keys() ?? [])].sort(),
  };
}

describe("Tailscale Serve helpers", () => {
  test("extracts and normalizes an advertised HTTPS origin", () => {
    expect(
      extractTailscaleServeUrl(`
      Available within your tailnet:
      https://workstation.example.ts.net:8443/path,
      |-- / proxy http://127.0.0.1:34121
    `),
    ).toBe("https://workstation.example.ts.net:8443/");
    expect(extractTailscaleServeUrl("no HTTPS address here")).toBeNull();
    expect(
      extractTailscaleServeUrl("https://[bad then https://valid.example.ts.net:8443/path"),
    ).toBe("https://valid.example.ts.net:8443/");
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
  test("configures and removes only its own root handler, leaving the user's paths", async () => {
    const tailscale = createFakeTailscale({ 8443: { "/api": "http://127.0.0.1:9000" } });
    const manager = new TailscaleServeManager("/opt/tailscale", tailscale.run);

    await expect(manager.start(34121, 8443)).resolves.toBe("https://workstation.example.ts.net/");
    expect(tailscale.handlerPaths(8443)).toEqual(["/", "/api"]);

    await manager.stop();
    // The user's handler survives, so the listener is still configured. A second
    // stop must remain a no-op rather than reading the surviving `/api` as a
    // changed configuration and throwing.
    expect(tailscale.handlerPaths(8443)).toEqual(["/api"]);
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(tailscale.handlerPaths(8443)).toEqual(["/api"]);

    expect(tailscale.calls).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:34121"],
      ["serve", "status", "--json"],
      ["serve", "--yes", "--https=8443", "--set-path=/", "off"],
    ]);
  });

  test("re-enables web access on a port whose other handlers survived teardown", async () => {
    const tailscale = createFakeTailscale({ 8443: { "/api": "http://127.0.0.1:9000" } });
    const manager = new TailscaleServeManager("tailscale", tailscale.run);

    await manager.start(34121, 8443);
    await manager.stop();
    // `/api` keeps the TCP entry alive. Treating that as an occupied port would
    // leave the user with a conflict whose only remedy deletes `/api`.
    await expect(manager.start(34121, 8443)).resolves.toBe("https://workstation.example.ts.net/");
    expect(tailscale.handlerPaths(8443)).toEqual(["/", "/api"]);
  });

  test("still refuses a listener whose root handler belongs to someone else", async () => {
    const tailscale = createFakeTailscale({
      8443: { "/": "http://127.0.0.1:9999", "/api": "http://127.0.0.1:9000" },
    });
    const manager = new TailscaleServeManager("tailscale", tailscale.run);

    const conflict = await manager.start(34121, 8443).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(TailscaleServeConflictError);
    expect(conflict).toMatchObject({ resetAvailable: true });
    expect(tailscale.handlerPaths(8443)).toEqual(["/", "/api"]);
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
      stdout:
        args.at(-1) === "--json"
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

    await expect(
      new TailscaleServeManager("tailscale", inspectionFailed).clearHttpsPort(),
    ).rejects.toThrow(
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
    await expect(
      new TailscaleServeManager("tailscale", handlerFailed).clearHttpsPort(),
    ).rejects.toThrow("Unable to reset Tailscale Serve handler /api: daemon unavailable");
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
    await expect(manager.stopOwned(34121, 443)).rejects.toThrow("Refusing to remove a changed");
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("removes a matching persisted listener and no-ops when its root handler is gone", async () => {
    const tailscale = createFakeTailscale({
      8443: { "/": "http://127.0.0.1:41234", "/unrelated": "http://127.0.0.1:5000" },
    });
    // No `start()` here: this is the ownership-file path taken after a restart,
    // where the manager has no tracked state and must rely on status alone.
    const manager = new TailscaleServeManager("tailscale", tailscale.run);

    await expect(manager.stopOwned(41234, 8443)).resolves.toBe(true);
    expect(tailscale.handlerPaths(8443)).toEqual(["/unrelated"]);
    await expect(manager.stopOwned(41234, 8443)).resolves.toBe(false);
    expect(tailscale.handlerPaths(8443)).toEqual(["/unrelated"]);
    expect(tailscale.calls).toContainEqual([
      "serve",
      "--yes",
      "--https=8443",
      "--set-path=/",
      "off",
    ]);
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
    const invalid = mock(async () => ({
      stdout: "not json",
      stderr: "",
    })) as TailscaleCommandRunner;
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
    await expect(
      new TailscaleServeManager("tailscale", configureFailed).start(34121),
    ).rejects.toThrow("Unable to configure Tailscale Serve: configure failed");

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
          stdout:
            statusChecks === 1
              ? "{}"
              : JSON.stringify({
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
          stdout:
            statusChecks === 1
              ? "{}"
              : JSON.stringify({
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

  test("normalizes non-object statuses without touching the configuration", async () => {
    for (const status of ["null", "true", "42", "[]", '{"TCP":null,"Web":[]}']) {
      const run = mock(async () => ({ stdout: status, stderr: "" })) as TailscaleCommandRunner;
      await expect(
        new TailscaleServeManager("tailscale", run).clearHttpsPort(),
      ).resolves.toBeUndefined();
      // None of these reach `Web`: the port is not configured, so the reset
      // returns after the single status call.
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  test("tolerates a malformed Web section on a configured port", async () => {
    // The port IS configured here, so unlike the case above this reaches
    // `httpsHandlerPaths` and has to survive a `Web` that is not a keyed object.
    for (const web of ["[]", "null", '"nonsense"', '{"workstation.example.ts.net:443":null}']) {
      const runMock = mock(async (_command: string, args: string[]) => ({
        stdout: args.at(-1) === "--json" ? `{"TCP":{"443":{"HTTPS":true}},"Web":${web}}` : "",
        stderr: "",
      }));
      const run: TailscaleCommandRunner = runMock;
      await expect(
        new TailscaleServeManager("tailscale", run).clearHttpsPort(),
      ).resolves.toBeUndefined();
      expect(runMock.mock.calls.map((call) => call[1])).toEqual([
        ["serve", "status", "--json"],
        ["serve", "--yes", "--https=443", "off"],
      ]);
    }
  });

  test("resets an HTTPS listener even when status reports no Web handlers", async () => {
    const run = mock(async (_command: string, args: string[]) => ({
      stdout: args.at(-1) === "--json" ? JSON.stringify({ TCP: { "443": { HTTPS: true } } }) : "",
      stderr: "",
    })) as TailscaleCommandRunner;

    await new TailscaleServeManager("tailscale", run).clearHttpsPort();
    // Deliberately the bare form rather than `--set-path=/`: a reset must drop
    // the TCP entry, and removing a single mount cannot do that. There is no
    // mount left to scope to here anyway.
    expect(run).toHaveBeenLastCalledWith("tailscale", ["serve", "--yes", "--https=443", "off"]);
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

    const invalidStatus = mock(async () => ({
      stdout: "not-json",
      stderr: "",
    })) as TailscaleCommandRunner;
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

  test("still removes its own handler when the status probe fails during shutdown", async () => {
    let inspectable = true;
    const tailscale = createFakeTailscale();
    const runMock = mock(async (command: string, args: string[]) => {
      if (!inspectable && args.at(-1) === "--json") throw failure("status failed", "daemon busy");
      return tailscale.run(command, args);
    });
    const run: TailscaleCommandRunner = runMock;
    const manager = new TailscaleServeManager("tailscale", run);

    await manager.start(34121, 8443);
    inspectable = false;
    // This process configured exactly this listener, so the root handler is
    // known to be ours. Failing closed here would exit leaving a public HTTPS
    // endpoint proxying to a port that is about to disappear.
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(tailscale.handlerPaths(8443)).toEqual([]);
    expect(runMock.mock.calls.at(-1)?.[1]).toEqual([
      "serve",
      "--yes",
      "--https=8443",
      "--set-path=/",
      "off",
    ]);

    // Tracked state was cleared, so a repeat stop must not blind-remove again.
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(runMock.mock.calls.at(-1)?.[1]).toEqual([
      "serve",
      "--yes",
      "--https=8443",
      "--set-path=/",
      "off",
    ]);
  });

  test("fails closed when the status probe fails and ownership is unproven", async () => {
    const run = mock(async () => {
      throw failure("status failed", "daemon busy");
    }) as TailscaleCommandRunner;

    // The ownership-file path after a restart: nothing proves the current `/`
    // handler is ours, so a blind removal could delete the user's.
    await expect(
      new TailscaleServeManager("tailscale", run).stopOwned(34121, 8443),
    ).rejects.toThrow("Unable to inspect Tailscale Serve configuration: daemon busy");
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("surfaces a blind removal failure during shutdown", async () => {
    let started = false;
    const run = mock(async (_command: string, args: string[]) => {
      if (args.at(-1) === "--json") {
        if (started) throw failure("status failed", "daemon busy");
        return { stdout: "{}", stderr: "" };
      }
      if (args.at(-1) === "off") throw failure("off failed", "permission denied");
      started = true;
      return { stdout: "https://workstation.example.ts.net", stderr: "" };
    }) as TailscaleCommandRunner;
    const manager = new TailscaleServeManager("tailscale", run);

    await manager.start(34121);
    await expect(manager.stop()).rejects.toThrow(
      "Unable to remove owned Tailscale Serve handler: permission denied",
    );
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
    // The user already serves `/api`, so this fixture also proves the real
    // subprocess boundary tears down `/` alone rather than the whole listener.
    const rootFile = `${executable}.root`;
    await writeFile(
      executable,
      `#!/bin/sh
if [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  if [ -f '${rootFile}' ]; then
    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:34121"},"/api":{"Proxy":"http://127.0.0.1:9000"}}}}}'
  else
    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{"/api":{"Proxy":"http://127.0.0.1:9000"}}}}}'
  fi
elif [ "$2" = "--yes" ] && [ "$3" = "--https=443" ] && [ "$4" = "--set-path=/" ] && [ "$5" = "off" ]; then
  rm -f '${rootFile}'
  exit 0
else
  touch '${rootFile}'
  printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
fi
`,
    );
    await chmod(executable, 0o755);

    const manager = new TailscaleServeManager(executable);
    await expect(manager.start(34121)).resolves.toBe("https://workstation.example.ts.net/");
    await expect(manager.stop()).resolves.toBeUndefined();
    // `/api` still holds the port open; the repeat teardown must stay a no-op.
    await expect(manager.stop()).resolves.toBeUndefined();
    await expect(manager.stopOwned(34121)).resolves.toBe(false);
  });
});
