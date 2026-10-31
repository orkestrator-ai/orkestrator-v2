import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import os from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, cp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "../../../apps/backend/src/data-dir.js";
import {
  DEFAULT_CONTROL_MCP_PORT,
  DEFAULT_GATEWAY_PORT,
} from "../../../apps/backend/src/fixed-ports.js";
import * as connection from "../src/client/service-connection.js";
import { runClient } from "../src/client/main.js";
import { captureIo, createSandbox, type ClientSandbox } from "./support/client-harness.js";

const realAwaitServiceConnection = connection.awaitServiceConnection;

const TOKEN = "install-fixture-token-0123456789";
const ADDRESS = "http://100.64.0.10:4317";
const boxes: ClientSandbox[] = [];
const restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const box of boxes.splice(0)) await box.cleanup();
});

async function fixture(
  options: {
    publish?: boolean;
    tty?: boolean;
    credentialFailure?: boolean;
    defaultDir?: boolean;
    endpoints?: Array<{ role: string; url: string }>;
  } = {},
) {
  const box = await createSandbox();
  boxes.push(box);
  const dataDir = options.defaultDir
    ? defaultDataDir(process.platform, box.env, box.root)
    : path.join(box.root, "data");
  const bin = path.join(dataDir, "backend/releases/9.9.9/node_modules/orkestrator/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "orkestrator.js"), "// fixture");
  await writeFile(path.join(bin, "orkestrator-launcher.js"), "// fixture");
  await writeFile(path.join(bin, "../package.json"), JSON.stringify({ version: "9.9.9" }));
  const authFile = path.join(dataDir, "gateway-auth.json");
  await writeFile(authFile, JSON.stringify({ token: TOKEN }), { mode: 0o600 });
  if (options.credentialFailure) await chmod(authFile, 0o644);
  const home = spyOn(os, "homedir").mockReturnValue(box.root);
  restores.push(() => home.mockRestore());
  const manager = spyOn(childProcess, "spawnSync").mockImplementation((() => {
    if (options.publish !== false)
      writeFileSync(
        path.join(dataDir, "backend-instance.json"),
        JSON.stringify({
          version: 1,
          type: "orkestrator-backend-instance",
          installationId: "install-1",
          generation: "fresh",
          pid: process.pid,
          startedAt: new Date().toISOString(),
          url: ADDRESS,
          endpoints: options.endpoints ?? [],
          authFile,
          dataDir,
          appVersion: "9.9.9",
          publicApiSchemaVersion: 1,
        }),
        { mode: 0o600 },
      );
    return { status: 0, stdout: "", stderr: "", pid: 1, output: [null, "", ""], signal: null };
  }) as unknown as typeof childProcess.spawnSync);
  restores.push(() => manager.mockRestore());
  const io = captureIo(box.env, box.root);
  io.stdoutIsTty = options.tty ?? false;
  async function run(extra: string[] = [], signal?: AbortSignal) {
    const code = await runClient(
      [
        "service",
        "install",
        "--data-dir",
        dataDir,
        "--yes",
        ...(extra.includes("--timeout") ? [] : ["--timeout", "1ms"]),
        ...extra,
      ],
      { io, version: "9.9.9", signal },
    );
    return { code, out: io.out.join(""), err: io.err.join("") };
  }
  return { box, dataDir, authFile, io, manager, run };
}

test.each([false, true])(
  "started install exposes the tailnet address; stdout TTY=%s",
  async (tty) => {
    const f = await fixture({ tty });
    const result = await f.run();
    expect(result.code).toBe(0);
    expect(f.manager).toHaveBeenCalled();
    expect(result.out).toContain(ADDRESS);
    expect(result.out).toContain(f.authFile);
    expect(result.out.includes(TOKEN)).toBe(tty);
    expect(result.err).not.toContain(TOKEN);
  },
);

test("JSON includes readiness and paths and excludes the token even on a terminal", async () => {
  const f = await fixture({ tty: true });
  const result = await f.run(["--output", "json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).result).toMatchObject({
    ready: true,
    started: true,
    browserUrl: ADDRESS,
    authFile: f.authFile,
  });
  expect(result.out + result.err).not.toContain(TOKEN);
});

test.each(["human", "json"])(
  "a ready backend with credential errors stays ready in %s output",
  async (output) => {
    const f = await fixture({ tty: true, credentialFailure: true });
    const result = await f.run(["--output", output]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(TOKEN);
    expect(result.out).not.toContain("not reported ready");
    if (output === "json")
      expect(JSON.parse(result.out).result).toMatchObject({
        ready: true,
        browserUrl: ADDRESS,
        authFile: f.authFile,
        credentialError: expect.stringContaining("chmod 600"),
      });
    else {
      expect(result.out).toContain("Credential file error:");
      expect(result.out).toContain("chmod 600");
    }
  },
);

test.each(["human", "json"])("deadline expiry reports not ready in %s output", async (output) => {
  const f = await fixture({ publish: false });
  const result = await f.run(["--output", output]);
  expect(result.code).toBe(0);
  if (output === "json")
    expect(JSON.parse(result.out).result).toMatchObject({
      ready: false,
      browserUrl: null,
      authFile: null,
    });
  else expect(result.out).toContain("not reported ready yet");
});

function installedArgs(dataDir: string): string[] {
  return JSON.parse(readFileSync(path.join(dataDir, "backend", "service.json"), "utf8")).args;
}

test("a second backend's Tailscale Serve keeps one port across reinstalls", async () => {
  const f = await fixture();
  const first = await f.run(["--", "--tailscale-serve"]);
  expect(first.code).toBe(0);
  expect(first.out).toContain("keeps a free port chosen at install");
  const args = installedArgs(f.dataDir);
  expect(args.slice(0, 2)).toEqual(["--tailscale-serve", "--port"]);
  const port = Number(args[2]);
  expect(port).toBeGreaterThan(0);
  expect([DEFAULT_GATEWAY_PORT, DEFAULT_CONTROL_MCP_PORT]).not.toContain(port);

  expect((await f.run(["--", "--tailscale-serve"])).code).toBe(0);
  expect(installedArgs(f.dataDir)).toEqual(args);
});

test("a second backend's own --port is kept and needs no note", async () => {
  const f = await fixture();
  const result = await f.run(["--", "--tailscale-serve", "--port", "45000"]);
  expect(result.code).toBe(0);
  expect(installedArgs(f.dataDir)).toEqual(["--tailscale-serve", "--port", "45000"]);
  expect(result.out).not.toContain("not the default data directory");
});

test("a second backend without Serve is told its port moves, and stays unpinned", async () => {
  const f = await fixture();
  const result = await f.run(["--", "--host", "100.64.0.10"]);
  expect(result.code).toBe(0);
  expect(installedArgs(f.dataDir)).toEqual(["--host", "100.64.0.10"]);
  expect(result.out).toContain("changes on each start");
  expect(result.out).toContain("-- --port PORT");
});

test("the default data directory's Serve keeps the fixed port and no note", async () => {
  const f = await fixture({ defaultDir: true });
  const result = await f.run(["--", "--tailscale-serve"]);
  expect(result.code).toBe(0);
  expect(installedArgs(f.dataDir)).toEqual(["--tailscale-serve"]);
  expect(result.out).not.toContain("not the default data directory");
});

test.each(["human", "json"])("%s output names the local listeners", async (output) => {
  const local = "http://127.0.0.1:45001/";
  const f = await fixture({
    endpoints: [
      { role: "control", url: "http://127.0.0.1:45002/" },
      { role: "client", url: local },
    ],
  });
  const result = await f.run(["--output", output, "--timeout", "10s"]);
  expect(result.code).toBe(0);
  if (output === "json") expect(JSON.parse(result.out).result.clientUrls).toEqual([local]);
  else {
    expect(result.out).toContain(local);
    expect(result.out).not.toContain("45002");
  }
});

/** A launcher that has already given up by the time the install starts waiting. */
function launcherGaveUp(dataDir: string, state: () => Record<string, unknown>) {
  const manager = childProcess.spawnSync as unknown as ReturnType<typeof spyOn>;
  manager.mockImplementation((() => {
    const root = path.join(dataDir, "backend");
    const evidence = state();
    const { installGeneration } = JSON.parse(readFileSync(path.join(root, "service.json"), "utf8"));
    for (const key of ["bootFailure", "rollback"]) {
      if (evidence[key]) Object.assign(evidence[key], { installGeneration });
    }
    writeFileSync(path.join(root, "launcher-state.json"), JSON.stringify(evidence));
    writeFileSync(
      path.join(root, "logs/service.log"),
      [
        "Checking pinned Orkestrator tools…",
        "error: Unable to configure Tailscale Serve: Access denied: serve config denied",
        "To not require root, use 'sudo tailscale set --operator=$USER' once.",
        "[launcher] 2026-10-30T23:29:44.233Z 9.9.9 exited (code 1, signal none)",
        "[launcher] 2026-10-30T23:29:46.000Z starting 2.23.0",
      ].join("\n"),
    );
    return { status: 0, stdout: "", stderr: "", pid: 1, output: [null, "", ""], signal: null };
  }) as unknown as typeof childProcess.spawnSync);
}

test("a release that fails to start ends the wait with what the service logged", async () => {
  const f = await fixture({ publish: false });
  launcherGaveUp(f.dataDir, () => ({
    version: 1,
    bootAttempts: {},
    lastReadyVersion: "9.9.9",
    bootFailure: { version: "9.9.9", exits: 2, at: new Date().toISOString() },
  }));
  const result = await f.run(["--timeout", "1h"]);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("orkestrator@9.9.9 did not start");
  expect(result.err).toContain("keeps retrying");
  expect(result.err).toContain("Access denied: serve config denied");
  expect(result.err).toContain("sudo tailscale set --operator");
  expect(result.err).not.toContain("starting 2.23.0");
  expect(result.err).toContain("service.log");
  expect(result.out).not.toContain("The service is running");
});

test("a rollback names the release the service went back to", async () => {
  const f = await fixture({ publish: false });
  launcherGaveUp(f.dataDir, () => ({
    version: 1,
    bootAttempts: {},
    rollback: { failedVersion: "9.9.9", restoredVersion: "2.23.0", at: new Date().toISOString() },
  }));
  const result = await f.run(["--timeout", "1h", "--output", "json"]);
  expect(result.code).not.toBe(0);
  const error = JSON.parse(result.out).error;
  expect(error.code).toBe("operation-failed");
  expect(error.message).toContain("the service went back to 2.23.0");
  expect(error.message).toContain("Access denied");
});

test("a reinstall records the replaced release and the arguments it ran with", async () => {
  const f = await fixture();
  const first = await f.run(["--skip-start", "--", "--tailscale-bin", "/old"]);
  expect(first.code).toBe(0);
  const releases = path.join(f.dataDir, "backend/releases");
  await cp(path.join(releases, "9.9.9"), path.join(releases, "8.8.8"), { recursive: true });
  await symlink(path.join(releases, "8.8.8"), path.join(f.dataDir, "backend/current.next"));
  await rename(
    path.join(f.dataDir, "backend/current.next"),
    path.join(f.dataDir, "backend/current"),
  );
  const second = await f.run(["--skip-start", "--", "--loopback-client-port", "34125"]);
  expect(second.code).toBe(0);
  const config = JSON.parse(readFileSync(path.join(f.dataDir, "backend/service.json"), "utf8"));
  expect(config.args).toEqual(["--loopback-client-port", "34125"]);
  expect(config.rollbackTarget).toEqual({ version: "8.8.8", args: ["--tailscale-bin", "/old"] });
});

test("zero timeout skips observation and skip-start renders the load command", async () => {
  const f = await fixture();
  const result = await f.run(["--timeout", "0", "--output", "json"]);
  expect(result.code).toBe(0);
  expect(result.err).not.toContain("Waiting");
  expect(JSON.parse(result.out).result).toMatchObject({ ready: false, started: true });
  f.io.out.length = 0;
  const skipped = await f.run(["--skip-start"]);
  expect(skipped.code).toBe(0);
  expect(skipped.out).toContain("load it with:");
});

test.each(["25h", "-1", "nonsense"])(
  "rejects timeout %s before any installation",
  async (timeout) => {
    const f = await fixture();
    const result = await f.run(["--timeout", timeout]);
    expect(result.code).toBe(2);
    expect(f.manager).not.toHaveBeenCalled();
    expect(existsSync(path.join(f.dataDir, "backend/service.json"))).toBe(false);
  },
);

test.each(["SIGINT", "SIGTERM"])(
  "readiness interruption maps %s to its exit code",
  async (name) => {
    const controller = new AbortController();
    const f = await fixture({ publish: false });
    const stderr = f.io.stderr;
    f.io.stderr = (text) => {
      stderr(text);
      if (text.startsWith("Waiting")) controller.abort(name);
    };
    const result = await f.run(["--output", "json"], controller.signal);
    expect(result.code).toBe(name === "SIGINT" ? 130 : 143);
    expect(JSON.parse(result.out).error.code).toBe("observation-interrupted");
    expect(result.out).not.toContain("not reported ready");
  },
);

test("same-version old launcher failures during manager reload do not fail a corrected reinstall", async () => {
  const f = await fixture({ publish: false });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  restores.push(() => Object.defineProperty(process, "platform", platform));
  await symlink(
    path.join(f.dataDir, "backend/releases/9.9.9"),
    path.join(f.dataDir, "backend/current"),
  );
  const calls: string[][] = [];
  f.manager.mockImplementation(((file: string, args: string[]) => {
    calls.push([file, ...args]);
    // The old launcher keeps writing its own install generation through enable.
    writeFileSync(
      path.join(f.dataDir, "backend/launcher-state.json"),
      JSON.stringify({
        version: 1,
        lastReadyVersion: "9.9.9",
        bootAttempts: {},
        bootFailure: {
          version: "9.9.9",
          exits: 3,
          at: new Date().toISOString(),
          installGeneration: "old-install",
        },
      }),
    );
    return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null };
  }) as unknown as typeof childProcess.spawnSync);
  let polls = 0;
  // Exercise the real observation and failure reader without wall-clock sleeps.
  const wait = spyOn(connection, "awaitServiceConnection").mockImplementation(
    (dir, previous, options) =>
      realAwaitServiceConnection(dir, previous, {
        ...options,
        sleep: async () => {
          polls++;
          if (polls < 2) return;
          writeFileSync(
            path.join(f.dataDir, "backend-instance.json"),
            JSON.stringify({
              version: 1,
              type: "orkestrator-backend-instance",
              installationId: "install-1",
              generation: "replacement",
              pid: process.pid,
              startedAt: new Date().toISOString(),
              url: ADDRESS,
              endpoints: [],
              authFile: f.authFile,
              dataDir: f.dataDir,
              appVersion: "9.9.9",
              publicApiSchemaVersion: 1,
            }),
          );
        },
      }),
  );
  restores.push(() => wait.mockRestore());
  const result = await f.run([
    "--timeout",
    "1h",
    "--output",
    "json",
    "--",
    "--host",
    "100.64.0.10",
  ]);
  expect(calls.map((call) => call.slice(0, 3))).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable"],
    ["systemctl", "--user", "restart"],
  ]);
  expect(polls).toBe(2);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).result.ready).toBe(true);
});

test("install waits through exhausted boots until the launcher records rollback", async () => {
  const f = await fixture({ publish: false });
  await symlink(
    path.join(f.dataDir, "backend/releases/2.23.0"),
    path.join(f.dataDir, "backend/previous"),
  );
  launcherGaveUp(f.dataDir, () => ({
    version: 1,
    bootAttempts: { "9.9.9": 2 },
    lastReadyVersion: "2.23.0",
    bootFailure: { version: "9.9.9", exits: 2, at: new Date().toISOString() },
  }));
  let polls = 0;
  const wait = spyOn(connection, "awaitServiceConnection").mockImplementation(
    (dir, previous, options) =>
      realAwaitServiceConnection(dir, previous, {
        ...options,
        sleep: async () => {
          polls++;
          if (polls < 2) return;
          const stateFile = path.join(f.dataDir, "backend/launcher-state.json");
          const state = JSON.parse(readFileSync(stateFile, "utf8"));
          state.rollback = {
            failedVersion: "9.9.9",
            restoredVersion: "2.23.0",
            at: new Date().toISOString(),
            installGeneration: state.bootFailure.installGeneration,
          };
          writeFileSync(stateFile, JSON.stringify(state));
        },
      }),
  );
  restores.push(() => wait.mockRestore());
  const result = await f.run(["--timeout", "1h", "--output", "json"]);
  expect(polls).toBe(2);
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.out).error).toMatchObject({
    code: "operation-failed",
    message: expect.stringContaining("went back to 2.23.0"),
  });
});
