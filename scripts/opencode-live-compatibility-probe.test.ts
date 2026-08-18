import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableLoopbackPort,
  installProbeTerminationHandlers,
  parseCliVersion,
  readInstalledSdkVersion,
  readPinnedSdkVersion,
  readEmptySessionCount,
  runOpenCodeLiveCompatibility,
  stopServer,
  waitForHealth,
  type OpenCodeLiveCompatibilityOptions,
  type ServerHandle,
} from "./opencode-live-compatibility-probe";

/**
 * Every seam is injected here: these cover the probe's error paths without a
 * real OpenCode CLI, a real server or any network access, so they run in the
 * default suite (the live round trip stays gated behind an env var).
 */

const VERSION = "1.2.3";
const TEMP_PREFIX = "ork-opencode-compat-";

interface FakeServer extends ServerHandle {
  exitCode: number | null;
  readonly signals: (number | NodeJS.Signals | undefined)[];
}

function createFakeServer(options: { exitCode?: number | null; ignoresSigterm?: boolean } = {}) {
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const server: FakeServer = {
    exitCode: options.exitCode ?? null,
    exited,
    signals: [],
    kill(signal) {
      server.signals.push(signal);
      if (options.ignoresSigterm && signal !== "SIGKILL") return;
      server.exitCode = 0;
      settle(0);
    },
  };
  if (server.exitCode !== null) settle(server.exitCode);
  return server;
}

function healthResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(
  overrides: OpenCodeLiveCompatibilityOptions = {},
): OpenCodeLiveCompatibilityOptions {
  return {
    cliPath: "/fake/opencode",
    expectedVersion: VERSION,
    installedSdkVersion: VERSION,
    runCli: async () => ({ stdout: `${VERSION}\n`, stderr: "", exitCode: 0 }),
    spawnServer: () => createFakeServer(),
    fetchImpl: async () => healthResponse({ healthy: true, version: VERSION }),
    sleep: async () => {},
    allocatePort: async () => 4321,
    listSessions: async () => ({ data: [] }),
    ...overrides,
  };
}

async function tempRoots(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith(TEMP_PREFIX));
}

describe("local SDK and network discovery", () => {
  test("allocates a valid ephemeral loopback port and releases it", async () => {
    const port = await availableLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
  });

  test("reads the SDK pin from the web application manifest", async () => {
    const manifest = JSON.parse(
      await readFile(join(import.meta.dir, "..", "apps", "web", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(await readPinnedSdkVersion()).toBe(manifest.dependencies?.["@opencode-ai/sdk"]);
  });

  test("reads the version from the installed SDK package", async () => {
    expect(await readInstalledSdkVersion()).toBe(await readPinnedSdkVersion());
  });
});

describe("installProbeTerminationHandlers", () => {
  function fakeRuntime() {
    const handlers = new Map<"SIGTERM" | "SIGINT", () => void>();
    const exitCodes: number[] = [];
    return {
      handlers,
      exitCodes,
      runtime: {
        on(signal: "SIGTERM" | "SIGINT", listener: () => void) {
          handlers.set(signal, listener);
        },
        exit(code: number) {
          exitCodes.push(code);
        },
      },
    };
  }

  test("registers SIGTERM and SIGINT handlers that exit when no probe is active", () => {
    const fake = fakeRuntime();
    installProbeTerminationHandlers(fake.runtime, () => null);

    expect([...fake.handlers.keys()]).toEqual(["SIGTERM", "SIGINT"]);
    fake.handlers.get("SIGTERM")?.();
    fake.handlers.get("SIGINT")?.();
    expect(fake.exitCodes).toEqual([1, 1]);
  });

  test("waits for active teardown before exiting and still exits after teardown fails", async () => {
    const fake = fakeRuntime();
    const teardownCalls: string[] = [];
    installProbeTerminationHandlers(fake.runtime, () => async () => {
      teardownCalls.push("called");
      throw new Error("teardown failed");
    });

    fake.handlers.get("SIGTERM")?.();
    expect(teardownCalls).toEqual(["called"]);
    expect(fake.exitCodes).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.exitCodes).toEqual([1]);
  });
});

describe("parseCliVersion", () => {
  test("reads the bare semver the CLI prints today", () => {
    expect(parseCliVersion("1.18.11\n")).toBe("1.18.11");
  });

  test("ignores an update notice appended after the version line", () => {
    expect(parseCliVersion("1.18.11\n\nUpdate available: 1.19.0\nRun `opencode upgrade`\n")).toBe(
      "1.18.11",
    );
  });

  test("reads a version from a labelled first line", () => {
    expect(parseCliVersion("opencode 1.18.11\n")).toBe("1.18.11");
  });

  test("returns an empty string when no version is present", () => {
    expect(parseCliVersion("\n\nnot a version\n")).toBe("");
  });
});

describe("waitForHealth", () => {
  test("gives up after the configured number of attempts", async () => {
    let attempts = 0;
    await expect(
      waitForHealth(
        "http://127.0.0.1:1",
        { exitCode: null },
        {
          fetchImpl: async () => {
            attempts += 1;
            throw new Error("connection refused");
          },
          sleep: async () => {},
          attempts: 5,
        },
      ),
    ).rejects.toThrow("OpenCode did not become healthy");
    expect(attempts).toBe(5);
  });

  test("stops as soon as the child has exited", async () => {
    await expect(
      waitForHealth(
        "http://127.0.0.1:1",
        { exitCode: 3 },
        {
          fetchImpl: async () => healthResponse({ healthy: true, version: VERSION }),
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("OpenCode exited before becoming healthy (3)");
  });

  test("retries a non-OK response before succeeding", async () => {
    let attempts = 0;
    const health = await waitForHealth(
      "http://127.0.0.1:1",
      { exitCode: null },
      {
        fetchImpl: async () => {
          attempts += 1;
          return attempts < 3
            ? healthResponse({}, 503)
            : healthResponse({ healthy: true, version: VERSION });
        },
        sleep: async () => {},
      },
    );
    expect(health).toEqual({ healthy: true, version: VERSION });
    expect(attempts).toBe(3);
  });
});

describe("readEmptySessionCount", () => {
  test("rejects a present-but-null error rather than only a truthy one", () => {
    expect(() => readEmptySessionCount({ data: [], error: null })).toThrow(
      "session.list returned an error",
    );
  });

  test("rejects a non-array payload", () => {
    expect(() => readEmptySessionCount({ data: { sessions: [] } })).toThrow(
      "did not return an array",
    );
  });

  test("rejects a non-empty isolated server", () => {
    expect(() => readEmptySessionCount({ data: [{ id: "a" }, { id: "b" }] })).toThrow(
      "returned 2 sessions",
    );
  });

  test("accepts an empty list", () => {
    expect(readEmptySessionCount({ data: [] })).toBe(0);
  });
});

describe("stopServer", () => {
  test("does nothing when the server has already exited", async () => {
    const server = createFakeServer({ exitCode: 0 });
    await stopServer(server, 5);
    expect(server.signals).toEqual([]);
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const server = createFakeServer({ ignoresSigterm: true });
    await stopServer(server, 5);
    expect(server.signals).toEqual([undefined, "SIGKILL"]);
  });
});

describe("runOpenCodeLiveCompatibility", () => {
  test("reports the health payload, installed SDK version and session count", async () => {
    const before = await tempRoots();
    const server = createFakeServer();
    const result = await runOpenCodeLiveCompatibility(
      options({
        spawnServer: () => server,
        installedSdkVersion: "1.2.3",
        fetchImpl: async () => healthResponse({ healthy: true, version: VERSION }),
      }),
    );

    expect(result).toEqual({
      cliVersion: VERSION,
      health: { healthy: true, version: VERSION },
      sdkVersion: "1.2.3",
      sessionCount: 0,
    });
    // Teardown must reach the server and the isolated root on the happy path too.
    expect(server.exitCode).toBe(0);
    expect(await tempRoots()).toEqual(before);
  });

  test("fails when the CLI cannot be executed", async () => {
    await expect(
      runOpenCodeLiveCompatibility(
        options({
          runCli: async () => ({ stdout: "", stderr: "no such file\n", exitCode: 127 }),
        }),
      ),
    ).rejects.toThrow("Could not execute /fake/opencode: no such file");
  });

  test("fails when the CLI version does not match the SDK pin", async () => {
    await expect(
      runOpenCodeLiveCompatibility(
        options({ runCli: async () => ({ stdout: "1.2.4\n", stderr: "", exitCode: 0 }) }),
      ),
    ).rejects.toThrow("/fake/opencode reports 1.2.4, but @opencode-ai/sdk pins 1.2.3");
  });

  test("fails when health never arrives, and still tears the server down", async () => {
    const server = createFakeServer();
    await expect(
      runOpenCodeLiveCompatibility(
        options({
          spawnServer: () => server,
          fetchImpl: async () => {
            throw new Error("connection refused");
          },
          healthAttempts: 3,
        }),
      ),
    ).rejects.toThrow("OpenCode did not become healthy");
    expect(server.exitCode).toBe(0);
  });

  test("fails when the server reports itself unhealthy", async () => {
    await expect(
      runOpenCodeLiveCompatibility(
        options({
          fetchImpl: async () => healthResponse({ healthy: "yes", version: VERSION }),
        }),
      ),
    ).rejects.toThrow('OpenCode health reported {"healthy":"yes","version":"1.2.3"}');
  });

  test("fails when the served version does not match the pin", async () => {
    await expect(
      runOpenCodeLiveCompatibility(
        options({ fetchImpl: async () => healthResponse({ healthy: true, version: "9.9.9" }) }),
      ),
    ).rejects.toThrow("expected version 1.2.3");
  });

  test("fails when session.list reports an error", async () => {
    await expect(
      runOpenCodeLiveCompatibility(
        options({ listSessions: async () => ({ data: undefined, error: { data: {} } }) }),
      ),
    ).rejects.toThrow("session.list returned an error");
  });

  test("fails when session.list does not return an array", async () => {
    await expect(
      runOpenCodeLiveCompatibility(options({ listSessions: async () => ({ data: null }) })),
    ).rejects.toThrow("did not return an array");
  });

  test("fails when the isolated server already has sessions", async () => {
    await expect(
      runOpenCodeLiveCompatibility(
        options({ listSessions: async () => ({ data: [{ id: "leaked" }] }) }),
      ),
    ).rejects.toThrow("returned 1 sessions");
  });

  test("fails when the child exits before becoming healthy", async () => {
    await expect(
      runOpenCodeLiveCompatibility(
        options({ spawnServer: () => createFakeServer({ exitCode: 2 }) }),
      ),
    ).rejects.toThrow("OpenCode exited before becoming healthy (2)");
  });

  test("kills the server when the overall deadline expires", async () => {
    const before = await tempRoots();
    const server = createFakeServer();
    await expect(
      runOpenCodeLiveCompatibility(
        options({
          spawnServer: () => server,
          // A hung SDK call would otherwise pin the probe open past the live
          // test's own timeout, which is exactly what leaks a server.
          listSessions: () => new Promise(() => {}),
          deadlineMs: 10,
        }),
      ),
    ).rejects.toThrow("OpenCode compatibility probe exceeded 10ms");
    expect(server.exitCode).toBe(0);
    expect(await tempRoots()).toEqual(before);
  });
});
