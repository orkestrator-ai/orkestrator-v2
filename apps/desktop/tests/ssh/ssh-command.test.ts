import { describe, expect, test } from "bun:test";
import {
  buildConfigInspectionArgs,
  buildHostKeyProbeArgs,
  buildTunnelArgs,
  formatKnownHostsFilesOption,
  validateSshRoute,
} from "@orkestrator/protocol/node/ssh/ssh-command";
import {
  assertTunnelSafeConfig,
  parseSshConfigOutput,
  splitKnownHostsFiles,
} from "@orkestrator/protocol/node/ssh/ssh-config-inspection";
import { SshTunnelError } from "@orkestrator/protocol/node/ssh/tunnel-failures";

const HOME = "/home/alice";

function optionValues(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === "-o" ? [arg] : []));
}

describe("buildTunnelArgs", () => {
  const route = validateSshRoute(
    { routeId: "r", destination: "build-machine", remoteGatewayPort: 34_121 },
    HOME,
  );

  test("keeps the alias's port and user: no -p, -l or user@ is added", () => {
    const args = buildTunnelArgs({
      route,
      localPort: 44_001,
      batchMode: true,
      knownHostsFiles: ["~/.ssh/known_hosts", "/data/ssh/known_hosts"],
    });
    expect(args).not.toContain("-p");
    expect(args).not.toContain("-l");
    expect(args).not.toContain("-i");
    expect(optionValues(args)).not.toContain("IdentitiesOnly=yes");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("build-machine");
    expect(args.slice(0, 2)).toEqual(["-N", "-T"]);
    expect(args).toContain("-L");
    expect(args[args.indexOf("-L") + 1]).toBe("127.0.0.1:44001:127.0.0.1:34121");
    expect(optionValues(args)).toEqual(
      expect.arrayContaining([
        "ExitOnForwardFailure=yes",
        "StrictHostKeyChecking=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ClearAllForwardings=no",
        "ControlMaster=no",
        "ControlPath=none",
        "ServerAliveInterval=20",
        "ServerAliveCountMax=3",
        "BatchMode=yes",
        'UserKnownHostsFile="~/.ssh/known_hosts" "/data/ssh/known_hosts"',
      ]),
    );
  });

  test("passes the configured port, identity and interactivity only when set", () => {
    const configured = validateSshRoute(
      {
        routeId: "r",
        destination: "deploy@10.0.0.2",
        sshPort: 2222,
        identityFile: "~/.ssh/id_build",
        remoteGatewayPort: 34_121,
      },
      HOME,
    );
    const args = buildTunnelArgs({
      route: configured,
      localPort: 44_002,
      batchMode: false,
      knownHostsFiles: ["/k"],
    });
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
    expect(args[args.indexOf("-i") + 1]).toBe("/home/alice/.ssh/id_build");
    expect(optionValues(args)).toContain("IdentitiesOnly=yes");
    expect(optionValues(args)).toContain("BatchMode=no");
    expect(args.at(-1)).toBe("deploy@10.0.0.2");
    expect(args.at(-2)).toBe("--");
  });

  test("adds -F only for the test config seam", () => {
    const args = buildTunnelArgs({
      route,
      localPort: 1,
      batchMode: true,
      knownHostsFiles: [],
      configFile: "/tmp/cfg",
    });
    expect(args.slice(0, 2)).toEqual(["-F", "/tmp/cfg"]);
  });

  test("no builder ever disables host-key checking", () => {
    const all = [
      ...buildTunnelArgs({ route, localPort: 1, batchMode: true, knownHostsFiles: [] }),
      ...buildHostKeyProbeArgs(route, "/tmp/x/known_hosts", undefined),
      ...buildConfigInspectionArgs(route, undefined),
    ];
    expect(all.some((arg) => /StrictHostKeyChecking=(no|off)/i.test(arg))).toBe(false);
  });

  test("the host-key probe offers no credential and has no forwards", () => {
    const args = buildHostKeyProbeArgs(route, "/tmp/p/known_hosts", undefined);
    const options = optionValues(args);
    expect(options).toEqual(
      expect.arrayContaining([
        "StrictHostKeyChecking=accept-new",
        'UserKnownHostsFile="/tmp/p/known_hosts"',
        "GlobalKnownHostsFile=/dev/null",
        "BatchMode=yes",
        "PreferredAuthentications=none",
        "PubkeyAuthentication=no",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "ControlMaster=no",
        "ControlPath=none",
        "ClearAllForwardings=yes",
      ]),
    );
    expect(args).not.toContain("-L");
    expect(args.slice(-2)).toEqual(["--", "build-machine"]);
  });

  test("ssh -G puts the port before -- and the destination last", () => {
    const withPort = validateSshRoute(
      { routeId: "r", destination: "host", sshPort: 2200, remoteGatewayPort: 1 },
      HOME,
    );
    expect(buildConfigInspectionArgs(withPort, undefined)).toEqual([
      "-G",
      "-p",
      "2200",
      "--",
      "host",
    ]);
    expect(buildConfigInspectionArgs(route, undefined)).toEqual(["-G", "--", "build-machine"]);
  });

  test("quotes known_hosts paths containing spaces and quotes", () => {
    expect(
      formatKnownHostsFilesOption([
        "/Users/a/Library/Application Support/o/ssh/known_hosts",
        '/x/"q"',
      ]),
    ).toBe('"/Users/a/Library/Application Support/o/ssh/known_hosts" "/x/\\"q\\""');
  });
});

describe("validateSshRoute (SH-12)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["option-looking destination", { destination: "-oProxyCommand=touch /tmp/x" }],
    ["shell metacharacters", { destination: "host;rm -rf /" }],
    ["control characters", { destination: "host\nProxyCommand x" }],
    ["URL", { destination: "ssh://host" }],
    ["two users", { destination: "a@b@c" }],
    ["option-looking host after user", { destination: "user@-oX" }],
    ["bad SSH port", { sshPort: 70_000 }],
    ["bad gateway port", { remoteGatewayPort: 0 }],
    ["relative identity", { identityFile: "id_rsa" }],
    ["key material instead of a path", { identityFile: "/-----BEGIN OPENSSH PRIVATE KEY" }],
    ["control characters in identity", { identityFile: "/k\u0000" }],
    ["empty route ID", { routeId: "" }],
  ];
  for (const [name, patch] of cases) {
    test(`rejects ${name}`, () => {
      const spec = {
        routeId: "r",
        destination: "build-machine",
        remoteGatewayPort: 34_121,
        ...patch,
      } as Parameters<typeof validateSshRoute>[0];
      let error: unknown;
      try {
        validateSshRoute(spec, HOME);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SshTunnelError);
      expect((error as SshTunnelError).code).toBe("invalid-route");
      expect((error as SshTunnelError).retryable).toBe(false);
    });
  }
});

describe("ssh -G inspection (SH-13)", () => {
  test("parses the fields the adapter needs", () => {
    const config = parseSshConfigOutput(
      [
        "user alice",
        "hostname 10.0.0.2",
        "port 2222",
        "userknownhostsfile ~/.ssh/known_hosts /etc/extra hosts/kh",
        "proxyjump bastion",
        "controlmaster auto",
        "controlpath ~/.ssh/cm-%C",
        "permitlocalcommand yes",
        "localcommand echo hi",
      ].join("\n"),
    );
    expect(config).toMatchObject({
      user: "alice",
      hostname: "10.0.0.2",
      port: 2222,
      userKnownHostsFiles: ["~/.ssh/known_hosts", "/etc/extra hosts/kh"],
      usesProxyJump: true,
      controlMaster: "auto",
      permitLocalCommand: true,
      hasLocalCommand: true,
      localForwards: 0,
    });
    expect(assertTunnelSafeConfig(config)).toEqual(["permit-local-command"]);
  });

  test("refuses configurations with extra forwards", () => {
    for (const line of [
      "localforward 9999 [localhost]:80",
      "remoteforward 8888 [localhost]:22",
      "dynamicforward 1080",
    ]) {
      const config = parseSshConfigOutput(`hostname h\n${line}\n`);
      expect(() => assertTunnelSafeConfig(config)).toThrow(SshTunnelError);
      try {
        assertTunnelSafeConfig(config);
      } catch (error) {
        expect((error as SshTunnelError).code).toBe("config-extra-forwards");
        expect((error as SshTunnelError).message).toContain("dedicated Host alias");
      }
    }
  });

  test("treats `none` known hosts and proxyjump as absent", () => {
    expect(splitKnownHostsFiles("none")).toEqual([]);
    expect(parseSshConfigOutput("proxyjump none\n").usesProxyJump).toBe(false);
  });
});
