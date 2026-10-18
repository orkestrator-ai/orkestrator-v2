import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  linkedVersion,
  standaloneLayout,
  writeServiceConfig,
  type CommandRunner,
} from "@orkestrator/protocol/node/standalone-service";
import { HostMaintenanceService } from "./core/host-maintenance.js";
import { createStandaloneUpdater } from "./host-standalone-updater.js";

let dataDir: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-standalone-updater-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

function registry(tags: Record<string, string>): typeof fetch {
  return mock(async () =>
    Response.json({ name: "orkestrator", "dist-tags": tags }),
  ) as unknown as unknown as typeof fetch;
}

/** `bun install`, `--version` and `toolchain install` for fake releases. */
function runner(engines = ">=1.4.3"): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (_file, args, options) => {
    calls.push(args);
    if (args[0] === "install") {
      const manifest = JSON.parse(
        await Bun.file(path.join(options.cwd!, "package.json")).text(),
      ) as { dependencies: { orkestrator: string } };
      const version = manifest.dependencies.orkestrator;
      const root = path.join(options.cwd!, "node_modules", "orkestrator");
      await mkdir(path.join(root, "bin"), { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "orkestrator", version, engines: { bun: engines } }),
      );
      await writeFile(path.join(root, "bin", "orkestrator.js"), "// entry\n");
      await writeFile(path.join(root, "bin", "orkestrator-launcher.js"), "// launcher\n");
      return { stdout: "", stderr: "" };
    }
    if (args[1] === "--version") {
      const version = path.basename(path.resolve(args[0]!, "../../../.."));
      return { stdout: `orkestrator ${version}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
}

async function setup(
  options: {
    engines?: string;
    latest?: string;
    tags?: Record<string, string>;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const layout = standaloneLayout(dataDir);
  await writeServiceConfig(layout, {
    version: 1,
    dataDir,
    bun: "/usr/local/bin/bun",
    bunVersion: "1.4.3",
    args: [],
    installedAt: "2026-10-16T00:00:00Z",
  });
  const service = new HostMaintenanceService({
    dataDir,
    updater: "standalone",
    version: "2.21.1",
    emit: () => undefined,
  });
  service.init();
  service.markReady();
  const shutdown = mock(() => undefined);
  const { run, calls } = runner(options.engines);
  const updater = createStandaloneUpdater({
    service,
    layout,
    dataDir,
    currentVersion: "2.21.1",
    shutdown,
    fetchImpl:
      options.fetchImpl ?? registry(options.tags ?? { latest: options.latest ?? "2.22.0" }),
    run,
    restartDelayMs: 30,
    idlePollMs: 5,
    log: { info: () => undefined, warn: () => undefined },
  });
  updater.start();
  cleanups.push(() => {
    updater.stop();
    service.close();
  });
  return { layout, service, shutdown, calls, updater };
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("createStandaloneUpdater", () => {
  test("checks the dist-tags of the host's update channel and every more stable one", async () => {
    const { service, updater } = await setup({
      tags: { latest: "2.22.0", beta: "2.23.0-beta", alpha: "2.24.0-alpha" },
    });
    const newest = async () => {
      await updater.check();
      return service.snapshot().updater.latestVersion;
    };
    expect(await newest()).toBe("2.22.0");
    service.setUpdateChannel("beta");
    expect(await newest()).toBe("2.23.0-beta");
    service.setUpdateChannel("unstable");
    expect(await newest()).toBe("2.24.0-alpha");
  });

  test("a stable release newer than the last beta reaches the Beta channel", async () => {
    const { service, updater } = await setup({
      tags: { latest: "2.23.0", beta: "2.23.0-beta" },
    });
    service.setUpdateChannel("beta");
    await updater.check();
    expect(service.snapshot().updater).toMatchObject({
      latestVersion: "2.23.0",
      updateAvailable: true,
    });
  });

  test("installs, pre-installs the toolchain, counts down, switches current and restarts", async () => {
    const { layout, service, shutdown, calls } = await setup();
    const job = service.requestUpdate({ requestedVersion: null });
    await until(() => shutdown.mock.calls.length > 0);
    expect(service.job(job.id)).toMatchObject({ state: "restarting", targetVersion: "2.22.0" });
    expect(linkedVersion(layout.current)).toBe("2.22.0");
    expect(existsSync(layout.restartMarker)).toBe(true);
    expect(existsSync(layout.launcher)).toBe(true);
    expect(
      calls.map((args) =>
        args[1] === "--version" ? "smoke" : args[0] === "install" ? "install" : args[1],
      ),
    ).toEqual(["install", "smoke", "toolchain"]);
  });

  test("answers a check request from the registry", async () => {
    const { service } = await setup({ latest: "2.23.0" });
    service.requestCheck();
    await until(() => service.snapshot().checkRequest === null);
    expect(service.snapshot().updater).toMatchObject({
      latestVersion: "2.23.0",
      updateAvailable: true,
    });
  });

  test("a cancel during the countdown leaves current alone", async () => {
    const { layout, service, shutdown } = await setup();
    const job = service.requestUpdate({ requestedVersion: null });
    await until(() => service.job(job.id)?.state === "awaiting-restart");
    service.cancelUpdate(job.id);
    await Bun.sleep(80);
    expect(shutdown).not.toHaveBeenCalled();
    expect(linkedVersion(layout.current)).toBeNull();
  });

  test("refuses a release that needs a newer Bun than the service runs", async () => {
    const { service, shutdown } = await setup({ engines: ">=9.0.0" });
    const job = service.requestUpdate({ requestedVersion: null });
    await until(() => service.job(job.id)?.state === "failed");
    expect(service.job(job.id)?.error).toContain("needs Bun >=9.0.0");
    expect(shutdown).not.toHaveBeenCalled();
  });

  test("fails without restarting when nothing newer is published", async () => {
    const { service, shutdown } = await setup({ latest: "2.21.1" });
    const job = service.requestUpdate({ requestedVersion: null });
    await until(() => service.job(job.id)?.state === "failed");
    expect(service.job(job.id)?.error).toContain("newest release");
    expect(shutdown).not.toHaveBeenCalled();
  });
});

test.each(["failed-read", "unknown-terminal"])(
  "when-idle waits through %s until authoritative idle",
  async (mode) => {
    const { service, shutdown } = await setup();
    let idle = false;
    let reads = 0;
    service.setReaders({
      impact: async () => {
        reads += 1;
        if (!idle && mode === "failed-read") throw new Error("unavailable");
        return {
          workingAgents: 0,
          waitingAgents: 0,
          unknownAgents: idle ? 0 : 1,
          activePipelines: 0,
          terminals: 0,
          hostServers: 0,
          measuredAt: new Date().toISOString(),
        };
      },
    });
    const job = service.requestUpdate({ requestedVersion: null, drain: "when-idle" });
    await until(() => reads >= 3);
    expect(service.job(job.id)?.state).toBe("waiting-for-idle");
    expect(shutdown).not.toHaveBeenCalled();
    idle = true;
    await until(() => shutdown.mock.calls.length > 0);
  },
);

test("startup settlement precedes executor startup so interrupted requests are never resumed", async () => {
  const prior = new HostMaintenanceService({
    dataDir,
    updater: "standalone",
    version: "2.21.1",
    emit: () => undefined,
  });
  prior.init();
  prior.markReady();
  const job = prior.requestUpdate({ requestedVersion: "2.22.0" });
  prior.close();
  const { service, calls, shutdown } = await setup();
  await Bun.sleep(40);
  expect(service.job(job.id)?.state).toBe("failed");
  expect(calls).toEqual([]);
  expect(shutdown).not.toHaveBeenCalled();
});

for (const outcome of ["success", "failure"] as const) {
  test(`obsolete standalone ${outcome} cannot overwrite the current channel`, async () => {
    const requests: Array<{ resolve(value: Response): void; reject(error: Error): void }> = [];
    const fetchImpl = (() =>
      new Promise<Response>((resolve, reject) =>
        requests.push({ resolve, reject }),
      )) as unknown as typeof fetch;
    const { service, updater } = await setup({ fetchImpl });
    service.setUpdateChannel("unstable");
    const old = updater.check();
    service.setUpdateChannel("stable");
    const current = updater.check();
    const response = () =>
      Response.json({ "dist-tags": { latest: "2.23.0", alpha: "2.24.0-alpha" } });
    requests.at(-1)!.resolve(response());
    requests[2]!.resolve(response()); // the switch-triggered Stable check
    await current;
    await until(() => service.snapshot().checkRequest === null);
    const expected = service.snapshot().updater;
    for (const request of requests.slice(0, 2)) {
      if (outcome === "success") request.resolve(response());
      else request.reject(new Error("obsolete registry failure"));
    }
    await old;
    expect(service.snapshot().updateChannel).toBe("stable");
    expect(service.snapshot().updater).toEqual(expected);
    expect(service.snapshot().updater.latestVersion).toBe("2.23.0");
  });
}

test("standalone refuses an explicitly requested release outside the current channel", async () => {
  const { service, calls, shutdown } = await setup();
  const job = service.requestUpdate({ requestedVersion: "2.24.0-alpha" });
  await until(() => service.job(job.id)?.state === "failed");
  expect(service.job(job.id)?.error).toContain("not available on the stable channel");
  expect(calls).toEqual([]);
  expect(shutdown).not.toHaveBeenCalled();
});

test("returning to the same channel does not revive an obsolete check generation", async () => {
  const requests: Array<(value: Response) => void> = [];
  const fetchImpl = (() =>
    new Promise<Response>((resolve) => requests.push(resolve))) as unknown as typeof fetch;
  const { service } = await setup({ fetchImpl });
  service.setUpdateChannel("unstable");
  service.setUpdateChannel("stable");
  service.setUpdateChannel("unstable");
  requests[2]!(Response.json({ "dist-tags": { latest: "2.23.0", alpha: "2.25.0-alpha" } }));
  await until(() => service.snapshot().checkRequest === null);
  const expected = service.snapshot();
  requests[0]!(Response.json({ "dist-tags": { latest: "2.23.0", alpha: "2.99.0-alpha" } }));
  requests[1]!(Response.json({ "dist-tags": { latest: "2.23.0" } }));
  await Bun.sleep(10);
  expect(service.snapshot()).toEqual(expected);
});
