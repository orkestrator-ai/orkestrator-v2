import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  download,
  ensureTools,
  PINNED_TOOLS,
  dockerAnswers,
  DEFAULT_SETTINGS,
  HOST_LOOPBACK_ENV,
  INSTANCE_MARKER_ENV,
  assertInside,
  daemonConfig,
  daemonEnvironment,
  dockerdArguments,
  instancePaths,
  isOwnedProcess,
  isRunning,
  listRecords,
  markedProcesses,
  missingPrerequisites,
  parseArguments,
  readRecord,
  readStartTime,
  reapStale,
  removableDirectories,
  restartInstance,
  startInstance,
  startWithImages,
  stopInstance,
  suiteEnvironment,
  transferImage,
  type InstanceRecord,
  type LauncherOptions,
} from "../../scripts/disposable-docker-daemon";

// The launcher drives a Linux rootless daemon and identifies its processes
// through /proc (start time, environment marker). Cases that spawn or inspect
// processes run only where /proc exists; the pure cases run everywhere.
const linuxTest = test.skipIf(process.platform !== "linux");

let scratch = "";
let root = "";
let runtimeBase = "";
let stubDir = "";

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ddd-"));
  root = path.join(scratch, "root");
  runtimeBase = path.join(scratch, "rt");
  stubDir = path.join(scratch, "stub");
  mkdirSync(root);
  mkdirSync(runtimeBase);
  mkdirSync(stubDir);
});

afterEach(async () => {
  // Stop anything a failed test left running, through the launcher itself.
  for (const record of listRecords(root)) {
    await stopInstance(record.name, options()).catch(() => undefined);
  }
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Stands in for `dockerd-rootless.sh`: a parent that, like RootlessKit, has a
 * child of its own. Both inherit the instance marker from the environment.
 */
function stubScript(): string {
  const script = path.join(stubDir, "fake-rootless.sh");
  if (!existsSync(script)) writeFileSync(script, "#!/bin/sh\nsleep 300 &\nwait\n", { mode: 0o755 });
  return script;
}

function options(overrides: Partial<LauncherOptions> = {}): LauncherOptions {
  return {
    root,
    runtimeBase,
    rootlessScript: () => stubScript(),
    tools: async () => stubDir,
    ready: async () => true,
    readyTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
    log: () => undefined,
    ...overrides,
  };
}

function record(name = "unit"): InstanceRecord {
  return {
    schema: 1,
    name,
    marker: "m".repeat(32),
    runtimeBase,
    settings: DEFAULT_SETTINGS,
    paths: instancePaths(root, runtimeBase, name),
    process: null,
    images: [],
    createdAt: new Date(0).toISOString(),
  };
}

describe("arguments", () => {
  test("defaults to slirp4netns with host loopback refused and live-restore off", () => {
    const parsed = parseArguments(["start"], root);
    expect(parsed).toMatchObject({ command: "start", name: "default", root, settings: {} });
    expect(DEFAULT_SETTINGS).toEqual({
      mode: "rootless",
      network: "slirp4netns",
      hostLoopback: false,
      liveRestore: false,
      addressPool: "172.30.0.0/16",
      poolSize: 24,
      ipv6: false,
    });
  });

  test("reads every option and refuses unknown or malformed ones", () => {
    const parsed = parseArguments(
      ["--", "start", "--name", "q1", "--net", "vpnkit", "--host-loopback"],
      root,
    );
    expect(parsed.settings).toEqual({ network: "vpnkit", hostLoopback: true });
    expect(parseArguments(["load-image", "--name", "q1", "img:tag"], root).images).toEqual([
      "img:tag",
    ]);
    expect(() => parseArguments(["start", "--live-restore"], root)).toThrow("unsupported");
    expect(() => parseArguments(["restart", "--net", "pasta"], root)).toThrow(
      "only accepted by start",
    );
    expect(() => parseArguments(["start", "--net", "host"], root)).toThrow("--net");
    expect(() => parseArguments(["start", "--address-pool", "10.0.0.0/28"], root)).toThrow();
    expect(() => parseArguments(["start", "--name", "../x"], root)).toThrow("Instance name");
    expect(() => parseArguments(["start", "--surprise"], root)).toThrow("Unknown argument");
    expect(() => parseArguments(["start", "--name"], root)).toThrow("needs a value");
  });
});

describe("daemon configuration", () => {
  test("every path is private to the instance and the socket fits a Unix socket", () => {
    const paths = instancePaths(root, runtimeBase, "unit");
    expect(path.dirname(paths.instanceDir)).toBe(root);
    for (const key of ["dataRoot", "home", "log", "config", "record"] as const) {
      expect(paths[key].startsWith(`${paths.instanceDir}/`)).toBe(true);
    }
    expect(path.dirname(paths.runtimeDir)).toBe(runtimeBase);
    for (const key of ["socket", "execRoot", "pidFile", "rootlesskitState"] as const) {
      expect(paths[key].startsWith(`${paths.runtimeDir}/`)).toBe(true);
    }
    expect(() => instancePaths(root, path.join(scratch, "x".repeat(120)), "unit")).toThrow(
      "too long",
    );
    expect(dockerdArguments(paths)).toEqual([
      `--data-root=${paths.dataRoot}`,
      `--exec-root=${paths.execRoot}`,
      `--pidfile=${paths.pidFile}`,
      `--host=unix://${paths.socket}`,
      `--config-file=${paths.config}`,
    ]);
    expect(daemonConfig({ ...DEFAULT_SETTINGS, liveRestore: true })).toEqual({
      "default-address-pools": [{ base: "172.30.0.0/16", size: 24 }],
      "live-restore": true,
    });
  });

  test("the daemon environment is private and drops the caller's Docker selection", () => {
    const env = daemonEnvironment(record(), "/tools", {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DOCKER_CONFIG: "/home/someone/.docker",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    const paths = record().paths;
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.DOCKER_CONFIG).toBeUndefined();
    expect(env.PATH).toBe("/tools:/usr/bin");
    expect(env.HOME).toBe(paths.home);
    expect(env.XDG_RUNTIME_DIR).toBe(paths.runtimeDir);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
    expect(env.DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR).toBe(paths.rootlesskitState);
    expect(env.DOCKERD_ROOTLESS_ROOTLESSKIT_NET).toBe("slirp4netns");
    expect(env.DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER).toBe("builtin");
    expect(env.DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK).toBe("true");
    expect(env[INSTANCE_MARKER_ENV]).toBe("m".repeat(32));
    const open = daemonEnvironment(
      { ...record(), settings: { ...DEFAULT_SETTINGS, hostLoopback: true } },
      "/tools",
      {},
    );
    expect(open.DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK).toBe("false");
  });

  test("the suite environment selects the instance and names its restart", () => {
    const env = suiteEnvironment(record(), "/bin/bun");
    expect(env.DOCKER_HOST).toBe(`unix://${record().paths.socket}`);
    expect(env[HOST_LOOPBACK_ENV]).toBe("disabled");
    expect(env.ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND).toContain(" restart --name unit --root ");
  });

  test("prerequisites name what is missing", () => {
    const missing = missingPrerequisites(
      "alice",
      (file) => (file === "/etc/subuid" ? "alice:100000:65536\n" : "bob:100000:65536\n"),
      (command) => command !== "newuidmap",
    );
    expect(missing).toContain("newuidmap is not on PATH");
    expect(missing).toContain("/etc/subgid has no range for alice");
    expect(missing.some((line) => line.includes("/etc/subuid"))).toBe(false);
  });
});

describe("removal boundaries", () => {
  test("refuses the parent itself, a path outside it and a symbolic link", () => {
    expect(() => assertInside(root, root)).toThrow("not inside");
    expect(() => assertInside(root, path.join(root, ".."))).toThrow("not inside");
    expect(() => assertInside(root, "/etc")).toThrow("not inside");
    symlinkSync(os.tmpdir(), path.join(root, "link"));
    expect(() => assertInside(root, path.join(root, "link"))).toThrow("symbolic link");
    expect(() => assertInside(root, path.join(root, "unit"))).not.toThrow();
  });

  test("a record naming directories the launcher did not create removes nothing", () => {
    const forged = record();
    forged.paths = { ...forged.paths, instanceDir: os.homedir() };
    expect(() => removableDirectories(forged, root)).toThrow("did not create");
    expect(removableDirectories(record(), root)).toEqual([
      record().paths.runtimeDir,
      record().paths.instanceDir,
    ]);
  });

  test("never copies orkestrator-v2:latest", async () => {
    await expect(transferImage(record(), "orkestrator-v2:latest")).rejects.toThrow("latest");
    await expect(transferImage(record(), "orkestrator-v2")).rejects.toThrow("latest");
  });
});

describe("process identity", () => {
  linuxTest("a live process without the instance marker is not owned", () => {
    const self = { pid: process.pid, startTime: readStartTime(process.pid)! };
    expect(self.startTime).not.toBeNull();
    expect(isOwnedProcess(self, "not-this-marker")).toBe(false);
    expect(isOwnedProcess({ pid: process.pid, startTime: "0" }, "x")).toBe(false);
  });
});

describe("lifecycle", () => {
  linuxTest(
    "start, restart and stop own exactly the instance's processes and directories",
    async () => {
      const started = await startInstance("unit", {}, options());
      expect(isRunning(started)).toBe(true);
      // The parent and the child it started both carry the marker.
      expect(markedProcesses(started.marker).length).toBe(2);
      expect(existsSync(started.paths.config)).toBe(true);
      expect(readRecord(root, "unit")?.process).toEqual(started.process);
      await expect(startInstance("unit", {}, options())).rejects.toThrow("already running");

      // A restart replaces the whole tree and keeps the data root.
      writeFileSync(path.join(started.paths.dataRoot, "kept"), "image layers");
      const before = started.process!;
      const restarted = await restartInstance(
        "unit",
        options({ runtimeBase: path.join(scratch, "different") }),
      );
      expect(restarted.process!.pid).not.toBe(before.pid);
      expect(isOwnedProcess(before, started.marker)).toBe(false);
      expect(isRunning(restarted)).toBe(true);
      expect(existsSync(path.join(started.paths.dataRoot, "kept"))).toBe(true);

      expect(
        await stopInstance("unit", options({ runtimeBase: path.join(scratch, "different") })),
      ).toBe(true);
      expect(markedProcesses(started.marker)).toEqual([]);
      expect(existsSync(started.paths.instanceDir)).toBe(false);
      expect(existsSync(started.paths.runtimeDir)).toBe(false);
      expect(await stopInstance("unit", options())).toBe(false);
    },
  );

  linuxTest("a daemon that never answers is stopped and removed", async () => {
    await expect(
      startInstance("dead", {}, options({ ready: async () => false, readyTimeoutMs: 300 })),
    ).rejects.toThrow("did not answer");
    expect(existsSync(path.join(root, "dead"))).toBe(false);
    expect(existsSync(instancePaths(root, runtimeBase, "dead").runtimeDir)).toBe(false);
  });

  linuxTest(
    "start reaps an instance whose daemon died and leaves a running one alone",
    async () => {
      const running = await startInstance("alive", {}, options());
      const stale = await startInstance("stale", {}, options());
      for (const identity of markedProcesses(stale.marker)) process.kill(identity.pid, "SIGKILL");
      expect(await reapStale(options())).toEqual(["stale"]);
      expect(existsSync(stale.paths.instanceDir)).toBe(false);
      expect(isRunning(running)).toBe(true);
      // Something that is not a record is never touched.
      mkdirSync(path.join(root, "notes"));
      expect(await reapStale(options())).toEqual([]);
      expect(existsSync(path.join(root, "notes"))).toBe(true);
    },
  );
});

describe("review regressions", () => {
  linuxTest("concurrent start and restart cannot reap an in-flight launch", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = startInstance(
      "first",
      {},
      options({
        tools: async () => {
          entered();
          await gate;
          return stubDir;
        },
      }),
    );
    await entering;
    const second = startInstance("second", {}, options());
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(isRunning(a)).toBe(true);
    expect(isRunning(b)).toBe(true);
    const [restarted, third] = await Promise.all([
      restartInstance("first", options()),
      startInstance("third", {}, options()),
    ]);
    expect(isRunning(restarted)).toBe(true);
    expect(isRunning(third)).toBe(true);
    expect(readRecord(root, "first")?.process).toEqual(restarted.process);
  });

  test("a checksum mismatch removes the untrusted download", async () => {
    const destination = path.join(scratch, "untrusted");
    await expect(
      download({ url: "data:text/plain,not-an-executable", sha256: "0".repeat(64) }, destination),
    ).rejects.toThrow("SHA-256");
    expect(existsSync(destination)).toBe(false);
    PINNED_TOOLS["test-bad-hash"] = {
      rootlessExtras: { url: "data:text/plain,not-a-tarball", sha256: "0".repeat(64) },
      slirp4netns: { url: "data:text/plain,never-used", sha256: "0".repeat(64) },
    };
    try {
      await expect(ensureTools(root, "test-bad-hash")).rejects.toThrow("SHA-256");
      expect(readdirSync(path.join(root, "tools"))).toEqual([]);
    } finally {
      delete PINNED_TOOLS["test-bad-hash"];
    }
  });

  test("qualified latest references and live-restore are rejected before mutation", async () => {
    for (const ref of [
      "docker.io/library/orkestrator-v2:latest",
      "registry.example/team/orkestrator-v2",
      "orkestrator-v2:latest@sha256:abc",
    ]) {
      await expect(transferImage(record(), ref)).rejects.toThrow("latest");
    }
    await expect(startInstance("unsafe", { liveRestore: true }, options())).rejects.toThrow(
      "unsupported",
    );
    expect(readRecord(root, "unsafe")).toBeNull();
  });
});

/** Fake Docker records argv and endpoint selection; it never contacts any daemon. */
function fakeDocker(mode: string): () => void {
  const old = { ...process.env };
  const script = path.join(stubDir, "docker");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
let args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ pid: process.pid, args, context: process.env.DOCKER_CONTEXT, tls: process.env.DOCKER_TLS_VERIFY }) + "\\n");
const destination = args[0] === "--host";
if (destination) args = args.slice(2);
const mode = process.env.FAKE_DOCKER_MODE;
if (args[0] === "info" && mode === "hang") { setInterval(() => {}, 1000); }
else if (args[0] === "image") { console.log(destination && mode === "mismatch" ? "sha256:other" : "sha256:expected"); }
else if (args[0] === "save") {
  if (mode === "save-fail") process.exit(3);
  const bytes = Buffer.alloc(1024 * 1024);
  const write = () => { while (process.stdout.write(bytes)) {} };
  process.stdout.on("drain", write);
  if (mode === "load-fail") write();
  else process.stdout.end(bytes);
} else if (args[0] === "load") {
  if (mode === "load-fail") process.exit(4);
  process.stdin.resume();
}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${stubDir}:${old.PATH}`;
  process.env.DOCKER_CONTEXT = "production-context";
  process.env.DOCKER_TLS_VERIFY = "1";
  process.env.FAKE_DOCKER_LOG = path.join(scratch, "docker.log");
  process.env.FAKE_DOCKER_MODE = mode;
  delete process.env.DOCKER_HOST;
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  };
}

describe("Docker subprocesses", () => {
  linuxTest(
    "successful copy preserves source context and forces the private destination",
    async () => {
      const restore = fakeDocker("success");
      try {
        const started = await startInstance("copy", {}, options());
        await expect(transferImage(started, "fixture:dev")).resolves.toEqual({
          reference: "fixture:dev",
          id: "sha256:expected",
        });
        writeFileSync(started.paths.socket, "stand-in socket");
        expect(await dockerAnswers(started, 500)).toBe(true);
        const calls = readFileSync(process.env.FAKE_DOCKER_LOG!, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          calls
            .filter((call) => call.args[0] !== "--host")
            .every((call) => call.context === "production-context"),
        ).toBe(true);
        const destinations = calls.filter((call) => call.args[0] === "--host");
        expect(destinations.length).toBe(3);
        expect(
          destinations.every(
            (call) =>
              call.args[1] === `unix://${started.paths.socket}` &&
              call.context === "" &&
              call.tls === "",
          ),
        ).toBe(true);
        expect(suiteEnvironment(started).DOCKER_CONTEXT).toBe("");
        expect(readRecord(root, "copy")?.images).toEqual([
          { reference: "fixture:dev", id: "sha256:expected" },
        ]);
      } finally {
        restore();
      }
    },
  );

  for (const mode of ["load-fail", "save-fail", "mismatch"]) {
    linuxTest(`copy failure (${mode}) rejects normally so startup cleanup can run`, async () => {
      const restore = fakeDocker(mode);
      try {
        await expect(startWithImages("copy", {}, ["fixture:dev"], options())).rejects.toThrow();
        expect(readRecord(root, "copy")).toBeNull();
        const calls = readFileSync(process.env.FAKE_DOCKER_LOG!, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        for (const call of calls) expect(readStartTime(call.pid)).toBeNull();

        expect(existsSync(instancePaths(root, runtimeBase, "copy").runtimeDir)).toBe(false);
      } finally {
        restore();
      }
    });
  }

  linuxTest("hung info is bounded by the startup deadline and cleans up", async () => {
    const restore = fakeDocker("hang");
    try {
      const before = Date.now();
      await expect(
        startInstance(
          "hung",
          {},
          options({
            ready: undefined,
            rootlessScript: () => {
              const script = path.join(stubDir, "socket-daemon.sh");
              writeFileSync(
                script,
                '#!/bin/sh\nfor arg in "$@"; do case "$arg" in --host=unix://*) touch "${arg#--host=unix://}";; esac; done\nsleep 300 &\nwait\n',
                { mode: 0o755 },
              );
              return script;
            },
            readyTimeoutMs: 150,
          }),
        ),
      ).rejects.toThrow("did not answer");
      expect(Date.now() - before).toBeLessThan(3000);
      expect(readRecord(root, "hung")).toBeNull();
    } finally {
      restore();
    }
  });
});
