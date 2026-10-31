/**
 * The supervisor's circuit breaker against real processes and the **real**
 * pinned `codex app-server` binary, in place of the fake child in
 * `process-supervisor.test.ts`.
 *
 * `codexPath` points at a wrapper script. It records each spawn and then fails
 * the way a broken install does (exits at once, or never answers `initialize`),
 * until the test "fixes the install" and it execs the real binary. Only the
 * cooldowns are shortened; spawn, exit, `initialize`, termination and the pidfile
 * are the production paths. `initialize` is the only request it makes, in a
 * throwaway `CODEX_HOME`, so it needs no login and calls no model. Gated like the
 * other live contract tests because it needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-circuit-breaker.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerCircuitOpenError, AppServerUnavailableError } from "./errors.js";
import { pinnedVersion, resolveCodexBinary } from "./live-binary.js";
import {
  AppServerSupervisor,
  parseVersionFromUserAgent,
  type AppServerSupervisorOptions,
} from "./process-supervisor.js";

const LIVE = process.env.RUN_LIVE_CODEX_APP_SERVER === "1";
const describeLive = LIVE ? describe : describe.skip;

type WrapperMode = "exit" | "hang" | "real";

interface Install {
  root: string;
  wrapper: string;
  codexHome: string;
  supervisor: AppServerSupervisor;
  setMode(mode: WrapperMode): void;
  /** One entry per process the supervisor actually started. */
  spawns(): Array<{ pid: number; mode: WrapperMode }>;
}

const installs: Install[] = [];

async function brokenInstall(
  mode: WrapperMode,
  options: Partial<AppServerSupervisorOptions>,
): Promise<Install> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-breaker-live-")));
  const wrapper = join(root, "codex");
  const modeFile = join(root, "mode");
  const spawnLog = join(root, "spawns");
  const realBinary = await resolveCodexBinary();
  writeFileSync(modeFile, mode);
  writeFileSync(
    wrapper,
    `#!/bin/sh
mode=$(cat '${modeFile}')
echo "$$ $mode" >> '${spawnLog}'
case "$mode" in
  exit) echo 'simulated broken install' >&2; exit 7 ;;
  hang) exec sleep 600 ;;
esac
exec '${realBinary}' "$@"
`,
  );
  chmodSync(wrapper, 0o755);
  const codexHome = join(root, "home");
  const supervisor = new AppServerSupervisor({
    codexPath: wrapper,
    cwd: root,
    clientInfo: { name: "orkestrator", title: "Orkestrator", version: "2.4.9" },
    codexHome,
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    refreshEnvironment: async () => undefined,
    backoffScheduleMs: [10, 20],
    ...options,
  });
  const install: Install = {
    root,
    wrapper,
    codexHome,
    supervisor,
    setMode: (next) => writeFileSync(modeFile, next),
    spawns: () => {
      let log = "";
      try {
        log = readFileSync(spawnLog, "utf8");
      } catch {
        return [];
      }
      return log
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [pid, spawned] = line.split(" ");
          return { pid: Number(pid), mode: spawned as WrapperMode };
        });
    },
  };
  installs.push(install);
  return install;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fails if the supervisor left any process it started running. */
function expectNoSurvivors(install: Install, except: readonly number[] = []): void {
  const survivors = install
    .spawns()
    .map((spawned) => spawned.pid)
    .filter((pid) => !except.includes(pid) && isRunning(pid));
  expect(survivors).toEqual([]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const install of installs.splice(0)) {
    await install.supervisor.stop();
    rmSync(install.root, { recursive: true, force: true });
  }
});

describeLive("codex circuit breaker with a real binary", () => {
  test("a binary that exits at once opens the breaker, and a fixed install closes it through one probe", async () => {
    const install = await brokenInstall("exit", {
      circuitBreakerThreshold: 3,
      circuitCooldownMs: 1_500,
      circuitMaxCooldownMs: 6_000,
    });
    const { supervisor } = install;

    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(AppServerCircuitOpenError);
    const openedAt = Date.now();
    expect(install.spawns()).toHaveLength(3);
    expect(supervisor.getState()).toBe("failed");
    expect(supervisor.getHealth().circuitOpen).toBe(true);
    expect(supervisor.getHealth().lastExitCode).toBe(7);
    expectNoSurvivors(install);

    // Demand during the cooldown is refused without starting anything.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(AppServerCircuitOpenError);
    }
    expect(install.spawns()).toHaveLength(3);

    // No demand, no spawn: the probe needs a caller, however long it stays quiet.
    await sleep(Math.max(0, openedAt + 1_700 - Date.now()));
    expect(install.spawns()).toHaveLength(3);

    // Half-open: concurrent demand shares one attempt, and no retries follow.
    const probes = await Promise.allSettled([supervisor.ensureReady(), supervisor.ensureReady()]);
    const probedAt = Date.now();
    expect(probes.map((probe) => probe.status)).toEqual(["rejected", "rejected"]);
    expect(install.spawns()).toHaveLength(4);
    expect(supervisor.getHealth().circuitOpen).toBe(true);

    // The failed probe doubled the cooldown: 1.5 s has passed, 3 s has not.
    await sleep(Math.max(0, probedAt + 1_700 - Date.now()));
    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(AppServerCircuitOpenError);
    expect(install.spawns()).toHaveLength(4);

    // The user fixes the install; the next probe reaches the real binary.
    install.setMode("real");
    await sleep(Math.max(0, probedAt + 3_200 - Date.now()));
    const generation = await supervisor.ensureReady();
    expect(install.spawns()).toHaveLength(5);
    expect(parseVersionFromUserAgent(generation.initialize.userAgent)).toBe(await pinnedVersion());
    expect(realpathSync(generation.initialize.codexHome)).toBe(install.codexHome);
    expect(supervisor.isReady()).toBe(true);
    expect(supervisor.getHealth().circuitOpen).toBe(false);

    // Closing forgot the outage: the next failure gets a whole ladder again,
    // and the cooldown is back to its first value.
    install.setMode("exit");
    const realPid = supervisor.getHealth().pid!;
    process.kill(realPid, "SIGKILL");
    while (supervisor.isReady()) await sleep(10);
    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(AppServerCircuitOpenError);
    const reopenedAt = Date.now();
    expect(install.spawns()).toHaveLength(8);
    install.setMode("real");
    await sleep(Math.max(0, reopenedAt + 1_700 - Date.now()));
    await supervisor.ensureReady();
    expect(install.spawns()).toHaveLength(9);

    const pid = supervisor.getHealth().pid!;
    await supervisor.stop();
    expect(isRunning(pid)).toBe(false);
    expectNoSurvivors(install);
  }, 60_000);

  test("a binary that hangs in initialize is killed at the handshake timeout and trips the breaker", async () => {
    const install = await brokenInstall("hang", {
      circuitBreakerThreshold: 1,
      circuitCooldownMs: 500,
    });
    const { supervisor } = install;

    const startedAt = Date.now();
    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(AppServerCircuitOpenError);
    // METHOD_TIMEOUTS_MS.initialize, plus termination.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(29_000);
    expect(Date.now() - startedAt).toBeLessThan(45_000);
    expect(install.spawns()).toHaveLength(1);
    expect(supervisor.getHealth().circuitOpen).toBe(true);
    expectNoSurvivors(install);

    install.setMode("real");
    await sleep(600);
    await supervisor.ensureReady();
    expect(supervisor.isReady()).toBe(true);
    expect(supervisor.getHealth().circuitOpen).toBe(false);
    expect(install.spawns()).toHaveLength(2);
  }, 90_000);

  test("a missing or non-executable binary trips the breaker without an unhandled error, and recovers", async () => {
    const install = await brokenInstall("real", {
      circuitBreakerThreshold: 2,
      circuitCooldownMs: 300,
      circuitMaxCooldownMs: 600,
    });
    const { supervisor } = install;
    const parked = `${install.wrapper}.parked`;
    renameSync(install.wrapper, parked);

    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(AppServerCircuitOpenError);
    expect(supervisor.getHealth().circuitOpen).toBe(true);
    expect(install.spawns()).toHaveLength(0);

    // Present again, but not executable: the probe fails the same way.
    renameSync(parked, install.wrapper);
    chmodSync(install.wrapper, 0o644);
    await sleep(350);
    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(AppServerCircuitOpenError);
    expect(install.spawns()).toHaveLength(0);

    chmodSync(install.wrapper, 0o755);
    await sleep(650);
    await supervisor.ensureReady();
    expect(supervisor.isReady()).toBe(true);
    expect(install.spawns()).toHaveLength(1);
  }, 30_000);

  test("stop wakes a real backoff sleep and leaves no process behind", async () => {
    const install = await brokenInstall("exit", {
      circuitBreakerThreshold: 5,
      backoffScheduleMs: [60_000],
    });
    const { supervisor } = install;

    const pending = supervisor.ensureReady().catch((error: unknown) => error);
    while (supervisor.getState() !== "backoff") await sleep(10);
    expect(install.spawns()).toHaveLength(1);

    const stoppingAt = Date.now();
    await supervisor.stop();
    expect(Date.now() - stoppingAt).toBeLessThan(5_000);
    expect(await pending).toBeInstanceOf(AppServerUnavailableError);
    expect(install.spawns()).toHaveLength(1);
    expectNoSurvivors(install);
  }, 30_000);
});
