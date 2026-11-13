import { expect, test } from "bun:test";
import {
  disposableSocket,
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
  expect(() => dockerfile("ia32")).toThrow(SetupError);
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
