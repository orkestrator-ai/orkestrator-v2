import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serviceCommands } from "../src/client/commands/service.js";
import type { CommandContext, ParsedCommand } from "../src/client/spec.js";
import { classifyInvocation } from "../src/client.js";
import { installDirFor, packageRootIn, runtimeLayout } from "../src/supervisor/layout.js";
import { acquireSupervisorLock, dataDirFromArgs } from "../src/supervisor/main.js";
import {
  childEnvironment,
  createSupervisorRuntime,
  verifyStagedPackage,
} from "../src/supervisor/runtime.js";
import {
  renderServiceUnit,
  serviceEnableCommands,
  serviceUnitPath,
} from "../src/supervisor/units.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "supervisor-runtime-"));
  directories.push(directory);
  return directory;
}

function fakeInstall(installDir: string, version: string, manifest = '{"schema":"x"}\n') {
  const root = packageRootIn(installDir);
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "resources"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "orkestrator", version }));
  writeFileSync(path.join(root, "bin", "orkestrator.js"), "");
  writeFileSync(path.join(root, "resources", "release-requirements.json"), manifest);
  return createHash("sha256").update(manifest).digest("hex");
}

describe("invocation", () => {
  test("serve --supervised runs the supervisor and never hands the flag to the service", () => {
    expect(classifyInvocation(["serve", "--supervised", "--tailscale-serve"])).toEqual({
      mode: "supervise",
      args: ["--tailscale-serve"],
    });
    expect(classifyInvocation(["serve", "--tailscale-serve"])).toEqual({
      mode: "serve",
      args: ["--tailscale-serve"],
    });
    expect(classifyInvocation(["serve", "--supervised", "--bogus"]).mode).toBe("error");
  });
});

describe("staged packages", () => {
  test("must be the requested version and carry the approved manifest", () => {
    const dir = path.join(temp(), "2.22.0");
    const sha = fakeInstall(dir, "2.22.0");
    expect(() => verifyStagedPackage(dir, "2.22.0", sha)).not.toThrow();
    expect(() => verifyStagedPackage(dir, "2.22.0", "")).not.toThrow();
    expect(() => verifyStagedPackage(dir, "2.22.1", sha)).toThrow("not 2.22.1");
    expect(() => verifyStagedPackage(dir, "2.22.0", "b".repeat(64))).toThrow("was approved");
  });

  test("version names cannot escape the versions directory", () => {
    const layout = runtimeLayout("/data");
    expect(installDirFor(layout, "2.22.0-beta.1")).toBe("/data/runtime/versions/2.22.0-beta.1");
    expect(() => installDirFor(layout, "../../etc")).toThrow("unsafe");
  });
});

describe("the real runtime", () => {
  test("swaps current and previous atomically and reads them back", async () => {
    const dataDir = temp();
    const layout = runtimeLayout(dataDir);
    const runtime = createSupervisorRuntime({ dataDir, layout, bunPath: process.execPath });
    const first = installDirFor(layout, "2.21.0");
    const second = installDirFor(layout, "2.22.0");
    fakeInstall(first, "2.21.0");
    fakeInstall(second, "2.22.0");
    expect(await runtime.readCurrent()).toBeNull();
    await runtime.setCurrent(first);
    await runtime.setCurrent(second);
    await runtime.setPrevious(first);
    expect(await runtime.readCurrent()).toBe(second);
    expect(await runtime.packageVersion(runtime.packageRootOf(second))).toBe("2.22.0");
    await runtime.setCurrent(null);
    expect(await runtime.readCurrent()).toBeNull();
    await runtime.prune([second]);
    expect(() => readFileSync(path.join(packageRootIn(first), "package.json"))).toThrow();
  });

  test("a stage that is already installed and valid is reused without the network", async () => {
    const dataDir = temp();
    const layout = runtimeLayout(dataDir);
    const sha = fakeInstall(installDirFor(layout, "2.22.0"), "2.22.0");
    const runtime = createSupervisorRuntime({ dataDir, layout, bunPath: "/nonexistent/bun" });
    expect(await runtime.stage("2.22.0", sha)).toBe(installDirFor(layout, "2.22.0"));
  });

  test("the state file round-trips and restores the pre-migration snapshot", async () => {
    const dataDir = temp();
    const layout = runtimeLayout(dataDir);
    const runtime = createSupervisorRuntime({ dataDir, layout, bunPath: process.execPath });
    expect(await runtime.readState()).toBeNull();
    await runtime.writeState({
      version: 1,
      cutover: null,
      pendingOutcome: null,
      lastInstall: null,
    });
    expect(await runtime.readState()).toEqual({
      version: 1,
      cutover: null,
      pendingOutcome: null,
      lastInstall: null,
    });
    mkdirSync(path.join(dataDir, "backups"));
    writeFileSync(path.join(dataDir, "orkestrator.sqlite"), "new");
    writeFileSync(
      path.join(dataDir, "backups", "pre-migration-v3-2026-10-15T12-00-00-000Z.sqlite"),
      "old",
    );
    expect(await runtime.restoreSnapshot(4, Date.parse("2026-10-15T11:59:00Z"))).toBe(false);
    expect(await runtime.restoreSnapshot(3, Date.parse("2026-10-15T12:30:00Z"))).toBe(false);
    expect(await runtime.restoreSnapshot(3, Date.parse("2026-10-15T11:59:00Z"))).toBe(true);
    expect(readFileSync(path.join(dataDir, "orkestrator.sqlite"), "utf8")).toBe("old");
  });

  test("reads the database schema version without writing to it", () => {
    const dataDir = temp();
    const runtime = createSupervisorRuntime({
      dataDir,
      layout: runtimeLayout(dataDir),
      bunPath: process.execPath,
    });
    expect(runtime.readUserVersion()).toBeNull();
    const database = new Database(path.join(dataDir, "orkestrator.sqlite"));
    database.exec("PRAGMA user_version = 4");
    database.close();
    expect(runtime.readUserVersion()).toBe(4);
  });

  test("children never inherit another version's roots", () => {
    expect(
      childEnvironment({
        PATH: "/bin",
        ORKESTRATOR_VERSION: "2.21.0",
        ORKESTRATOR_APP_ROOT: "/old",
        ORKESTRATOR_RESOURCE_ROOT: "/old/resources",
        ORKESTRATOR_DATA_DIR: "/data",
      }),
    ).toEqual({ PATH: "/bin", ORKESTRATOR_DATA_DIR: "/data" });
  });
});

describe("process plumbing", () => {
  test("the data directory comes from the flag, then the environment", () => {
    expect(dataDirFromArgs(["--data-dir", "/srv/ork"], {})).toBe("/srv/ork");
    expect(dataDirFromArgs(["--data-dir=/srv/x"], {})).toBe("/srv/x");
    expect(dataDirFromArgs([], { ORKESTRATOR_DATA_DIR: "/env" })).toBe("/env");
  });

  test("one supervisor per data directory; a dead owner's lock is taken over", () => {
    const lock = path.join(temp(), "runtime", "supervisor.lock");
    const release = acquireSupervisorLock(lock);
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, "1\n");
    expect(() => acquireSupervisorLock(lock)).toThrow("Another supervisor (pid 1)");
    writeFileSync(lock, "999999999\n");
    const again = acquireSupervisorLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
    again();
    release();
  });
});

describe("service units", () => {
  const base = {
    bunPath: "/Users/a b/.bun/bin/bun",
    launcherPath: "/data/runtime/current/node_modules/orkestrator/bin/orkestrator.js",
    dataDir: "/Users/a b/Library/Application Support/orkestrator-v2",
    serveArgs: ["--tailscale-serve"],
  };

  test("systemd runs the supervisor from current, quoted, restarting on failure", () => {
    const unit = renderServiceUnit({ ...base, manager: "systemd" });
    expect(unit).toContain(
      'ExecStart="/Users/a b/.bun/bin/bun" /data/runtime/current/node_modules/orkestrator/bin/orkestrator.js serve --supervised --tailscale-serve',
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(
      'Environment="ORKESTRATOR_DATA_DIR=/Users/a b/Library/Application Support/orkestrator-v2"',
    );
    expect(serviceEnableCommands("systemd", "/x")).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now orkestrator.service",
    ]);
  });

  test("launchd keeps it alive and escapes XML", () => {
    const unit = renderServiceUnit({
      ...base,
      manager: "launchd",
      serveArgs: ["--allowed-origins", "https://a&b"],
    });
    expect(unit).toContain("<string>serve</string>");
    expect(unit).toContain("<string>--supervised</string>");
    expect(unit).toContain("<string>https://a&amp;b</string>");
    expect(unit).toContain("<key>SuccessfulExit</key>");
    expect(serviceUnitPath("launchd", "/Users/u")).toBe(
      "/Users/u/Library/LaunchAgents/dev.orkestrator.backend.plist",
    );
  });
});

test("an initializing or malformed supervisor lock is never reclaimed", () => {
  const lock = path.join(temp(), "supervisor.lock");
  writeFileSync(lock, "");
  expect(() => acquireSupervisorLock(lock)).toThrow("no valid owner");
  expect(readFileSync(lock, "utf8")).toBe("");
  rmSync(lock);
  mkdirSync(`${lock}.guard`);
  expect(() => acquireSupervisorLock(lock)).toThrow("being initialized");
});

test("two processes racing acquisition have exactly one owner", async () => {
  const lock = path.join(temp(), "supervisor.lock");
  const modulePath = new URL("../src/supervisor/main.ts", import.meta.url).pathname;
  const code = `import { acquireSupervisorLock } from ${JSON.stringify(modulePath)};
    try { const release = acquireSupervisorLock(process.argv[1]); console.log("owned");
      await Bun.stdin.text(); release(); } catch { console.log("refused"); }`;
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, "--eval", code, lock], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  try {
    const replies = await Promise.all(
      children.map(async (child) => {
        const reader = child.stdout.getReader();
        const first = await reader.read();
        reader.releaseLock();
        return new TextDecoder().decode(first.value).trim();
      }),
    );
    expect(replies.filter((reply) => reply === "owned")).toHaveLength(1);
    expect(replies.filter((reply) => reply === "refused")).toHaveLength(3);
  } finally {
    for (const child of children) child.stdin.end();
    await Promise.all(children.map((child) => child.exited));
  }
});

test("toolchain pointer can be read and restored under a symlinked data directory", async () => {
  const root = temp();
  const actual = path.join(root, "actual");
  const dataDir = path.join(root, "alias");
  mkdirSync(path.join(actual, "toolchains", "bin", "old"), { recursive: true });
  symlinkSync(actual, dataDir);
  const runtime = createSupervisorRuntime({
    dataDir,
    layout: runtimeLayout(dataDir),
    bunPath: process.execPath,
  });
  const binDir = path.join(dataDir, "toolchains", "bin", "old");
  await runtime.pointToolchainCurrent(binDir);
  const before = await runtime.readToolchainCurrent();
  expect(before).toBe(binDir);
  await runtime.pointToolchainCurrent(before!);
});

test("unused supervisor sleep deadlines do not keep a process alive", async () => {
  const modulePath = new URL("../src/supervisor/runtime.ts", import.meta.url).pathname;
  const layoutPath = new URL("../src/supervisor/layout.ts", import.meta.url).pathname;
  const code = `import { createSupervisorRuntime } from ${JSON.stringify(modulePath)};
    import { runtimeLayout } from ${JSON.stringify(layoutPath)};
    createSupervisorRuntime({ dataDir: "/unused", layout: runtimeLayout("/unused"), bunPath: process.execPath }).sleep(120000);`;
  const child = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill(), 2000);
  try {
    expect(await child.exited).toBe(0);
  } finally {
    clearTimeout(deadline);
  }
});

test("service install resets an existing current and uses forwarded data-dir consistently", async () => {
  const root = temp();
  const dataDir = path.join(root, "data with spaces");
  const layout = runtimeLayout(dataDir);
  const runtime = createSupervisorRuntime({ dataDir, layout, bunPath: process.execPath });
  const old = installDirFor(layout, "2.21.0");
  const next = installDirFor(layout, "2.22.0");
  fakeInstall(old, "2.21.0");
  fakeInstall(next, "2.22.0");
  await runtime.setCurrent(old);
  const context = {
    version: "2.22.0",
    io: { env: { HOME: root, ORKESTRATOR_DATA_DIR: path.join(root, "wrong") } },
  } as unknown as CommandContext;
  const parsed = {
    options: { manager: "systemd" },
    rest: ["--data-dir", dataDir],
  } as unknown as ParsedCommand;
  const install = serviceCommands.find((command) => command.path[1] === "install")!;
  const result = await install.run(context, parsed);
  expect(await runtime.readCurrent()).toBe(next);
  const details = result.result as { unitPath: string; dataDir: string };
  expect(details.dataDir).toBe(dataDir);
  const unit = readFileSync(details.unitPath, "utf8");
  expect(unit).toContain(layout.current);
  expect(unit).toContain(`ORKESTRATOR_DATA_DIR=${dataDir}`);
  const release = acquireSupervisorLock(layout.lock);
  try {
    await expect(install.run(context, parsed)).rejects.toThrow("Another supervisor");
  } finally {
    release();
  }
});
