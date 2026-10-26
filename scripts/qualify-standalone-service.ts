#!/usr/bin/env bun
/**
 * 0033 qualification: the standalone service between published releases.
 *
 * RUN THIS ONLY IN A DISPOSABLE VM, CONTAINER OR USER ACCOUNT. It installs real
 * launchd/systemd user units into the account that runs it. On 2026-10-26 an
 * earlier version, run beside a live desktop install, took that install's
 * Control MCP port and coincided with its backend exiting (todo 0244). It now
 * refuses to start when it finds an Orkestrator on the host (a live default
 * data directory, a backend or launcher process, an `orkestrator-backend` unit,
 * or a listener on 34121/34122); `--allow-shared-host` overrides that and is
 * never appropriate on a machine someone works on.
 *
 *   mise run build:cli
 *   bun scripts/qualify-standalone-service.ts [options]
 *
 *   --from <version>         release the service is installed with (default 2.30.0-beta)
 *   --to <version>           published release it updates itself to (default 2.31.0-beta)
 *   --broken <version>       version of the deliberately broken release a private
 *                            registry serves (default <to>.990; <to> must be a prerelease)
 *   --engines-bun <path>     a Bun older than <engines-to>'s `engines.bun`; enables the
 *                            engines phase
 *   --engines-from <version> release that Bun installs (default 2.29.0-beta, >=1.4.3)
 *   --engines-to <version>   release whose `engines.bun` it does not meet
 *                            (default 2.30.0-beta, >=1.4.4)
 *   --phases <list>          comma-separated subset of cancel,update,rollback,engines
 *   --report <file>          write the evidence as JSON
 *   --keep                   leave the temporary directory (the units are always removed)
 *   --allow-shared-host      run even though another Orkestrator was found (see above)
 *
 * Every service is real: `bun x orkestrator@<from> service install` from npm
 * writes and loads a launchd LaunchAgent (macOS) or systemd user unit (Linux)
 * for a private data directory under the temporary directory, so its unit name
 * carries that directory's digest. The unit is written with `--skip-start`
 * and given its own environment before its first boot: a private HOME, a
 * private Bun install cache, and `ORKESTRATOR_CONTROL_MCP_DISABLED=1`, so it
 * never binds the default Control MCP port. The backend binds loopback on a
 * free port (`--allow-non-tailscale-bind`), runs agent-test flavoured (it never
 * refreshes agent logins), and its config enables only Cursor, so the
 * toolchain the launcher installs is `gh` alone. The client is this
 * checkout's CLI with a private config directory, so no connection is saved
 * for the user.
 *
 * Phases:
 * - cancel: `host update apply --release <to>` without waiting, cancelled once
 *   the job reaches `awaiting-restart`. The backend must not restart.
 * - update: `host update apply --release <to> --when-idle --wait`. The idle
 *   host goes straight to the countdown, restarts into <to>, and the job settles
 *   `succeeded`; `current` and `previous` move.
 * - rollback: the unit's environment points Bun at a registry served by this
 *   script. It proxies npm and adds <broken>: the <to> tarball with its version
 *   changed and `serve` made to exit at once (`--version` and `toolchain
 *   install` still work, so the update reaches the restart). The launcher must
 *   boot it twice, restore the release serving before this phase, and the job
 *   must settle `failed` with the rollback as its reason.
 * - engines: a second service, installed by `--engines-bun`, must refuse
 *   <engines-to> before any restart.
 *
 * Only the units this run installed are touched: each is removed with
 * `service uninstall`, falling back to the service manager. State is deleted
 * only after the unit and backend have stopped; cleanup failures retain it.
 * Exits 0 when every check held, 1 when one did not, 2 on setup errors.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(ROOT, "packages", "cli", "bin", "orkestrator.js");
const NPM = "https://registry.npmjs.org";

export class SetupError extends Error {}

export interface QualificationResult {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, any> | null;
}

/** External boundaries, also used by disposable service-manager fixtures. */
export interface QualificationRuntime {
  run?: (argv: string[], timeoutMs: number, signal: AbortSignal) => Promise<QualificationResult>;
  registry?: () => Promise<{
    server: { stop: (force: boolean) => void | Promise<void> };
    hits: { packument: number; tarball: number };
    url: string;
  }>;
  hostSignals?: () => Promise<string[]>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function qualifyStandaloneService(
  args = process.argv.slice(2),
  runtime: QualificationRuntime = {},
): Promise<number> {
  const interruption = new AbortController();
  let interrupted: NodeJS.Signals | null = null;
  let cleaning = false;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    interruption.abort(new Error(`Interrupted by ${signal}`));
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    function option(name: string, fallback: string): string {
      const index = args.indexOf(name);
      return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
    }

    const FROM = option("--from", "2.30.0-beta");
    const TO = option("--to", "2.31.0-beta");
    const BROKEN = option("--broken", TO.includes("-") ? `${TO}.990` : "");
    const ENGINES_BUN = option("--engines-bun", "");
    const ENGINES_FROM = option("--engines-from", "2.29.0-beta");
    const ENGINES_TO = option("--engines-to", "2.30.0-beta");
    const PHASES = new Set(
      option("--phases", `cancel,update,rollback${ENGINES_BUN ? ",engines" : ""}`).split(","),
    );
    const REPORT = option("--report", "");
    const KEEP = args.includes("--keep");
    const ALLOW_SHARED_HOST = args.includes("--allow-shared-host");
    const BUN = process.execPath;

    type Check = { phase: string; name: string; ok: boolean; detail?: unknown };
    const checks: Check[] = [];
    const log = (text: string) => console.error(`[qualify] ${new Date().toISOString()} ${text}`);

    function check(phase: string, name: string, ok: boolean, detail?: unknown): boolean {
      checks.push({ phase, name, ok, ...(detail === undefined ? {} : { detail }) });
      log(
        `${ok ? "PASS" : "FAIL"} ${phase}: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
      );
      return ok;
    }

    const sleep = async (ms: number) => {
      interruption.signal.throwIfAborted();
      if (runtime.sleep) return runtime.sleep(ms, interruption.signal);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(interruption.signal.reason);
        };
        const timer = setTimeout(() => {
          interruption.signal.removeEventListener("abort", abort);
          resolve();
        }, ms);
        interruption.signal.addEventListener("abort", abort, { once: true });
      });
    };

    const temporary = mkdtempSync(path.join(os.tmpdir(), "ork-qualify-service-"));
    const cliConfig = path.join(temporary, "cli-config");
    const baseEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      BUN_INSTALL_CACHE_DIR: path.join(temporary, "bun-cache"),
      ORKESTRATOR_CLI_CONFIG_DIR: cliConfig,
    };

    async function run(argv: string[], timeoutMs = 20 * 60_000): Promise<QualificationResult> {
      if (!cleaning && !(argv.includes("install") && argv.includes("service")))
        interruption.signal.throwIfAborted();
      // Let installation finish publishing its unit identity before interruption.
      // Cleanup commands use a fresh signal so repeated signals cannot cancel unload.
      const protectedCommand = cleaning || (argv.includes("install") && argv.includes("service"));
      const signal = protectedCommand ? new AbortController().signal : interruption.signal;
      if (runtime.run) return runtime.run(argv, timeoutMs, signal);
      const child = Bun.spawn(argv, {
        env: baseEnv,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      return { code, stdout, stderr, json };
    }

    /** This checkout's client, on the private config directory. */
    const ork = (args: string[], timeoutMs?: number) => run([BUN, CLI, ...args], timeoutMs);

    async function freePort(): Promise<number> {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = server.port!;
      await server.stop(true);
      return port;
    }

    /** The default data directory of a desktop or service install for this user. */
    function defaultDataDir(): string {
      if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "orkestrator-v2");
      }
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
        "orkestrator-v2",
      );
    }

    function pidAlive(pid: unknown): boolean {
      if (typeof pid !== "number" || pid <= 1) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }

    async function listening(port: number): Promise<boolean> {
      try {
        const socket = await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            data() {},
            open(handle) {
              handle.end();
            },
          },
        });
        socket.end();
        return true;
      } catch {
        return false;
      }
    }

    /** Read-only signs that an Orkestrator already runs for this user on this host. */
    async function liveInstanceSignals(): Promise<string[]> {
      const signals: string[] = [];
      try {
        const instance = JSON.parse(
          readFileSync(path.join(defaultDataDir(), "backend-instance.json"), "utf8"),
        ) as { pid?: unknown };
        if (pidAlive(instance.pid))
          signals.push(`a backend serves ${defaultDataDir()} (pid ${instance.pid})`);
      } catch {
        // No descriptor: nothing published there.
      }
      for (const port of [34121, 34122]) {
        if (await listening(port)) signals.push(`something listens on 127.0.0.1:${port}`);
      }
      const ps = await run(["ps", "-eo", "pid=,args="], 30_000);
      for (const line of ps.stdout.split("\n")) {
        if (
          /orkestrator/i.test(line) &&
          /backend\/main\.js|launcher\.js|\.mount_orkest|Orkestrator\.app|orkestrator(-v2)?\.appimage/i.test(
            line,
          )
        ) {
          signals.push(`process ${line.trim().slice(0, 160)}`);
        }
      }
      const units =
        process.platform === "darwin"
          ? await run(["launchctl", "list"], 30_000)
          : await run(
              ["systemctl", "--user", "list-units", "--all", "--no-legend", "orkestrator-backend*"],
              30_000,
            );
      for (const line of units.stdout.split("\n")) {
        if (/orkestrator-backend|ai\.orkestrator\.backend/.test(line))
          signals.push(`unit ${line.trim().slice(0, 160)}`);
      }
      return signals;
    }

    interface Service {
      name: string;
      dataDir: string;
      unitName: string;
      unitFile: string;
      manager: "systemd" | "launchd";
      connection: string;
    }
    const installed: Service[] = [];

    function descriptor(
      service: Service,
    ): { generation: string; pid: number; appVersion: string } | null {
      try {
        return JSON.parse(
          readFileSync(path.join(service.dataDir, "backend-instance.json"), "utf8"),
        );
      } catch {
        return null;
      }
    }

    async function waitFor<T>(
      what: string,
      read: () => Promise<T | null> | T | null,
      timeoutMs: number,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        interruption.signal.throwIfAborted();
        const value = await read();
        if (value !== null) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(2_000);
      }
    }

    async function hostStatus(service: Service): Promise<Record<string, any> | null> {
      const result = await ork(
        ["--connection", service.connection, "host", "status", "--json"],
        60_000,
      );
      return result.code === 0 ? (result.json?.result ?? null) : null;
    }

    async function serviceStatus(service: Service): Promise<Record<string, any>> {
      const result = await ork(["service", "status", "--data-dir", service.dataDir, "--json"]);
      if (result.code !== 0)
        throw new Error(`service status failed: ${result.stderr.slice(0, 300)}`);
      return result.json!.result;
    }

    /** Waits for a backend generation other than `previous` serving `version`. */
    async function waitReady(service: Service, version: string, previous: string | null) {
      return waitFor(
        `${service.name} to serve ${version}`,
        async () => {
          const current = descriptor(service);
          if (!current || current.generation === previous || current.appVersion !== version)
            return null;
          const host = await hostStatus(service);
          return host?.version === version ? current : null;
        },
        6 * 60_000,
      );
    }

    async function install(name: string, bun: string, version: string): Promise<Service> {
      const dataDir = path.join(temporary, name);
      mkdirSync(dataDir, { recursive: true });
      // Only Cursor, which ships no binary: the launcher's toolchain install is gh alone.
      writeFileSync(
        path.join(dataDir, "config.json"),
        `${JSON.stringify({ global: { enabledAgentPlatforms: ["cursor"] } }, null, 2)}\n`,
      );
      const port = await freePort();
      log(`installing ${name}: orkestrator@${version} from npm with ${bun}`);
      const result = await run([
        bun,
        "x",
        `orkestrator@${version}`,
        "service",
        "install",
        "--data-dir",
        dataDir,
        "--release",
        version,
        "--yes",
        // The unit gets its private environment before its first boot.
        "--skip-start",
        "--json",
        "--",
        "--host",
        "127.0.0.1",
        // Loopback is not a Tailscale address; the gateway refuses it unless told.
        "--allow-non-tailscale-bind",
        "--port",
        String(port),
        "--runtime-flavor",
        "agent-test",
      ]);
      const unit = result.json?.result?.unit;
      if (unit?.file) {
        installed.push({
          name,
          dataDir,
          unitName: unit.name,
          unitFile: unit.file,
          manager: unit.manager,
          connection: name,
        });
      }
      const service = installed.at(-1);
      if (result.code !== 0 || !service || service.name !== name) {
        throw new SetupError(
          `service install failed (${result.code}): ${result.stderr.slice(-600)}`,
        );
      }
      interruption.signal.throwIfAborted();
      const added = await ork([
        "connection",
        "add",
        name,
        "--data-dir",
        dataDir,
        "--no-check",
        "--json",
      ]);
      if (added.code !== 0)
        throw new SetupError(`connection add failed: ${added.stderr.slice(-300)}`);
      const home = path.join(temporary, `${name}-home`);
      mkdirSync(home, { recursive: true });
      writeUnitEnvironment(service, {
        HOME: home,
        BUN_INSTALL_CACHE_DIR: path.join(temporary, `${name}-bun-cache`),
        ORKESTRATOR_CONTROL_MCP_DISABLED: "1",
      });
      await loadUnit(service, false);
      const ready = await waitReady(service, version, null).catch(() => null);
      if (
        !check(name, `service install of ${version} from npm starts and serves`, ready !== null, {
          unit: unit.name,
          manager: unit.manager,
        })
      ) {
        throw new Error(
          `${name} did not start; see ${path.join(dataDir, "backend", "logs", "service.log")}`,
        );
      }
      return service;
    }

    /** Sets (or replaces) environment variables in this run's own unit file. */
    function writeUnitEnvironment(service: Service, values: Record<string, string>) {
      let contents = readFileSync(service.unitFile, "utf8");
      for (const [key, value] of Object.entries(values)) {
        if (service.manager === "systemd") {
          contents = contents.replace(new RegExp(`^Environment="${key}=[^\\n]*\\n`, "m"), "");
          contents = contents.replace(
            "Environment=NODE_ENV=production\n",
            `$&Environment="${key}=${value}"\n`,
          );
        } else {
          contents = contents.replace(
            new RegExp(`\\n    <key>${key}</key>\\n    <string>[^<]*</string>`),
            "",
          );
          contents = contents.replace(
            /(<key>EnvironmentVariables<\/key>\s*<dict>)/,
            `$1\n    <key>${key}</key>\n    <string>${value}</string>`,
          );
        }
      }
      for (const [key, value] of Object.entries(values)) {
        const expected =
          service.manager === "systemd"
            ? `Environment="${key}=${value}"`
            : `<key>${key}</key>\n    <string>${value}</string>`;
        if (!contents.includes(expected)) {
          throw new SetupError(
            `Unit isolation variable ${key} was not written to ${service.unitFile}`,
          );
        }
      }
      writeFileSync(service.unitFile, contents);
      if (readFileSync(service.unitFile, "utf8") !== contents) {
        throw new SetupError(`Could not verify unit environment in ${service.unitFile}`);
      }
    }

    /** Loads this run's own unit, or restarts it with its current file. */
    async function loadUnit(service: Service, restart: boolean) {
      interruption.signal.throwIfAborted();
      const domain = `gui/${process.getuid?.() ?? 0}`;
      const steps =
        service.manager === "systemd"
          ? [
              ["systemctl", "--user", "daemon-reload"],
              ["systemctl", "--user", restart ? "restart" : "start", service.unitName],
            ]
          : [
              ...(restart ? [["launchctl", "bootout", `${domain}/${service.unitName}`]] : []),
              ["launchctl", "bootstrap", domain, service.unitFile],
            ];
      for (const argv of steps) {
        interruption.signal.throwIfAborted();
        const result = await run(argv, 60_000);
        if (result.code !== 0 && argv[1] !== "bootout") {
          throw new SetupError(`${argv.join(" ")}: ${result.stderr}`);
        }
      }
    }

    /** Adds environment variables to this run's own unit and restarts it. */
    async function setUnitEnvironment(service: Service, values: Record<string, string>) {
      const before = descriptor(service)?.generation ?? null;
      const version = descriptor(service)?.appVersion ?? "";
      writeUnitEnvironment(service, values);
      await loadUnit(service, true);
      await waitReady(service, version, before);
    }

    async function apply(service: Service, version: string, extra: string[] = []) {
      return ork(
        [
          "--connection",
          service.connection,
          "host",
          "update",
          "apply",
          "--yes",
          "--release",
          version,
          ...extra,
          "--json",
        ],
        25 * 60_000,
      );
    }

    async function phaseCancel(service: Service) {
      const before = descriptor(service)!;
      const started = await apply(service, TO);
      check("cancel", "apply is accepted", started.code === 0, started.json?.receipt?.state);
      const states = new Set<string>();
      const countdown = await waitFor(
        "the countdown",
        async () => {
          const job = (await hostStatus(service))?.job;
          if (job?.state) states.add(job.state);
          if (job?.state === "failed") throw new Error(`update failed: ${job.error}`);
          return job?.state === "awaiting-restart" ? job : null;
        },
        20 * 60_000,
      );
      check(
        "cancel",
        "the job reaches awaiting-restart with a restartAt",
        Boolean(countdown.restartAt),
        {
          states: [...states],
          targetVersion: countdown.targetVersion,
        },
      );
      const cancelled = await ork([
        "--connection",
        service.connection,
        "host",
        "update",
        "cancel",
        "--json",
      ]);
      check(
        "cancel",
        "cancel during the countdown succeeds",
        cancelled.code === 0,
        cancelled.json?.result,
      );
      // Past the moment it would have restarted.
      await sleep(Math.max(0, Date.parse(countdown.restartAt) - Date.now()) + 15_000);
      const host = await hostStatus(service);
      const after = descriptor(service);
      check(
        "cancel",
        "the job stays cancelled and the backend did not restart",
        host?.job?.state === "cancelled" &&
          after?.generation === before.generation &&
          host?.version === FROM,
        {
          job: host?.job?.state,
          version: host?.version,
          sameGeneration: after?.generation === before.generation,
        },
      );
      const status = await serviceStatus(service);
      check("cancel", "current still points at the old release", status.current === FROM, {
        current: status.current,
      });
    }

    async function phaseUpdate(service: Service) {
      const before = descriptor(service)!;
      const result = await apply(service, TO, [
        "--when-idle",
        "--max-wait",
        "2m",
        "--wait",
        "--timeout",
        "20m",
      ]);
      check("update", "apply --when-idle --wait exits 0", result.code === 0, {
        code: result.code,
        receipt: result.json?.receipt?.state,
        stage: result.json?.receipt?.stage,
        error: result.json?.error?.message,
      });
      const after = await waitReady(service, TO, before.generation);
      const host = await hostStatus(service);
      check(
        "update",
        `the backend restarted into ${TO} and the job settled succeeded`,
        host?.job?.state === "succeeded" &&
          host?.job?.targetVersion === TO &&
          host?.job?.drain === "when-idle",
        {
          job: host?.job?.state,
          from: host?.job?.fromVersion,
          to: host?.job?.targetVersion,
          pidChanged: after.pid !== before.pid,
        },
      );
      const status = await serviceStatus(service);
      check(
        "update",
        "current and previous moved",
        status.current === TO && status.previous === FROM && status.lastReadyVersion === TO,
        {
          current: status.current,
          previous: status.previous,
          lastReady: status.lastReadyVersion,
        },
      );
    }

    async function brokenTarball(): Promise<{
      bytes: Uint8Array<ArrayBuffer>;
      integrity: string;
      shasum: string;
    }> {
      const work = path.join(temporary, "broken");
      mkdirSync(work, { recursive: true });
      const archive = path.join(work, "source.tgz");
      const response = await fetch(`${NPM}/orkestrator/-/orkestrator-${TO}.tgz`, {
        signal: interruption.signal,
      });
      if (!response.ok) throw new SetupError(`could not download orkestrator@${TO}`);
      writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
      const unpack = await run(["tar", "xzf", archive, "-C", work], 120_000);
      if (unpack.code !== 0) throw new SetupError(`tar: ${unpack.stderr}`);
      const manifestFile = path.join(work, "package", "package.json");
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      manifest.version = BROKEN;
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      const entryFile = path.join(work, "package", "bin", "orkestrator.js");
      const entry = readFileSync(entryFile, "utf8");
      const serve = 'await import("../dist/main.js");';
      if (!entry.includes(serve))
        throw new SetupError(`${TO}'s entry has no serve import to break`);
      writeFileSync(
        entryFile,
        entry.replace(
          serve,
          'console.error("[qualification] deliberately broken release: serve exits"); process.exit(70);',
        ),
      );
      const output = path.join(work, "broken.tgz");
      const pack = await run(["tar", "czf", output, "-C", work, "package"], 120_000);
      if (pack.code !== 0) throw new SetupError(`tar: ${pack.stderr}`);
      const bytes = new Uint8Array(readFileSync(output)) as Uint8Array<ArrayBuffer>;
      return {
        bytes,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        shasum: createHash("sha1").update(bytes).digest("hex"),
      };
    }

    /** npm, plus <broken> for `orkestrator`. */
    async function startRegistry() {
      const tarball = await brokenTarball();
      const hits = { packument: 0, tarball: 0 };
      const tarballPath = `/-/qualification/orkestrator-${BROKEN}.tgz`;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === tarballPath) {
            hits.tarball += 1;
            return new Response(tarball.bytes, {
              headers: { "content-type": "application/octet-stream" },
            });
          }
          const upstream = await fetch(`${NPM}${url.pathname}${url.search}`, {
            headers: { accept: request.headers.get("accept") ?? "application/json" },
          });
          const type = upstream.headers.get("content-type") ?? "application/json";
          if (url.pathname !== "/orkestrator" || !upstream.ok) {
            return new Response(upstream.body, {
              status: upstream.status,
              headers: { "content-type": type },
            });
          }
          hits.packument += 1;
          const document = (await upstream.json()) as {
            versions: Record<string, any>;
            "dist-tags": Record<string, string>;
            time?: Record<string, string>;
          };
          const base = document.versions[TO];
          if (!base) return Response.json(document);
          document.versions[BROKEN] = {
            ...base,
            version: BROKEN,
            dist: {
              tarball: `${url.origin}${tarballPath}`,
              integrity: tarball.integrity,
              shasum: tarball.shasum,
            },
          };
          if (document.time) document.time[BROKEN] = new Date().toISOString();
          return Response.json(document);
        },
      });
      return { server, hits, url: `http://127.0.0.1:${server.port}/` };
    }

    async function phaseRollback(service: Service) {
      if (!BROKEN) throw new SetupError("--broken is required when --to is a stable release");
      const registry = await (runtime.registry ?? startRegistry)();
      try {
        await setUnitEnvironment(service, {
          BUN_INSTALL_CACHE_DIR: path.join(temporary, "service-bun-cache-rollback"),
          BUN_CONFIG_REGISTRY: registry.url,
          NPM_CONFIG_REGISTRY: registry.url,
        });
        const before = descriptor(service)!;
        const result = await apply(service, BROKEN, ["--wait", "--timeout", "20m"]);
        check("rollback", "apply of the broken release exits non-zero", result.code !== 0, {
          code: result.code,
          receipt: result.json?.receipt?.state,
          error: result.json?.error?.message ?? result.json?.failure,
        });
        check(
          "rollback",
          "the private registry served the broken tarball",
          registry.hits.tarball > 0,
          registry.hits,
        );
        const restoredVersion = before.appVersion;
        const after = await waitReady(service, restoredVersion, before.generation).catch(
          () => null,
        );
        const host = await hostStatus(service);
        check(
          "rollback",
          `the launcher restored ${restoredVersion} and the job failed with the rollback`,
          after !== null &&
            host?.version === restoredVersion &&
            host?.job?.state === "failed" &&
            host?.job?.targetVersion === BROKEN,
          {
            version: host?.version,
            job: host?.job?.state,
            error: host?.job?.error,
            restarted: after !== null,
          },
        );
        const status = await serviceStatus(service);
        check(
          "rollback",
          "launcher-state records the rollback",
          status.rollback?.failedVersion === BROKEN &&
            status.rollback?.restoredVersion === restoredVersion &&
            status.current === restoredVersion,
          {
            current: status.current,
            rollback: status.rollback,
          },
        );
        const logFile = path.join(service.dataDir, "backend", "logs", "service.log");
        const logText = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
        check(
          "rollback",
          "the broken release booted twice",
          (logText.match(/deliberately broken release/g) ?? []).length >= 2,
          {
            brokenBoots: (logText.match(/deliberately broken release/g) ?? []).length,
          },
        );
      } finally {
        await registry.server.stop(true);
      }
    }

    async function phaseEngines() {
      const service = await install("engines", ENGINES_BUN, ENGINES_FROM);
      const before = descriptor(service)!;
      const result = await apply(service, ENGINES_TO, ["--wait", "--timeout", "20m"]);
      const host = await hostStatus(service);
      check(
        "engines",
        `${ENGINES_TO} is refused before any restart`,
        result.code !== 0 &&
          host?.job?.state === "failed" &&
          /needs Bun/.test(host?.job?.error ?? "") &&
          descriptor(service)?.generation === before.generation,
        {
          code: result.code,
          job: host?.job?.state,
          error: host?.job?.error,
          version: host?.version,
        },
      );
      await uninstall(service);
    }

    /** Prove the manager released the unit, and its last backend has exited. */
    async function unitStopped(service: Service, backendPid: number | undefined): Promise<boolean> {
      const result =
        service.manager === "systemd"
          ? await run(
              [
                "systemctl",
                "--user",
                "show",
                service.unitName,
                "--property=LoadState,ActiveState,MainPID",
              ],
              60_000,
            )
          : await run(
              ["launchctl", "print", `gui/${process.getuid?.() ?? 0}/${service.unitName}`],
              60_000,
            );
      const unloaded =
        service.manager === "systemd"
          ? (result.code === 0 || result.code === 4) &&
            /^LoadState=not-found$/m.test(result.stdout) &&
            /^ActiveState=inactive$/m.test(result.stdout) &&
            /^MainPID=0$/m.test(result.stdout)
          : result.code !== 0 && /could not find service|service not found/i.test(result.stderr);
      return unloaded && !pidAlive(backendPid) && !pidAlive(descriptor(service)?.pid);
    }

    async function uninstall(service: Service) {
      if (!installed.includes(service)) return;
      const backendPid = descriptor(service)?.pid;
      // Never purge through the CLI: its best-effort unload can report success
      // despite a manager error. Keep releases until independent verification.
      const result = await ork(["service", "uninstall", "--data-dir", service.dataDir, "--json"]);
      // The CLI reloads before unlinking the unit. Reload once more afterwards
      // so an inactive cached systemd unit can become not-found.
      if (result.code === 0 && service.manager === "systemd" && !existsSync(service.unitFile)) {
        const reloaded = await run(["systemctl", "--user", "daemon-reload"], 60_000);
        if (reloaded.code !== 0)
          throw new Error(`Could not reload service manager: ${reloaded.stderr}`);
      }
      if (
        result.code !== 0 ||
        existsSync(service.unitFile) ||
        !(await unitStopped(service, backendPid))
      ) {
        log(
          `service uninstall failed for ${service.unitName}; removing it through the service manager`,
        );
        const argv =
          service.manager === "systemd"
            ? ["systemctl", "--user", "disable", "--now", service.unitName]
            : ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/${service.unitName}`];
        const stopped = await run(argv, 60_000);
        if (stopped.code !== 0)
          throw new Error(`Could not unload ${service.unitName}: ${stopped.stderr}`);
        rmSync(service.unitFile, { force: true });
        if (service.manager === "systemd") {
          const reloaded = await run(["systemctl", "--user", "daemon-reload"], 60_000);
          if (reloaded.code !== 0)
            throw new Error(`Could not reload service manager: ${reloaded.stderr}`);
        }
      }
      // Stop may return before a child has exited. Give it a bounded grace period,
      // keeping the service tracked and all state intact if verification fails.
      const deadline = Date.now() + 10_000;
      while (!(await unitStopped(service, backendPid))) {
        if (Date.now() >= deadline)
          throw new Error(`${service.unitName} or its backend is still running`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (existsSync(service.unitFile)) throw new Error(`${service.unitFile} still exists`);
      check("cleanup", `${service.unitName} removed and backend stopped`, true);
      installed.splice(installed.indexOf(service), 1);
    }

    // Both normal completion and signal interruption converge here exactly once.
    let shutdownPromise: Promise<void> | undefined;
    function shutdown(): Promise<void> {
      return (shutdownPromise ??= (async () => {
        cleaning = true;
        for (const service of Array.from(installed)) {
          try {
            await uninstall(service);
          } catch (error) {
            status = status || 1;
            check(
              "cleanup",
              `${service.unitName} removed and backend stopped`,
              false,
              String(error),
            );
          }
        }
      })());
    }

    let status = 0;
    const startedAt = new Date().toISOString();
    try {
      const allowedPhases = new Set(["cancel", "update", "rollback", "engines"]);
      if (PHASES.size === 0 || Array.from(PHASES).some((phase) => !allowedPhases.has(phase))) {
        throw new SetupError(
          "--phases must be a nonempty subset of cancel,update,rollback,engines",
        );
      }
      if (!runtime.run && !existsSync(path.join(ROOT, "packages", "cli", "dist"))) {
        throw new SetupError("Build the client first: mise run build:cli");
      }
      const signals = await (runtime.hostSignals ?? liveInstanceSignals)();
      if (signals.length > 0) {
        const text = `Another Orkestrator runs on this host:\n  ${signals.join("\n  ")}`;
        if (!ALLOW_SHARED_HOST) {
          throw new SetupError(
            `${text}\nRun this qualification in a disposable VM, container or user account.`,
          );
        }
        log(`WARNING: ${text}\nContinuing because --allow-shared-host was given.`);
      }
      if (PHASES.has("cancel") || PHASES.has("update") || PHASES.has("rollback")) {
        const service = await install("service", BUN, FROM);
        if (PHASES.has("cancel")) await phaseCancel(service);
        if (PHASES.has("update")) await phaseUpdate(service);
        if (PHASES.has("rollback")) await phaseRollback(service);
        await uninstall(service);
      }
      if (PHASES.has("engines")) {
        if (!ENGINES_BUN) throw new SetupError("--engines-bun is required for the engines phase");
        await phaseEngines();
      }
      interruption.signal.throwIfAborted();
      status = checks.length > 0 && checks.every((entry) => entry.ok) ? 0 : 1;
    } catch (error) {
      status = error instanceof SetupError ? 2 : 1;
      log(`stopped: ${error instanceof Error ? error.message : String(error)}`);
      checks.push({ phase: "run", name: "completed", ok: false, detail: String(error) });
    } finally {
      await shutdown();
      if (interrupted) status = interrupted === "SIGINT" ? 130 : 143;
      const report = {
        startedAt,
        finishedAt: new Date().toISOString(),
        platform: `${process.platform}-${process.arch}`,
        os: os.release(),
        bun: Bun.version,
        from: FROM,
        to: TO,
        broken: BROKEN,
        engines: ENGINES_BUN ? { bun: ENGINES_BUN, from: ENGINES_FROM, to: ENGINES_TO } : null,
        retainedDirectory: KEEP || installed.length > 0 ? temporary : null,
        remainingUnits: installed.map((service) => ({
          unit: service.unitName,
          file: service.unitFile,
          dataDir: service.dataDir,
        })),
        checks,
        passed: status === 0,
      };
      const reportFile =
        REPORT || (installed.length > 0 ? path.join(temporary, "qualification-report.json") : "");
      if (reportFile) writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
      if (!KEEP && installed.length === 0) rmSync(temporary, { recursive: true, force: true });
      else
        log(
          `kept ${temporary}${installed.length ? "; cleanup failed, recover the recorded units before deleting state" : ""}`,
        );
      log(status === 0 ? "every check passed" : `finished with status ${status}`);
    }
    return status;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (import.meta.main) process.exit(await qualifyStandaloneService());
