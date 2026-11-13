import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DAEMON_SELECTORS,
  disposableSocket,
  dockerCommand,
  dockerEnvironment,
  dockerfile,
  ghFollowsLatest,
  ghOnPin,
  lastLine,
  loginSessions,
  parseJson,
  parseOptions,
  SetupError,
} from "../../scripts/qualify-host-upgrades-container";

const rootless = {
  ORKESTRATOR_DISPOSABLE_DOCKER_MODE: "rootless",
  DOCKER_HOST: "unix:///tmp/ork-ddd-1000-q0033/docker.sock",
};

test("only a disposable rootless daemon's socket is accepted", () => {
  expect(disposableSocket(rootless)).toBe("/tmp/ork-ddd-1000-q0033/docker.sock");
  for (const env of [
    {},
    { DOCKER_HOST: rootless.DOCKER_HOST },
    { ...rootless, ORKESTRATOR_DISPOSABLE_DOCKER_MODE: "rootful" },
    { ...rootless, DOCKER_HOST: "unix:///var/run/docker.sock" },
    { ...rootless, DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
    { ...rootless, DOCKER_HOST: "tcp://127.0.0.1:2375" },
    { ...rootless, DOCKER_HOST: undefined },
  ]) {
    expect(() => disposableSocket(env)).toThrow(SetupError);
  }
});

test("options default to the current release pair and refuse unknown phases", () => {
  const options = parseOptions([]);
  expect([...options.phases]).toEqual(["service", "linger", "host-tasks"]);
  expect(options.enginesTo).toBe(options.to);
  expect(options.enginesFrom).toBe("2.29.0-beta");
  expect([...parseOptions(["--phases", "linger"]).phases]).toEqual(["linger"]);
  expect(parseOptions(["--to", "9.9.9-beta"]).enginesTo).toBe("9.9.9-beta");
  for (const phases of ["", ",", "linger,typo"]) {
    expect(() => parseOptions(["--phases", phases])).toThrow(SetupError);
  }
  expect(() => parseOptions(["--name", "../host"])).toThrow(SetupError);
});

test("the image verifies both Bun downloads and boots systemd with a lingering user", () => {
  const file = dockerfile("x64");
  expect(file).toContain("sha256sum -c -");
  expect(file).toContain("1.4.3:3e730528");
  expect(file).toContain("1.4.4:bf8ccbfb");
  expect(file).toContain("touch /var/lib/systemd/linger/qual");
  expect(file).toContain('CMD ["/sbin/init"]');
  // The shell, not TypeScript, expands these.
  expect(file).toContain("v=${spec%%:*}");
  expect(file).toContain("bun-linux-x64.zip");
  // arm64 hosts build too, from Bun's own aarch64 archives (SHASUMS256.txt).
  const arm = dockerfile("arm64");
  expect(arm).toContain("bun-linux-aarch64.zip");
  expect(arm).not.toContain("bun-linux-x64.zip");
  expect(arm).toContain("1.4.4:baa6bb36");
  expect(arm).toContain("1.4.3:efa9813d");
  expect(arm).toContain("sha256sum -c -");
  expect(() => dockerfile("ia32")).toThrow(SetupError);
});

test("every Docker call is pinned to the validated socket, whatever else selects a daemon", () => {
  const socket = "/tmp/ork-ddd-1000-q0033/docker.sock";
  expect(dockerCommand("/bin/docker", socket, ["ps", "-a"])).toEqual([
    "/bin/docker",
    "--host",
    `unix://${socket}`,
    "ps",
    "-a",
  ]);
  const env = dockerEnvironment(
    {
      ...rootless,
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DOCKER_CONTEXT: "host-daemon",
      DOCKER_TLS: "1",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "/home/me/.docker",
      UNSET: undefined,
    },
    socket,
  );
  expect(env.DOCKER_HOST).toBe(`unix://${socket}`);
  for (const key of DAEMON_SELECTORS) expect(key in env).toBe(false);
  expect(env.PATH).toBe("/usr/bin");
  expect("UNSET" in env).toBe(false);
});

test("JSON after a login banner is still read", () => {
  expect(parseJson('motd\n{"ok":true}')).toEqual({ ok: true });
  expect(parseJson("no json")).toBeNull();
});

test("gh channel verdicts need the channel, the version and the pin to agree", () => {
  const host = (ghChannel: string, gh: Record<string, unknown>) => ({
    ghChannel,
    tools: [{ name: "gh", pinnedVersion: "2.102.0", source: "managed", ...gh }],
  });
  expect(
    ghFollowsLatest(host("latest", { channel: "latest", installedVersion: "2.104.0" }), "2.104.0"),
  ).toBe(true);
  // The upstream release is the pin: nothing proves the switch.
  expect(
    ghFollowsLatest(host("latest", { channel: "latest", installedVersion: "2.102.0" }), "2.102.0"),
  ).toBe(false);
  expect(
    ghFollowsLatest(host("pinned", { channel: "pinned", installedVersion: "2.104.0" }), "2.104.0"),
  ).toBe(false);
  expect(ghFollowsLatest(null, "2.104.0")).toBe(false);
  expect(ghOnPin(host("pinned", { channel: "pinned", installedVersion: "2.102.0" }))).toBe(true);
  expect(ghOnPin(host("pinned", { channel: "pinned", installedVersion: "2.104.0" }))).toBe(false);
  expect(ghOnPin(host("latest", { channel: "pinned", installedVersion: "2.102.0" }))).toBe(false);
});

test("the user manager's own session is not a login", () => {
  const manager = { session: "c1", user: "qual", class: "manager" };
  expect(loginSessions(JSON.stringify([manager]), "qual")).toBe(0);
  expect(
    loginSessions(
      JSON.stringify([manager, { session: "c2", user: "qual", class: "user" }]),
      "qual",
    ),
  ).toBe(1);
  expect(
    loginSessions(JSON.stringify([{ session: "c3", user: "root", class: "user" }]), "qual"),
  ).toBe(0);
  expect(loginSessions("not json", "qual")).toBeNull();
});

test("terminal output is read by its last line", () => {
  expect(lastLine("Last login: now\r\nactive\r\n")).toBe("active");
  expect(lastLine("")).toBe("");
});

// --- the runner against a fake Docker executable ---------------------------

const SCRIPT = path.resolve(import.meta.dir, "../../scripts/qualify-host-upgrades-container.ts");
const FAKE_DOCKER = `#!/bin/sh
# argv and the daemon selectors of every call, one line each.
printf '%s|context=%s|host=%s|tls=%s\\n' "$*" "\${DOCKER_CONTEXT-unset}" "\${DOCKER_HOST-unset}" "\${DOCKER_TLS_VERIFY-unset}" >> "$FAKE_LOG"
[ "$1" = --host ] || exit 64
shift 2
case "$1 $2" in
  "container inspect") exit 1 ;;
  "build "*) [ -n "$FAKE_BUILD_FAIL" ] && { echo "build refused" >&2; exit 1; }; exit 0 ;;
  "run "*) echo fake-container-id; exit 0 ;;
esac
case "$*" in
  *"is-system-running --wait"*) echo blocked >> "$FAKE_LOG.blocked"; exec sleep 30 ;;
esac
exit 0
`;

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeRun(extraEnv: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qualify-0033-fake-"));
  temporary.push(dir);
  const root = path.join(dir, "checkout");
  mkdirSync(path.join(root, "packages", "cli", "dist"), { recursive: true });
  const docker = path.join(dir, "docker");
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);
  const log = path.join(dir, "docker.log");
  const report = path.join(dir, "report.json");
  const socket = path.join(dir, "ork-ddd-1000-qt", "docker.sock");
  const driver = `import { qualifyHostUpgradesContainer } from ${JSON.stringify(SCRIPT)};
process.exit(await qualifyHostUpgradesContainer(process.argv.slice(2), { docker: ${JSON.stringify(docker)}, root: ${JSON.stringify(root)} }));`;
  const driverFile = path.join(dir, "driver.ts");
  writeFileSync(driverFile, driver);
  const child = Bun.spawn(
    [process.execPath, driverFile, "--name", "qt", "--phases", "service", "--report", report],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        ORKESTRATOR_DISPOSABLE_DOCKER_MODE: "rootless",
        DOCKER_HOST: `unix://${socket}`,
        FAKE_LOG: log,
        ...extraEnv,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  const readReport = () => JSON.parse(readFileSync(report, "utf8"));
  return { child, socket, log, calls, readReport };
}

test("a context or TLS selector in the caller's environment never reaches Docker", async () => {
  const run = fakeRun({
    DOCKER_CONTEXT: "host-daemon",
    DOCKER_TLS_VERIFY: "1",
    FAKE_BUILD_FAIL: "1",
  });
  expect(await run.child.exited).toBe(2);
  const calls = run.calls();
  // inspect, build, then cleanup of the image it may have tagged.
  expect(calls.length).toBeGreaterThanOrEqual(3);
  for (const call of calls) {
    expect(call.startsWith(`--host unix://${run.socket} `)).toBe(true);
    expect(call).toContain("|context=unset|");
    expect(call).toContain(`|host=unix://${run.socket}|`);
    expect(call).toContain("|tls=unset");
  }
  expect(calls.some((call) => call.includes(" build -t qt-systemd:qualify "))).toBe(true);
  expect(calls.some((call) => call.includes(" image rm qt-systemd:qualify|"))).toBe(true);
  // Never started a container, so none is removed.
  expect(calls.some((call) => call.includes(" rm -f "))).toBe(false);
  expect(run.readReport().passed).toBe(false);
});

test("SIGTERM after the container starts removes the container and image, then reports", async () => {
  const run = fakeRun({});
  const deadline = Date.now() + 20_000;
  while (!run.calls().some((call) => call.includes("is-system-running --wait"))) {
    if (Date.now() > deadline) throw new Error("the runner never reached the boot wait");
    await Bun.sleep(50);
  }
  run.child.kill("SIGTERM");
  expect(await run.child.exited).toBe(143);
  const calls = run.calls();
  const started = calls.findIndex((call) => call.includes(" run -d --name qt-systemd "));
  const removed = calls.findIndex((call) => call.includes(" rm -f qt-systemd|"));
  const image = calls.findIndex((call) => call.includes(" image rm qt-systemd:qualify|"));
  expect(started).toBeGreaterThanOrEqual(0);
  expect(removed).toBeGreaterThan(started);
  expect(image).toBeGreaterThan(removed);
  const report = run.readReport();
  expect(report.interrupted).toBe("SIGTERM");
  expect(report.passed).toBe(false);
  expect(report.checks.at(-1)).toMatchObject({ phase: "run", ok: false });
}, 30_000);
