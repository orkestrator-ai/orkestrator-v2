import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SETTINGS,
  HOST_LOOPBACK_ENV,
  MODE_ENV,
  SHARED_DIR_ENV,
  daemonConfig,
  instancePaths,
  isRunning,
  listRecords,
  parseArguments,
  readRecord,
  reapStale,
  restartInstance,
  startInstance,
  stopInstance,
  suiteEnvironment,
  transferImage,
  validateSettings,
  type InstanceRecord,
  type LauncherOptions,
} from "../../scripts/disposable-docker-daemon";
import {
  NESTED_DIND_IMAGE,
  NESTED_MARKER_LABEL,
  NESTED_NAME_LABEL,
  NESTED_RUNTIME_MOUNT,
  SUPERVISOR_SCRIPT,
  nestedDaemonConfig,
  nestedNames,
  nestedRunArguments,
  outerEnvironment,
  readGeneration,
  resolveOuterHost,
  restartNested,
  removeNested,
  type NestedState,
} from "../../scripts/disposable-docker-daemon-nested";

// The nested rootful mode drives an outer daemon through the Docker CLI. These
// tests put a fake `docker` first on PATH that keeps the outer daemon's state
// in a JSON file; no daemon is ever contacted.
const linuxTest = test.skipIf(process.platform !== "linux");

let scratch = "";
let root = "";
let runtimeBase = "";
let stubDir = "";
let outerHost = "";
let restoreEnvironment: (() => void) | null = null;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "dddn-"));
  root = path.join(scratch, "root");
  runtimeBase = path.join(scratch, "rt");
  stubDir = path.join(scratch, "stub");
  outerHost = `unix://${scratch}/outer.sock`;
  for (const directory of [root, runtimeBase, stubDir]) mkdirSync(directory);
});

afterEach(async () => {
  if (restoreEnvironment) {
    delete process.env.FAKE_OUTER_DOWN;
    for (const record of listRecords(root)) {
      await stopInstance(record.name, options()).catch(() => undefined);
    }
    restoreEnvironment();
    restoreEnvironment = null;
  }
  rmSync(scratch, { recursive: true, force: true });
});

function options(overrides: Partial<LauncherOptions> = {}): LauncherOptions {
  return {
    root,
    runtimeBase,
    outerHost,
    ready: async () => true,
    readyTimeoutMs: 5_000,
    stopTimeoutMs: 2_000,
    log: () => undefined,
    ...overrides,
  };
}

type FakeState = {
  images: string[];
  volumes: Record<string, Record<string, string>>;
  containers: Record<
    string,
    { name: string; labels: Record<string, string>; running: boolean; mounts: string[] }
  >;
  cleanups: number;
  inspectFailures?: number;
  reviveOnInspect?: boolean;
};

function state(): FakeState {
  return JSON.parse(readFileSync(process.env.FAKE_OUTER_STATE!, "utf8"));
}

function calls(): { args: string[]; host: string | null; env: Record<string, string> }[] {
  const log = process.env.FAKE_OUTER_LOG!;
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A fake Docker CLI: `--host <outer>` reaches the fake outer daemon, any other host the inner one. */
function fakeOuterDocker(initial: Partial<FakeState> = {}): void {
  const old = { ...process.env };
  const statePath = path.join(scratch, "outer-state.json");
  writeFileSync(
    statePath,
    JSON.stringify({ images: [], volumes: {}, containers: {}, cleanups: 0, ...initial }),
  );
  const script = path.join(stubDir, "docker");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
let args = process.argv.slice(2);
let host = null;
if (args[0] === "--host") { host = args[1]; args = args.slice(2); }
fs.appendFileSync(process.env.FAKE_OUTER_LOG, JSON.stringify({ args, host, env: {
  DOCKER_HOST: process.env.DOCKER_HOST ?? "", DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? "" } }) + "\\n");
const fail = (message, code = 1) => { process.stderr.write(message + "\\n"); process.exit(code); };
if (args[0] === "context") { console.log("unix:///context.sock"); process.exit(0); }
if (host !== process.env.FAKE_OUTER_HOST) {
  // The inner daemon: answers, loads and reports the copied image.
  if (args[0] === "load") { process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); }
  else { if (args[0] === "image") console.log("sha256:copied"); process.exit(0); }
} else {
if (process.env.FAKE_OUTER_DOWN === "1") fail("Cannot connect to the Docker daemon");
const file = process.env.FAKE_OUTER_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const option = (name) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === name) out.push(args[i + 1]); return out; };
const labels = () => Object.fromEntries(option("--label").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const binds = () => option("--mount").filter((m) => m.startsWith("type=bind")).map((m) => Object.fromEntries(m.split(",").map((kv) => kv.split("="))));
const find = (ref) => Object.entries(state.containers).find(([id, c]) => id === ref || c.name === ref);
const [command, sub] = args;
if (command === "info") { console.log('linux|Fake Linux|["name=seccomp,profile=builtin"]'); }
else if (command === "image" && sub === "inspect") {
  const ref = args.at(-1);
  if (!state.images.includes(ref)) fail("Error: No such image: " + ref);
  console.log(ref === "fixture:dev" ? "sha256:copied" : "sha256:dind");
}
else if (command === "image" && sub === "rm") { state.images = state.images.filter((i) => i !== args.at(-1)); save(); }
else if (command === "pull") { state.images.push(args.at(-1)); save(); }
else if (command === "volume" && sub === "create") { state.volumes[args.at(-1)] = labels(); save(); }
else if (command === "volume" && sub === "inspect") {
  const v = state.volumes[args.at(-1)];
  if (!v) fail("Error response from daemon: get " + args.at(-1) + ": no such volume");
  console.log(args.at(-1) + "|false|" + (v["${NESTED_MARKER_LABEL}"] ?? "<no value>"));
}
else if (command === "volume" && sub === "rm") { delete state.volumes[args.at(-1)]; save(); }
else if (command === "container" && sub === "inspect") {
  if (state.inspectFailures > 0) { state.inspectFailures--; save(); fail("temporary inspection failure"); }
  const found = find(args.at(-1));
  if (!found) fail("Error: No such container: " + args.at(-1));
  const running = found[1].running;
  if (state.reviveOnInspect) { found[1].running = true; state.reviveOnInspect = false; save(); }
  console.log(found[0] + "|" + running + "|" + (found[1].labels["${NESTED_MARKER_LABEL}"] ?? "<no value>"));
}
else if (command === "run" && args.includes("--rm")) {
  // The cleanup container: deletes what it was given, as root would.
  for (const bind of binds()) {
    for (const entry of fs.readdirSync(bind.source)) {
      const target = path.join(bind.source, entry);
      if (fs.statSync(target).isDirectory()) fs.chmodSync(target, 0o700);
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  state.cleanups++; save();
}
else if (command === "run") {
  const id = require("node:crypto").randomBytes(32).toString("hex");
  const runtime = binds().find((b) => b.target === "${NESTED_RUNTIME_MOUNT}");
  fs.writeFileSync(path.join(runtime.source, "generation"), "1 100\\n");
  state.containers[id] = { name: option("--name")[0], labels: labels(), running: process.env.FAKE_RUN_EXITS !== "1", mounts: binds().map((b) => b.source) };
  save(); console.log(id);
}
else if (command === "exec") {
  if (process.env.FAKE_EXEC_FAIL === "1") fail("missing pidfile");
  if (process.env.FAKE_GENERATION_STUCK === "1") process.exit(0);
  const [, c] = find(args[1]);
  const runtime = c.mounts[0];
  const generation = Number(fs.readFileSync(path.join(runtime, "generation"), "utf8").split(" ")[0]);
  fs.writeFileSync(path.join(runtime, "generation"), (generation + 1) + " 200\\n");
}
else if (command === "rm") { const found = find(args.at(-1)); if (found) delete state.containers[found[0]]; save(); }
else if (command === "logs") { console.log("fake dind log"); }
else if (command === "save") { process.stdout.end(Buffer.alloc(4096)); }
else fail("fake docker: unexpected " + args.join(" "));
}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${stubDir}:${old.PATH}`;
  process.env.FAKE_OUTER_STATE = statePath;
  process.env.FAKE_OUTER_LOG = path.join(scratch, "outer.log");
  process.env.FAKE_OUTER_HOST = outerHost;
  restoreEnvironment = () => {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  };
}

function rootfulRecord(name = "unit"): InstanceRecord {
  const marker = "n".repeat(32);
  const paths = instancePaths(root, runtimeBase, name);
  const nested: NestedState = {
    outerHost,
    outerRootless: false,
    image: NESTED_DIND_IMAGE,
    pulledImage: false,
    ...nestedNames(name, marker, 1000),
    containerId: null,
    shareDir: paths.share,
    socketGid: 1000,
  };
  return {
    schema: 1,
    name,
    marker,
    runtimeBase,
    settings: { ...DEFAULT_SETTINGS, mode: "rootful" },
    paths,
    process: null,
    images: [],
    nested,
    createdAt: new Date(0).toISOString(),
  };
}

describe("rootful arguments and configuration", () => {
  test("mode flags parse, and each mode refuses the other's options", () => {
    const parsed = parseArguments(
      ["start", "--mode", "rootful", "--ipv6", "--live-restore", "--outer-host", "unix:///o.sock"],
      root,
    );
    expect(parsed.settings).toEqual({ mode: "rootful", ipv6: true, liveRestore: true });
    expect(parsed.outerHost).toBe("unix:///o.sock");
    expect(() => parseArguments(["start", "--mode", "rootful", "--net", "pasta"], root)).toThrow(
      "rootless mode only",
    );
    expect(() => parseArguments(["start", "--mode", "rootful", "--host-loopback"], root)).toThrow(
      "rootless mode only",
    );
    expect(() => parseArguments(["start", "--ipv6"], root)).toThrow("--mode rootful");
    expect(() => parseArguments(["start", "--outer-host", "unix:///o.sock"], root)).toThrow(
      "--mode rootful",
    );
    expect(() => parseArguments(["start", "--live-restore"], root)).toThrow("unsupported");
    expect(() => parseArguments(["start", "--mode", "nested"], root)).toThrow("--mode");
    expect(() => parseArguments(["restart", "--mode", "rootful"], root)).toThrow(
      "only accepted by start",
    );
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, ipv6: true })).toThrow("--mode rootful");
  });

  test("the inner daemon gets its own bridge and pools, and IPv6 only when asked", () => {
    const settings = { ...DEFAULT_SETTINGS, mode: "rootful" as const };
    expect(nestedDaemonConfig(settings)).toEqual({
      bip: "10.213.0.1/24",
      "default-address-pools": [{ base: "172.30.0.0/16", size: 24 }],
      "live-restore": false,
    });
    expect(daemonConfig(settings)).toEqual(nestedDaemonConfig(settings));
    expect(nestedDaemonConfig({ ...settings, ipv6: true, liveRestore: true })).toEqual({
      bip: "10.213.0.1/24",
      "default-address-pools": [
        { base: "172.30.0.0/16", size: 24 },
        { base: "2001:db8:100::/56", size: 64 },
      ],
      "live-restore": true,
      "default-network-opts": { bridge: { "com.docker.network.enable_ipv6": "true" } },
    });
  });

  test("the container is labelled, privileged, pinned, on the default bridge and publishes nothing", () => {
    const record = rootfulRecord();
    const args = nestedRunArguments(record, record.nested!);
    expect(NESTED_DIND_IMAGE).toMatch(/^docker:29\.\d+\.\d+-dind@sha256:[a-f0-9]{64}$/);
    expect(args.slice(0, 7)).toEqual([
      "run",
      "--detach",
      "--privileged",
      "--pull",
      "never",
      "--network",
      "bridge",
    ]);
    expect(args).toContain(`${NESTED_MARKER_LABEL}=${record.marker}`);
    expect(args).toContain(`${NESTED_NAME_LABEL}=unit`);
    expect(args).toContain(`type=volume,source=${record.nested!.volume},target=/var/lib/docker`);
    expect(args).toContain(
      `type=bind,source=${record.paths.runtimeDir},target=${NESTED_RUNTIME_MOUNT}`,
    );
    expect(args).toContain(`type=bind,source=${record.paths.share},target=${record.paths.share}`);
    expect(args).toContain("DOCKER_TLS_CERTDIR=");
    expect(args.some((arg) => /^(-p|--publish|--network=host|host)$/.test(arg))).toBe(false);
    expect(args.at(-3)).toBe(NESTED_DIND_IMAGE);
    expect(args.at(-1)).toBe(SUPERVISOR_SCRIPT);
    expect(SUPERVISOR_SCRIPT).toContain(`--host="unix://$run/docker.sock"`);
    expect(SUPERVISOR_SCRIPT).toContain(`--group="$ORK_DDD_GID"`);
    const bad = rootfulRecord();
    bad.paths = { ...bad.paths, runtimeDir: "/tmp/a,b" };
    expect(() => nestedRunArguments(bad, bad.nested!)).toThrow("cannot be bind-mounted");
    expect(nestedNames("q1", "abcdef0123456789ffff", 1000)).toEqual({
      container: "ork-ddd-1000-q1-abcdef012345",
      volume: "ork-ddd-1000-q1-abcdef012345-data",
    });
  });

  test("the outer daemon is explicit, then DOCKER_HOST, then the context, and only a Unix socket", () => {
    const context = () => "unix:///context.sock";
    expect(resolveOuterHost("unix:///x.sock", { DOCKER_HOST: "unix:///y.sock" }, context)).toBe(
      "unix:///x.sock",
    );
    expect(resolveOuterHost(undefined, { DOCKER_HOST: "unix:///y.sock" }, context)).toBe(
      "unix:///y.sock",
    );
    expect(resolveOuterHost(undefined, {}, context)).toBe("unix:///context.sock");
    for (const host of ["tcp://10.0.0.1:2376", "ssh://box", "unix://"]) {
      expect(() => resolveOuterHost(host, {}, context)).toThrow("unix://");
    }
    const env = outerEnvironment({
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///inner.sock",
      DOCKER_CONTEXT: "prod",
      DOCKER_TLS_VERIFY: "1",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("the suite environment names the mode and shared directory and clears host loopback", () => {
    const env = suiteEnvironment(rootfulRecord(), "/bin/bun");
    expect(env.DOCKER_HOST).toBe(`unix://${rootfulRecord().paths.socket}`);
    expect(env[MODE_ENV]).toBe("rootful");
    expect(env[HOST_LOOPBACK_ENV]).toBe("");
    expect(env[SHARED_DIR_ENV]).toBe(rootfulRecord().paths.share);
    expect(env.ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND).toContain(" restart --name unit --root ");
  });

  test("a record from before the rootful mode reads as rootless", () => {
    const paths = instancePaths(root, runtimeBase, "old");
    mkdirSync(paths.instanceDir, { recursive: true });
    const { mode: _mode, ipv6: _ipv6, ...legacySettings } = DEFAULT_SETTINGS;
    writeFileSync(
      paths.record,
      JSON.stringify({ ...rootfulRecord("old"), settings: legacySettings, nested: undefined }),
    );
    expect(readRecord(root, "old")?.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("rootful lifecycle against a fake outer daemon", () => {
  linuxTest(
    "start pulls the pinned image, restart replaces only dockerd, stop removes exactly what it made",
    async () => {
      fakeOuterDocker({ images: ["unrelated:tag"] });
      const started = await startInstance("unit", { mode: "rootful" }, options());
      const nested = started.nested!;
      expect(nested.outerHost).toBe(outerHost);
      expect(nested.pulledImage).toBe(true);
      expect(nested.containerId).toMatch(/^[a-f0-9]{64}$/);
      expect(isRunning(started)).toBe(true);
      expect(readRecord(root, "unit")?.nested).toEqual(nested);
      expect(Object.keys(state().volumes)).toEqual([nested.volume]);
      expect(state().volumes[nested.volume]![NESTED_MARKER_LABEL]).toBe(started.marker);
      // Nothing created a network or touched the outer daemon's configuration.
      expect(calls().some((call) => ["network", "system", "builder"].includes(call.args[0]!))).toBe(
        false,
      );
      // Every outer call names the outer daemon and carries no other selection.
      for (const call of calls().filter((c) => c.args[0] !== "context")) {
        expect(call.host).toBe(outerHost);
        expect(call.env).toEqual({ DOCKER_HOST: "", DOCKER_CONTEXT: "" });
      }

      // A restart runs from a suite whose DOCKER_HOST selects the inner daemon.
      process.env.DOCKER_HOST = suiteEnvironment(started).DOCKER_HOST;
      expect(readGeneration(started.paths.runtimeDir)).toBe(1);
      await restartInstance("unit", options({ runtimeBase: path.join(scratch, "elsewhere") }));
      expect(readGeneration(started.paths.runtimeDir)).toBe(2);
      expect(calls().find((call) => call.args[0] === "exec")?.host).toBe(outerHost);
      expect(Object.keys(state().containers)).toEqual([nested.containerId!]);

      // The copy reads from the recorded outer daemon, not from DOCKER_HOST.
      await fakeImage("fixture:dev");
      await transferImage(started, "fixture:dev");
      expect(calls().find((call) => call.args[0] === "save")?.host).toBe(outerHost);
      expect(calls().find((call) => call.args[0] === "load")?.host).toBe(
        `unix://${started.paths.socket}`,
      );
      delete process.env.DOCKER_HOST;

      expect(await stopInstance("unit", options())).toBe(true);
      expect(state()).toMatchObject({
        images: ["unrelated:tag", "fixture:dev"],
        volumes: {},
        containers: {},
      });
      expect(existsSync(started.paths.instanceDir)).toBe(false);
      expect(existsSync(started.paths.runtimeDir)).toBe(false);
      expect(await stopInstance("unit", options())).toBe(false);
    },
  );

  linuxTest("an image that was already there stays after stop", async () => {
    fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
    const started = await startInstance("keep", { mode: "rootful" }, options());
    expect(started.nested!.pulledImage).toBe(false);
    expect(calls().some((call) => call.args[0] === "pull")).toBe(false);
    await stopInstance("keep", options());
    expect(state().images).toEqual([NESTED_DIND_IMAGE]);
  });

  linuxTest(
    "files the user cannot remove are removed by a labelled cleanup container",
    async () => {
      fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
      const started = await startInstance("rootowned", { mode: "rootful" }, options());
      // Stands in for a directory an inner root process made in the shared directory.
      const locked = path.join(started.paths.share, "repo");
      mkdirSync(locked);
      writeFileSync(path.join(locked, "file"), "x");
      chmodSync(locked, 0o500);
      await stopInstance("rootowned", options());
      expect(state().cleanups).toBe(1);
      const cleanup = calls().find((call) => call.args[0] === "run" && call.args.includes("--rm"))!;
      expect(cleanup.args).toContain(`${NESTED_MARKER_LABEL}=${started.marker}`);
      expect(cleanup.args).toContain("none");
      expect(existsSync(started.paths.instanceDir)).toBe(false);
    },
  );

  linuxTest("a container under its name without its marker is refused and kept", async () => {
    fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
    const started = await startInstance("forged", { mode: "rootful" }, options());
    const record = readRecord(root, "forged")!;
    record.marker = "x".repeat(32);
    writeFileSync(record.paths.record, JSON.stringify(record));
    await expect(stopInstance("forged", options())).rejects.toThrow("marker");
    expect(Object.keys(state().containers)).toEqual([started.nested!.containerId!]);
    expect(existsSync(started.paths.record)).toBe(true);
    // Restore the true marker so cleanup can finish.
    writeFileSync(record.paths.record, JSON.stringify({ ...record, marker: started.marker }));
  });

  linuxTest(
    "an unreachable outer daemon keeps the record, and start reaps it only once it answers",
    async () => {
      fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
      const started = await startInstance("gone", { mode: "rootful" }, options());
      process.env.FAKE_OUTER_DOWN = "1";
      expect(isRunning(started)).toBe(false);
      await expect(stopInstance("gone", options())).rejects.toThrow("does not answer");
      const logged: string[] = [];
      expect(await reapStale(options({ log: (line) => logged.push(line) }))).toEqual([]);
      expect(logged.join("\n")).toContain("Left stale instance gone");
      expect(existsSync(started.paths.record)).toBe(true);
      delete process.env.FAKE_OUTER_DOWN;
      expect(await stopInstance("gone", options())).toBe(true);
      expect(state().containers).toEqual({});
    },
  );

  linuxTest("a container that exits during start is removed with everything else", async () => {
    fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
    process.env.FAKE_RUN_EXITS = "1";
    await expect(startInstance("dies", { mode: "rootful" }, options())).rejects.toThrow(
      "exited during start",
    );
    delete process.env.FAKE_RUN_EXITS;
    expect(state()).toMatchObject({ containers: {}, volumes: {} });
    expect(readRecord(root, "dies")).toBeNull();
    expect(existsSync(instancePaths(root, runtimeBase, "dies").runtimeDir)).toBe(false);
  });

  for (const kind of ["symlink", "nested path", "recorded path"] as const) {
    linuxTest(`stop and reap refuse an unsafe share: ${kind}`, async () => {
      fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
      const started = await startInstance("unsafe", { mode: "rootful" }, options());
      const outside = path.join(scratch, "outside");
      mkdirSync(outside);
      const sentinel = path.join(outside, "sentinel");
      writeFileSync(sentinel, "keep");
      const record = readRecord(root, "unsafe")!;
      if (kind === "symlink") {
        rmSync(started.paths.share, { recursive: true });
        symlinkSync(outside, started.paths.share);
      } else if (kind === "nested path") record.nested!.shareDir = outside;
      else record.paths.share = outside;
      writeFileSync(started.paths.record, JSON.stringify(record));
      expect(() => nestedRunArguments(record, record.nested!)).toThrow("shared directory");
      await expect(stopInstance("unsafe", options())).rejects.toThrow("shared directory");
      const current = state();
      current.containers[started.nested!.containerId!]!.running = false;
      writeFileSync(process.env.FAKE_OUTER_STATE!, JSON.stringify(current));
      const before = calls().length;
      expect(await reapStale(options())).toEqual([]);
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
      expect(existsSync(started.paths.record)).toBe(true);
      expect(
        calls()
          .slice(before)
          .some((c) => c.args[0] === "rm" || c.args[0] === "run"),
      ).toBe(false);
      expect(state().cleanups).toBe(0);
      if (kind === "symlink") {
        rmSync(started.paths.share);
        mkdirSync(started.paths.share);
      }
      writeFileSync(started.paths.record, JSON.stringify(started));
    });
  }

  linuxTest(
    "transient inspect failure preserves a running instance during reap and start",
    async () => {
      fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
      const started = await startInstance("active", { mode: "rootful" }, options());
      const failOnce = () => {
        const current = state();
        current.inspectFailures = 1;
        writeFileSync(process.env.FAKE_OUTER_STATE!, JSON.stringify(current));
      };
      failOnce();
      expect(await reapStale(options())).toEqual([]);
      expect(state().inspectFailures).toBe(0);
      failOnce();
      await startInstance("second", { mode: "rootful" }, options());
      expect(state().containers[started.nested!.containerId!]!.running).toBe(true);
      expect(existsSync(started.paths.record)).toBe(true);
      expect(calls().some((c) => c.args[0] === "rm")).toBe(false);
    },
  );

  linuxTest("automatic removal rechecks stopped state and never forces removal", async () => {
    fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
    const started = await startInstance("revived", { mode: "rootful" }, options());
    expect(() => removeNested(started, { log: () => undefined }, true)).toThrow("running");
    const current = state();
    current.containers[started.nested!.containerId!]!.running = false;
    current.reviveOnInspect = true;
    writeFileSync(process.env.FAKE_OUTER_STATE!, JSON.stringify(current));
    expect(await reapStale(options())).toEqual([]);
    expect(existsSync(started.paths.record)).toBe(true);
    expect(calls().some((c) => c.args[0] === "rm")).toBe(false);
    const stopped = state();
    stopped.containers[started.nested!.containerId!]!.running = false;
    writeFileSync(process.env.FAKE_OUTER_STATE!, JSON.stringify(stopped));
    expect(await reapStale(options())).toEqual(["revived"]);
    expect(state()).toMatchObject({ containers: {}, volumes: {} });
    expect(existsSync(started.paths.record)).toBe(false);
    expect(calls().find((c) => c.args[0] === "rm")!.args).not.toContain("--force");
  });

  for (const failure of ["exec", "generation"] as const) {
    linuxTest(`restart retains recoverable state after ${failure} failure`, async () => {
      fakeOuterDocker({ images: [NESTED_DIND_IMAGE] });
      const started = await startInstance("restartfail", { mode: "rootful" }, options());
      const key = failure === "exec" ? "FAKE_EXEC_FAIL" : "FAKE_GENERATION_STUCK";
      process.env[key] = "1";
      try {
        await expect(
          restartNested(started, {
            persist: () => undefined,
            ready: async () => true,
            readyTimeoutMs: 100,
            stopTimeoutMs: 100,
            restartGenerationTimeoutMs: 1,
            log: () => undefined,
          }),
        ).rejects.toThrow(failure === "exec" ? "missing pidfile" : "did not restart");
        expect(existsSync(started.paths.record)).toBe(true);
        expect(state().containers[started.nested!.containerId!]!.running).toBe(true);
        expect(readGeneration(started.paths.runtimeDir)).toBe(1);
      } finally {
        delete process.env[key];
      }
      await restartInstance("restartfail", options());
      expect(readGeneration(started.paths.runtimeDir)).toBe(2);
      expect(await stopInstance("restartfail", options())).toBe(true);
    });
  }

  linuxTest("an outer daemon that does not answer is refused before anything is made", async () => {
    fakeOuterDocker();
    process.env.FAKE_OUTER_DOWN = "1";
    await expect(startInstance("early", { mode: "rootful" }, options())).rejects.toThrow(
      "does not answer",
    );
    expect(existsSync(path.join(root, "early"))).toBe(false);
    await expect(
      startInstance(
        "self",
        { mode: "rootful" },
        options({ outerHost: `unix://${instancePaths(root, runtimeBase, "self").socket}` }),
      ),
    ).rejects.toThrow("own socket");
  });
});

/** Adds an image to the fake outer daemon, as if the caller had built it there. */
async function fakeImage(reference: string): Promise<void> {
  const current = state();
  current.images.push(reference);
  writeFileSync(process.env.FAKE_OUTER_STATE!, JSON.stringify(current));
}
