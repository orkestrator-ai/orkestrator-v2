import { describe, expect, test } from "bun:test";
import type { UpdateHostRequest } from "@orkestrator/protocol/updates";
import {
  childServeArgs,
  Supervisor,
  type BackendChild,
  type BackendClient,
  type ExitInfo,
  type SupervisorRuntime,
  type SupervisorState,
} from "../src/supervisor/supervisor.js";

type BackendBehaviour = {
  version: string;
  /** Never becomes ready (exits first). */
  failsToStart?: boolean;
  /** Reports this version from /status instead of its own. */
  reportsVersion?: string;
  /** Migrates the database to this schema version when it starts. */
  migratesTo?: number;
  stopGate?: Promise<void>;
};

type FakeBackend = {
  root: string;
  version: string;
  invokes: Array<{ command: string; args: Record<string, unknown> }>;
  pending: UpdateHostRequest[];
  exit(info?: ExitInfo): void;
  signals: string[];
};

const OWN_ROOT = "/bunx/orkestrator";
const versionRoot = (version: string) =>
  `/data/runtime/versions/${version}/node_modules/orkestrator`;
const installDir = (version: string) => `/data/runtime/versions/${version}`;

function harness(options: {
  ownVersion?: string;
  current?: string | null;
  behaviours: Record<string, BackendBehaviour>;
  state?: SupervisorState | null;
  userVersion?: number;
  snapshotAvailable?: boolean;
  /** The supervisor's clock, which a test may move. */
  clock?: { now: number };
  /** Staging these versions fails. */
  stageFails?: string[];
  /** Staging waits for this before it finishes. */
  stageGate?: Promise<void>;
  /** Pointing `current` at these install directories fails. */
  setCurrentFails?: string[];
  configure?: (runtime: SupervisorRuntime) => void;
}) {
  const clock = options.clock ?? { now: 1_000 };
  const log: string[] = [];
  const backends: FakeBackend[] = [];
  let current: string | null = options.current ?? null;
  let previous: string | null = null;
  let state: SupervisorState | null = options.state ?? null;
  let userVersion = options.userVersion ?? 3;
  let toolchain: string | null = "/data/toolchains/bin/old";
  const restored: Array<[number, number]> = [];
  const staged: string[] = [];
  const pruned: string[][] = [];

  const runtime: SupervisorRuntime = {
    spawn(packageRoot): BackendChild {
      const behaviour = options.behaviours[packageRoot];
      if (!behaviour) throw new Error(`no backend behaviour for ${packageRoot}`);
      let resolveExit!: (info: ExitInfo) => void;
      const exited = new Promise<ExitInfo>((resolve) => {
        resolveExit = resolve;
      });
      const backend: FakeBackend = {
        root: packageRoot,
        version: behaviour.version,
        invokes: [],
        pending: [],
        signals: [],
        exit: (info = { code: 1, signal: null }) => resolveExit(info),
      };
      backends.push(backend);
      if (behaviour.migratesTo !== undefined) userVersion = behaviour.migratesTo;
      if (behaviour.failsToStart) {
        setTimeout(() => backend.exit(), 0);
        return { ready: new Promise(() => undefined), exited, signal: () => undefined };
      }
      return {
        ready: Promise.resolve({
          url: `http://127.0.0.1/${backends.length}/`,
          token: "t".repeat(32),
        }),
        exited,
        signal(signal) {
          backend.signals.push(signal);
          if (behaviour.stopGate)
            void behaviour.stopGate.then(() => backend.exit({ code: null, signal }));
          else backend.exit({ code: null, signal });
        },
      };
    },
    client(endpoint): BackendClient {
      const index = Number(endpoint.url.split("/").at(-2)) - 1;
      const backend = backends[index]!;
      const behaviour = options.behaviours[backend.root]!;
      return {
        async invoke<T>(command: string, args: Record<string, unknown>) {
          backend.invokes.push({ command, args });
          if (command === "update_host_register") return { hostSessionId: `s-${index}` } as T;
          if (command === "update_host_pending") {
            const pending = backend.pending;
            return pending as T;
          }
          return { ok: true } as T;
        },
        async status() {
          return { ok: true, appVersion: behaviour.reportsVersion ?? behaviour.version };
        },
      };
    },
    async stage(version) {
      staged.push(version);
      await options.stageGate;
      if (options.stageFails?.includes(version)) throw new Error(`bun add ${version} failed`);
      return installDir(version);
    },
    readCurrent: async () => current,
    setCurrent: async (dir) => {
      if (dir && options.setCurrentFails?.includes(dir)) throw new Error(`ENOSPC: ${dir}`);
      current = dir;
    },
    setPrevious: async (dir) => {
      previous = dir;
    },
    packageRootOf: (dir) => `${dir}/node_modules/orkestrator`,
    packageVersion: async (root) => options.behaviours[root]?.version ?? null,
    readState: async () => state,
    writeState: async (next) => {
      state = structuredClone(next);
    },
    readUserVersion: () => userVersion,
    restoreSnapshot: async (fromVersion, since) => {
      restored.push([fromVersion, since]);
      if (options.snapshotAvailable === false) return false;
      userVersion = fromVersion;
      return true;
    },
    readToolchainCurrent: async () => toolchain,
    pointToolchainCurrent: async (binDir) => {
      toolchain = binDir;
    },
    prune: async (keep) => {
      pruned.push([...keep]);
    },
    compareVersions: (left, right) => Bun.semver.order(left, right),
    now: () => clock.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
    log: {
      info: (message: string) => log.push(message),
      warn: (message: string) => log.push(message),
      error: (message: string) => log.push(message),
    },
  };
  options.configure?.(runtime);
  const supervisor = new Supervisor({
    ownPackageRoot: OWN_ROOT,
    ownVersion: options.ownVersion ?? "2.21.0",
    serveArgs: ["--host", "127.0.0.1", "--allow-non-tailscale-bind"],
    runtime,
  });
  const running = supervisor.run();
  return {
    supervisor,
    runtime,
    running,
    backends,
    log,
    staged,
    pruned,
    restored,
    get current() {
      return current;
    },
    get previous() {
      return previous;
    },
    get state() {
      return state;
    },
    get toolchain() {
      return toolchain;
    },
    get userVersion() {
      return userVersion;
    },
  };
}

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const prepare = (version: string): UpdateHostRequest => ({
  kind: "prepare",
  requestId: `prepare-${version}`,
  jobId: "job-1",
  target: { version, tag: `v${version}`, channel: "stable", requirementsSha256: "a".repeat(64) },
  feedBaseUrl: "https://github.com/x/y/releases/download",
  allowDowngrade: false,
});

const install = (
  version: string,
  toolchainBinDir: string | null = "/data/toolchains/bin/new",
): UpdateHostRequest => ({
  kind: "install",
  requestId: `install-${version}`,
  jobId: "job-1",
  target: { version, tag: `v${version}`, channel: "stable", requirementsSha256: "a".repeat(64) },
  fromVersion: "2.21.0",
  restart: "now",
  storageSchemaVersion: 3,
  toolchainBinDir,
});

const reports = (
  backend: { invokes: Array<{ command: string; args: Record<string, unknown> }> },
  command: string,
) => backend.invokes.filter((call) => call.command === command).map((call) => call.args);

describe("supervisor arguments", () => {
  test("the child always gets a loopback control listener, and never --supervised", () => {
    expect(childServeArgs(["--supervised", "--host", "100.64.0.1"])).toEqual([
      "--host",
      "100.64.0.1",
      "--control-host",
      "127.0.0.1",
      "--control-port",
      "0",
    ]);
    expect(childServeArgs(["--control-host=127.0.0.1", "--control-port", "4000"])).toEqual([
      "--control-host=127.0.0.1",
      "--control-port",
      "4000",
    ]);
  });
});

describe("running the backend", () => {
  test("starts its own package, registers as the installer, and stops cleanly", async () => {
    const h = harness({ behaviours: { [OWN_ROOT]: { version: "2.21.0" } } });
    await until(
      () => h.backends[0]?.invokes.some((call) => call.command === "update_host_register") === true,
    );
    expect(reports(h.backends[0]!, "update_host_register")[0]).toMatchObject({
      registration: {
        hostKind: "supervisor",
        installKind: "npm-package",
        capabilities: { install: true, rollback: true },
      },
    });
    h.supervisor.stop();
    expect(await h.running).toBe(0);
    expect(h.backends[0]!.signals).toEqual(["SIGTERM"]);
  });

  test("runs the installed current version, even one older than its own", async () => {
    const h = harness({
      current: installDir("2.22.0"),
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0" },
      },
    });
    await until(() => h.backends.length === 1);
    expect(h.backends[0]!.root).toBe(versionRoot("2.22.0"));
    h.supervisor.stop();
    await h.running;
    const older = harness({
      ownVersion: "2.23.0",
      current: installDir("2.22.0"),
      behaviours: {
        [OWN_ROOT]: { version: "2.23.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0" },
      },
    });
    // A rollback or an approved downgrade points current at an older version.
    await until(() => older.backends.length === 1);
    expect(older.backends[0]!.root).toBe(versionRoot("2.22.0"));
    older.supervisor.stop();
    await older.running;
  });

  test("restarts a backend that exits", async () => {
    const h = harness({ behaviours: { [OWN_ROOT]: { version: "2.21.0" } } });
    await until(() => h.backends.length === 1 && h.backends[0]!.invokes.length > 0);
    h.backends[0]!.exit();
    await until(() => h.backends.length === 2, "a restart");
    h.supervisor.stop();
    await h.running;
  });
});

describe("updating", () => {
  test("stages the target (and the running bootstrap version) on prepare", async () => {
    const h = harness({ behaviours: { [OWN_ROOT]: { version: "2.21.0" } } });
    await until(() => h.backends.length === 1);
    h.backends[0]!.pending.push(prepare("2.22.0"));
    await until(() =>
      reports(h.backends[0]!, "update_host_report").some((report) => report.status === "succeeded"),
    );
    expect(h.staged).toEqual(["2.21.0", "2.22.0"]);
    h.supervisor.stop();
    await h.running;
  });

  test("keeps reporting progress while staging is slow", async () => {
    let release!: () => void;
    const h = harness({
      behaviours: { [OWN_ROOT]: { version: "2.21.0" } },
      stageGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    await until(() => h.backends.length === 1);
    h.backends[0]!.pending.push(prepare("2.22.0"));
    await until(
      () =>
        reports(h.backends[0]!, "update_host_report").filter(
          (report) => report.status === "progress",
        ).length >= 3,
      "heartbeats",
    );
    release();
    await until(() =>
      reports(h.backends[0]!, "update_host_report").some((report) => report.status === "succeeded"),
    );
    h.supervisor.stop();
    await h.running;
  });

  test("a healthy cutover commits, reports success to the new backend, and keeps the previous version", async () => {
    const h = harness({
      current: installDir("2.21.0"),
      ownVersion: "2.21.0",
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0", migratesTo: 4 },
      },
    });
    await until(() => h.backends.length === 1);
    const old = h.backends[0]!;
    old.pending.push(install("2.22.0"));
    await until(
      () => h.backends.length === 2 && reports(h.backends[1]!, "update_host_outcome").length === 1,
      "the outcome",
    );
    expect(reports(old, "update_host_report").map((report) => report.status)).toEqual([
      "progress",
      "succeeded",
    ]);
    expect(old.signals).toEqual(["SIGTERM"]);
    expect(reports(h.backends[1]!, "update_host_outcome")[0]).toEqual({
      hostSessionId: "s-1",
      jobId: "job-1",
      outcome: "succeeded",
    });
    expect(h.current).toBe(installDir("2.22.0"));
    expect(h.previous).toBe(installDir("2.21.0"));
    expect(h.toolchain).toBe("/data/toolchains/bin/new");
    expect(h.restored).toEqual([]);
    expect(h.pruned.at(-1)).toEqual([installDir("2.22.0"), installDir("2.21.0")]);
    expect(h.state).toMatchObject({ cutover: null, pendingOutcome: null });
    h.supervisor.stop();
    await h.running;
  });

  test("an unhealthy version is rolled back: database snapshot, binaries and version restored", async () => {
    const h = harness({
      current: installDir("2.21.0"),
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
        // Starts and migrates the database, but reports the wrong version.
        [versionRoot("2.22.0")]: { version: "2.22.0", migratesTo: 4, reportsVersion: "0.0.0" },
      },
    });
    await until(() => h.backends.length === 1);
    h.backends[0]!.pending.push(install("2.22.0"));
    await until(
      () => h.backends.length === 3 && reports(h.backends[2]!, "update_host_outcome").length === 1,
      "the rollback outcome",
    );
    expect(h.backends.map((backend) => backend.root)).toEqual([
      versionRoot("2.21.0"),
      versionRoot("2.22.0"),
      versionRoot("2.21.0"),
    ]);
    expect(reports(h.backends[2]!, "update_host_outcome")[0]).toMatchObject({
      outcome: "rolled-back",
      error: { code: "health-check" },
    });
    expect(h.restored).toEqual([[3, 1_000]]);
    expect(h.userVersion).toBe(3);
    expect(h.current).toBe(installDir("2.21.0"));
    expect(h.toolchain).toBe("/data/toolchains/bin/old");
    h.supervisor.stop();
    await h.running;
  });

  test("when the previous version will not start either, the failure is reported and retried", async () => {
    let restarted = 0;
    const behaviours: Record<string, BackendBehaviour> = {
      [OWN_ROOT]: { version: "2.21.0" },
      [versionRoot("2.21.0")]: { version: "2.21.0" },
      [versionRoot("2.22.0")]: { version: "2.22.0", failsToStart: true },
    };
    const h = harness({ current: installDir("2.21.0"), behaviours });
    await until(() => h.backends.length === 1);
    // From now on the old version is broken too.
    behaviours[versionRoot("2.21.0")] = { version: "2.21.0", failsToStart: true };
    h.backends[0]!.pending.push(install("2.22.0"));
    await until(() => h.state?.pendingOutcome?.outcome === "failed", "the failed outcome");
    expect(h.state?.pendingOutcome).toMatchObject({ rollbackFailed: true });
    behaviours[versionRoot("2.21.0")] = { version: "2.21.0" };
    await until(() => {
      restarted = h.backends.filter((backend) =>
        backend.invokes.some((call) => call.command === "update_host_outcome"),
      ).length;
      return restarted === 1;
    }, "delivery once the old version starts");
    h.supervisor.stop();
    await h.running;
  });

  test("a cutover interrupted by a supervisor crash is rolled back on the next start", async () => {
    const h = harness({
      current: installDir("2.22.0"),
      state: {
        version: 1,
        cutover: {
          jobId: "job-9",
          fromRoot: versionRoot("2.21.0"),
          fromInstallDir: installDir("2.21.0"),
          toRoot: versionRoot("2.22.0"),
          toInstallDir: installDir("2.22.0"),
          toVersion: "2.22.0",
          startedAt: 500,
          toolchainBefore: "/data/toolchains/bin/before",
          userVersionBefore: 3,
        },
        pendingOutcome: null,
        lastInstall: null,
      },
      userVersion: 4,
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0" },
      },
    });
    await until(
      () => reports(h.backends[0] ?? { invokes: [] }, "update_host_outcome").length === 1,
      "the outcome",
    );
    expect(h.backends[0]!.root).toBe(versionRoot("2.21.0"));
    expect(reports(h.backends[0]!, "update_host_outcome")[0]).toMatchObject({
      jobId: "job-9",
      outcome: "rolled-back",
      error: { code: "interrupted" },
    });
    expect(h.restored).toEqual([[3, 500]]);
    expect(h.toolchain).toBe("/data/toolchains/bin/before");
    h.supervisor.stop();
    await h.running;
  });

  test("a target that cannot be staged at install leaves the old backend running", async () => {
    const h = harness({
      current: installDir("2.21.0"),
      stageFails: ["2.22.0"],
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
      },
    });
    await until(() => h.backends.length === 1);
    const old = h.backends[0]!;
    old.pending.push(install("2.22.0"));
    await until(() => reports(old, "update_host_outcome").length === 1, "the outcome");
    expect(reports(old, "update_host_outcome")[0]).toMatchObject({
      jobId: "job-1",
      outcome: "failed",
      rollbackFailed: false,
      error: { code: "install-failed" },
    });
    expect(old.signals).toEqual([]);
    expect(h.backends).toHaveLength(1);
    expect(h.current).toBe(installDir("2.21.0"));
    h.supervisor.stop();
    await h.running;
  });

  test("a failure after the old backend stopped is rolled back", async () => {
    const h = harness({
      current: installDir("2.21.0"),
      setCurrentFails: [installDir("2.22.0")],
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0" },
      },
    });
    await until(() => h.backends.length === 1);
    h.backends[0]!.pending.push(install("2.22.0"));
    await until(
      () => reports(h.backends[1] ?? { invokes: [] }, "update_host_outcome").length === 1,
      "the rollback outcome",
    );
    expect(h.backends.map((backend) => backend.root)).toEqual([
      versionRoot("2.21.0"),
      versionRoot("2.21.0"),
    ]);
    expect(reports(h.backends[1]!, "update_host_outcome")[0]).toMatchObject({
      outcome: "rolled-back",
      error: { code: "install-failed", message: expect.stringContaining("ENOSPC") },
    });
    expect(h.toolchain).toBe("/data/toolchains/bin/old");
    h.supervisor.stop();
    await h.running;
  });

  test("an update of the bootstrap package rolls back to its staged copy", async () => {
    const h = harness({
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0", reportsVersion: "0.0.0" },
      },
    });
    await until(() => h.backends.length === 1);
    h.backends[0]!.pending.push(install("2.22.0"));
    await until(
      () => reports(h.backends[2] ?? { invokes: [] }, "update_host_outcome").length === 1,
      "the rollback outcome",
    );
    expect(h.backends.map((backend) => backend.root)).toEqual([
      OWN_ROOT,
      versionRoot("2.22.0"),
      versionRoot("2.21.0"),
    ]);
    expect(h.current).toBe(installDir("2.21.0"));
    h.supervisor.stop();
    await h.running;
  });

  test("a stop that arrives during a cutover stops the new backend", async () => {
    let release!: () => void;
    const h = harness({
      current: installDir("2.21.0"),
      stageGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0" },
      },
    });
    await until(() => h.backends.length === 1);
    h.backends[0]!.pending.push(install("2.22.0"));
    await until(() => h.staged.includes("2.22.0"), "staging");
    h.supervisor.stop();
    release();
    expect(await h.running).toBe(0);
    expect(h.backends.at(-1)?.signals).toEqual(["SIGTERM"]);
  });

  test("a freshly installed version that keeps crashing is rolled back", async () => {
    const behaviours: Record<string, BackendBehaviour> = {
      [OWN_ROOT]: { version: "2.21.0" },
      [versionRoot("2.21.0")]: { version: "2.21.0" },
      [versionRoot("2.22.0")]: { version: "2.22.0" },
    };
    const h = harness({ current: installDir("2.21.0"), behaviours });
    await until(() => h.backends.length === 1);
    h.backends[0]!.pending.push(install("2.22.0"));
    await until(
      () => reports(h.backends[1] ?? { invokes: [] }, "update_host_outcome").length === 1,
    );
    // After a healthy start the new version starts failing.
    behaviours[versionRoot("2.22.0")] = { version: "2.22.0", failsToStart: true };
    h.backends[1]!.exit();
    await until(() => h.current === installDir("2.21.0"), "the crash-loop rollback");
    await until(
      () => h.backends.at(-1)?.root === versionRoot("2.21.0"),
      "the old version running again",
    );
    h.supervisor.stop();
    await h.running;
  });

  test("an installed version that fails long after its install is not rolled back", async () => {
    const clock = { now: 1_000 };
    const behaviours: Record<string, BackendBehaviour> = {
      [OWN_ROOT]: { version: "2.21.0" },
      [versionRoot("2.21.0")]: { version: "2.21.0" },
      [versionRoot("2.22.0")]: { version: "2.22.0" },
    };
    const h = harness({ current: installDir("2.21.0"), behaviours, clock });
    await until(() => h.backends.length === 1);
    h.backends[0]!.pending.push(install("2.22.0"));
    await until(
      () => reports(h.backends[1] ?? { invokes: [] }, "update_host_outcome").length === 1,
    );
    // Hours later the new version starts failing for reasons of its own.
    clock.now += 3 * 60 * 60 * 1000;
    behaviours[versionRoot("2.22.0")] = { version: "2.22.0", failsToStart: true };
    h.backends[1]!.exit();
    await until(() => h.backends.length >= 6, "several restarts");
    expect(h.current).toBe(installDir("2.22.0"));
    expect(h.restored).toEqual([]);
    expect(h.state?.lastInstall).toBeNull();
    h.supervisor.stop();
    await h.running;
  });
});

describe("supervisor commit failure recovery", () => {
  test.each(["previous", "commit"])(
    "stops and drains replacement before restoring after %s write fails",
    async (failure) => {
      let release!: () => void;
      const stopGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness({
        behaviours: {
          [OWN_ROOT]: { version: "2.21.0" },
          [versionRoot("2.21.0")]: { version: "2.21.0" },
          [versionRoot("2.22.0")]: { version: "2.22.0", migratesTo: 4, stopGate },
        },
        configure(runtime) {
          if (failure === "previous")
            runtime.setPrevious = async () => {
              throw new Error("disk full");
            };
          else {
            const write = runtime.writeState;
            runtime.writeState = async (state) => {
              if (state.pendingOutcome?.outcome === "succeeded") throw new Error("disk full");
              await write(state);
            };
          }
        },
      });
      try {
        await until(() => h.backends.length > 0);
        h.backends[0]!.pending.push(install("2.22.0"));
        await until(() => h.backends[1]?.signals.includes("SIGTERM") === true);
        expect(h.restored).toEqual([]);
        expect(h.backends).toHaveLength(2);
        release();
        await until(() => h.backends.length === 3);
        expect(h.restored).toHaveLength(1);
        expect(h.current).toBe(installDir("2.21.0"));
        expect(h.userVersion).toBe(3);
      } finally {
        release();
        h.supervisor.stop();
        await h.running;
      }
    },
  );

  test("restores current even when restoring the toolchain fails", async () => {
    const h = harness({
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0", reportsVersion: "wrong" },
      },
      configure(runtime) {
        const point = runtime.pointToolchainCurrent;
        runtime.pointToolchainCurrent = async (dir) => {
          if (dir.endsWith("/old")) throw new Error("toolchain restore failed");
          await point(dir);
        };
      },
    });
    try {
      await until(() => h.backends.length > 0);
      h.backends[0]!.pending.push(install("2.22.0"));
      await until(() => h.backends.length === 3);
      expect(h.current).toBe(installDir("2.21.0"));
    } finally {
      h.supervisor.stop();
      await h.running;
    }
  });

  test("retries an initially rejected host registration", async () => {
    let attempts = 0;
    const h = harness({
      behaviours: { [OWN_ROOT]: { version: "2.21.0" } },
      configure(runtime) {
        const client = runtime.client;
        runtime.client = (endpoint) => {
          const original = client(endpoint);
          return {
            ...original,
            async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
              if (command === "update_host_register" && ++attempts === 1)
                throw new Error("temporarily unavailable");
              return original.invoke<T>(command, args);
            },
          };
        };
      },
    });
    try {
      await until(
        () =>
          h.backends[0]?.invokes.some((call) => call.command === "update_host_pending") === true,
      );
      expect(attempts).toBe(2);
    } finally {
      h.supervisor.stop();
      await h.running;
    }
  });

  test("failure clearing the delivered outcome keeps ownership of the healthy backend", async () => {
    const h = harness({
      behaviours: {
        [OWN_ROOT]: { version: "2.21.0" },
        [versionRoot("2.21.0")]: { version: "2.21.0" },
        [versionRoot("2.22.0")]: { version: "2.22.0" },
      },
      configure(runtime) {
        const write = runtime.writeState;
        runtime.writeState = async (state) => {
          if (state.lastInstall && !state.pendingOutcome)
            throw new Error("disk full clearing outcome");
          await write(state);
        };
      },
    });
    try {
      await until(() => h.backends.length > 0);
      h.backends[0]!.pending.push(install("2.22.0"));
      await until(() => h.log.some((line) => line.includes("Updated to 2.22.0")));
      expect(h.backends).toHaveLength(2);
      expect(h.backends[1]!.signals).toEqual([]);
      expect(h.current).toBe(installDir("2.22.0"));
    } finally {
      h.supervisor.stop();
      await h.running;
    }
  });
});
