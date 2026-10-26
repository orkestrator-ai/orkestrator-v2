import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  qualifyStandaloneService,
  type QualificationResult,
  type QualificationRuntime,
} from "../../scripts/qualify-standalone-service";

const roots: string[] = [];
const children = new Set<ReturnType<typeof Bun.spawn>>();
afterEach(async () => {
  for (const child of Array.from(children)) {
    child.kill();
    await child.exited;
    children.delete(child);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  options: {
    manager?: "systemd" | "launchd";
    missingAnchor?: boolean;
    uninstallFails?: boolean;
    unloadFails?: boolean;
    reloadFails?: boolean;
    staysLoaded?: boolean;
    backendSurvives?: boolean;
    interrupt?: "SIGINT" | "SIGTERM";
    interruptDuringApply?: boolean;
    realBackend?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualify-service-test-"));
  roots.push(root);
  const report = path.join(root, "report.json");
  const calls: string[][] = [];
  const services = new Map<
    string,
    {
      dataDir: string;
      file: string;
      version: string;
      previous?: string;
      backend?: ReturnType<typeof Bun.spawn>;
      job: Record<string, unknown> | null;
      loaded: boolean;
      rollback?: unknown;
    }
  >();
  const hits = { packument: 1, tarball: 0 };
  let generation = 0;
  let staleSystemdUnit = false;
  const manager = options.manager ?? "systemd";
  const result = (
    json: Record<string, any> | null = null,
    code = 0,
    stdout = "",
    stderr = "",
  ): QualificationResult => ({ code, stdout, stderr, json });
  const publish = (service: typeof services extends Map<string, infer T> ? T : never) => {
    writeFileSync(
      path.join(service.dataDir, "backend-instance.json"),
      JSON.stringify({
        generation: String(++generation),
        appVersion: service.version,
        // A real live PID proves cleanup does not trust manager success alone.
        pid: options.backendSurvives ? process.pid : (service.backend?.pid ?? 2_000_000_000),
      }),
    );
  };
  const runtime: QualificationRuntime = {
    hostSignals: async () => [],
    sleep: async (_ms, signal) => {
      signal.throwIfAborted();
    },
    registry: async () => ({ hits, url: "http://127.0.0.1:1/", server: { stop() {} } }),
    run: async (argv, _timeout, signal) => {
      calls.push(argv);
      if (argv[0] === "ps") return result();
      if (argv.includes("list-units") || (argv[0] === "launchctl" && argv[1] === "list"))
        return result();
      if (argv.includes("service") && argv.includes("install")) {
        const dataDir = argv[argv.indexOf("--data-dir") + 1]!;
        roots.push(path.dirname(dataDir));
        const name = path.basename(dataDir);
        const file = path.join(root, `${name}.unit`);
        writeFileSync(
          file,
          manager === "systemd"
            ? `[Service]\n${options.missingAnchor ? "" : "Environment=NODE_ENV=production\n"}`
            : `<plist><dict>${options.missingAnchor ? "" : "<key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>"}</dict></plist>`,
        );
        services.set(name, {
          dataDir,
          file,
          version: argv[argv.indexOf("--release") + 1]!,
          loaded: false,
          job: null,
        });
        return result({ result: { unit: { name, file, manager } } });
      }
      if (argv.includes("start") || argv.includes("restart") || argv.includes("bootstrap")) {
        const service =
          Array.from(services.values()).find((entry) => argv.includes(entry.file)) ??
          services.get(argv.at(-1)!)!;
        const contents = readFileSync(service.file, "utf8");
        expect(contents).toContain(
          path.join(path.dirname(service.dataDir), `${path.basename(service.dataDir)}-home`),
        );
        expect(contents).toContain("BUN_INSTALL_CACHE_DIR");
        expect(contents).toContain(
          manager === "systemd"
            ? 'Environment="ORKESTRATOR_CONTROL_MCP_DISABLED=1"'
            : "<key>ORKESTRATOR_CONTROL_MCP_DISABLED</key>\n    <string>1</string>",
        );
        service.loaded = true;
        if (options.realBackend && !service.backend)
          service.backend = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
            stdout: "ignore",
            stderr: "ignore",
          });
        if (service.backend) children.add(service.backend);
        publish(service);
        if (options.interrupt && !options.interruptDuringApply) process.emit(options.interrupt);
        return result();
      }
      if (argv.includes("daemon-reload")) {
        staleSystemdUnit = false;
        return result(
          null,
          options.reloadFails && calls.some((call) => call.includes("disable")) ? 1 : 0,
        );
      }
      if (argv.includes("disable") || argv.includes("bootout")) {
        if (options.unloadFails) return result(null, 1, "", "unload denied");
        for (const service of services.values()) service.loaded = options.staysLoaded ?? false;
        return result();
      }
      if (argv.includes("show") || argv.includes("print")) {
        const loaded = Array.from(services.values()).some((service) => service.loaded);
        if (manager === "systemd")
          return result(
            null,
            0,
            loaded
              ? "LoadState=loaded\nActiveState=active\nMainPID=42\n"
              : staleSystemdUnit
                ? "LoadState=loaded\nActiveState=inactive\nMainPID=0\n"
                : "LoadState=not-found\nActiveState=inactive\nMainPID=0\n",
          );
        return result(null, loaded ? 0 : 113, "", loaded ? "" : "Could not find service");
      }
      if (argv.includes("connection") && argv.includes("add")) return result();
      if (argv.includes("uninstall")) {
        if (options.interrupt) process.emit(options.interrupt);
        expect(argv).not.toContain("--purge");
        if (options.uninstallFails) return result(null, 1);
        for (const service of services.values()) {
          rmSync(service.file, { force: true });
          staleSystemdUnit = manager === "systemd";
          service.loaded = options.staysLoaded ?? false;
          if (service.backend) {
            service.backend.kill();
            await service.backend.exited;
          }
        }
        return result();
      }
      signal.throwIfAborted();
      const service =
        services.get(argv[argv.indexOf("--connection") + 1] ?? "service") ??
        services.values().next().value!;
      if (argv.includes("host") && argv.includes("status"))
        return result({ result: { version: service.version, job: service.job } });
      if (argv.includes("service") && argv.includes("status"))
        return result({
          result: {
            current: service.version,
            previous: service.previous,
            lastReadyVersion: service.version,
            rollback: service.rollback,
          },
        });
      if (argv.includes("cancel")) {
        service.job = { state: "cancelled" };
        return result();
      }
      if (argv.includes("apply")) {
        if (options.interrupt && options.interruptDuringApply) {
          process.emit(options.interrupt);
          signal.throwIfAborted();
        }
        const target = argv[argv.indexOf("--release") + 1]!;
        if (target === "broken") {
          hits.tarball++;
          service.job = { state: "failed", targetVersion: target };
          service.rollback = { failedVersion: target, restoredVersion: service.version };
          publish(service);
          const logs = path.join(service.dataDir, "backend", "logs");
          mkdirSync(logs, { recursive: true });
          writeFileSync(
            path.join(logs, "service.log"),
            "deliberately broken release\ndeliberately broken release\n",
          );
          return result(null, 1);
        }
        if (target === "engines-to") {
          service.job = { state: "failed", error: "needs Bun 9" };
          return result(null, 1);
        }
        if (!argv.includes("--wait")) {
          service.job = { state: "awaiting-restart", restartAt: new Date(0).toISOString() };
          return result();
        }
        service.previous = service.version;
        service.version = target;
        service.job = { state: "succeeded", targetVersion: target, drain: "when-idle" };
        publish(service);
        return result();
      }
      throw new Error(`Unexpected fixture command ${argv.join(" ")}`);
    },
  };
  return {
    calls,
    services,
    readReport: () => JSON.parse(readFileSync(report, "utf8")),
    run: (phases: string) =>
      qualifyStandaloneService(
        [
          "--phases",
          phases,
          "--from",
          "from",
          "--to",
          "to",
          "--broken",
          "broken",
          "--engines-bun",
          process.execPath,
          "--engines-to",
          "engines-to",
          "--report",
          report,
        ],
        runtime,
      ),
  };
}

for (const phases of [
  "rollback",
  "cancel,rollback",
  "update,rollback",
  "cancel,update,rollback",
  "cancel",
  "update",
  "engines",
]) {
  test(`qualification dispatches ${phases} and checks the actual restored version`, async () => {
    const f = fixture();
    expect(await f.run(phases)).toBe(0);
    const report = f.readReport();
    expect(report.passed).toBe(true);
    for (const phase of phases.split(","))
      expect(report.checks.some((check: { phase: string }) => check.phase === phase)).toBe(true);
    if (phases.includes("rollback"))
      expect(
        report.checks.find((check: { name: string }) =>
          check.name.startsWith("the launcher restored"),
        ).detail.version,
      ).toBe(phases.includes("update") ? "to" : "from");
    expect(f.services.values().next().value!.loaded).toBe(false);
  });
}
for (const phases of ["updat", ",", "", "update,typo"]) {
  test(`invalid phases ${JSON.stringify(phases)} fail setup before installation`, async () => {
    const f = fixture();
    expect(await f.run(phases)).toBe(2);
    expect(f.calls).toEqual([]);
    expect(f.readReport().passed).toBe(false);
  });
}
for (const manager of ["systemd", "launchd"] as const) {
  test(`${manager} isolation requires every environment insertion before startup`, async () => {
    const f = fixture({ manager, missingAnchor: true });
    expect(await f.run("update")).toBe(2);
    expect(f.calls.some((argv) => argv.includes("start") || argv.includes("bootstrap"))).toBe(
      false,
    );
  });
  test(`${manager} successful fallback unload permits deletion`, async () => {
    const f = fixture({ manager, uninstallFails: true });
    expect(await f.run("update")).toBe(0);
    expect(f.readReport().remainingUnits).toEqual([]);
    expect(existsSync(f.services.values().next().value!.dataDir)).toBe(false);
  });
  test(`${manager} failed unload is retried and preserves unit tracking and state`, async () => {
    const f = fixture({ manager, uninstallFails: true, unloadFails: true });
    expect(await f.run("update")).toBe(1);
    const report = f.readReport();
    expect(report.remainingUnits).toHaveLength(1);
    expect(existsSync(report.remainingUnits[0].dataDir)).toBe(true);
    expect(existsSync(report.remainingUnits[0].file)).toBe(true);
    expect(f.calls.filter((argv) => argv.includes("uninstall"))).toHaveLength(2);
    expect(
      report.checks.some(
        (check: { phase: string; ok: boolean }) => check.phase === "cleanup" && !check.ok,
      ),
    ).toBe(true);
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const duringApply of [false, true]) {
    test(`${signal} ${duringApply ? "during apply" : "after unit startup"} unloads the unit and exits its backend`, async () => {
      const f = fixture({
        interrupt: signal,
        interruptDuringApply: duringApply,
        realBackend: true,
      });
      const listeners = process.listenerCount(signal);
      expect(await f.run("update")).toBe(signal === "SIGINT" ? 130 : 143);
      expect(f.readReport().passed).toBe(false);
      expect(f.readReport().remainingUnits).toEqual([]);
      expect(f.services.values().next().value!.loaded).toBe(false);
      expect(f.calls.filter((argv) => argv.includes("uninstall"))).toHaveLength(1);
      expect(f.calls.some((argv) => argv.includes("apply"))).toBe(duringApply);
      expect(() => process.kill(f.services.values().next().value!.backend!.pid, 0)).toThrow();
      expect(process.listenerCount(signal)).toBe(listeners);
    });
  }
}

test("cleanup retains state when daemon reload fails", async () => {
  const f = fixture({ uninstallFails: true, reloadFails: true });
  expect(await f.run("update")).toBe(1);
  expect(f.readReport().remainingUnits).toHaveLength(1);
  expect(existsSync(f.services.values().next().value!.dataDir)).toBe(true);
});

for (const failure of ["backendSurvives", "staysLoaded"] as const) {
  test(`${failure} after manager success preserves state for recovery`, async () => {
    const f = fixture({ [failure]: true });
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => (now += 20_000));
    try {
      expect(await f.run("update")).toBe(1);
      expect(f.readReport().remainingUnits).toHaveLength(1);
      expect(existsSync(f.services.values().next().value!.dataDir)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
}

test("the executable rejects invalid phases with setup exit status 2", async () => {
  const child = Bun.spawn(
    [process.execPath, "scripts/qualify-standalone-service.ts", "--phases", ","],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(2);
  expect(stderr).toContain("--phases must be a nonempty subset");
});

test("interruption with failed unload retains diagnostic state and the service for recovery", async () => {
  const f = fixture({ interrupt: "SIGTERM", uninstallFails: true, unloadFails: true });
  expect(await f.run("update")).toBe(143);
  const report = f.readReport();
  expect(report.passed).toBe(false);
  expect(report.remainingUnits).toHaveLength(1);
  expect(existsSync(report.retainedDirectory)).toBe(true);
  expect(existsSync(report.remainingUnits[0].dataDir)).toBe(true);
});
