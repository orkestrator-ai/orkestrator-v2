import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  FORBIDDEN_PORTS,
  PAIRING_OLD_APP_ENV,
  loopbackPairingPortProbe,
  pairingBackendEnvironment,
  pairingOldAppExecutable,
  pairingPorts,
  type PairingPortProbe,
} from "./design-renderer-pairing-support";

/** A probe that offers `candidates` in order and records every bind. */
function scriptedProbe(candidates: number[], taken: ReadonlySet<number> = new Set()) {
  const bound: number[] = [];
  const released: number[] = [];
  let next = 0;
  const probe: PairingPortProbe = {
    candidate: () => candidates[next++ % candidates.length]!,
    bind: async (port) => {
      bound.push(port);
      if (taken.has(port)) return null;
      return async () => {
        released.push(port);
      };
    },
  };
  return { probe, bound, released };
}

describe("pairing ports", () => {
  test("never binds a production port, and skips taken and repeated ones", async () => {
    const { probe, bound, released } = scriptedProbe(
      [34121, 34122, 45507, 21000, 21000, 21001, 21002],
      new Set([21001]),
    );
    expect(await pairingPorts(2, probe)).toEqual([21000, 21002]);
    expect(bound).toEqual([21000, 21001, 21002]);
    for (const port of FORBIDDEN_PORTS) expect(bound).not.toContain(port);
    // Every chosen port is held until all are chosen, then released.
    expect(released.sort()).toEqual([21000, 21002]);
  });

  test("gives up, binding nothing, when only production ports are offered", async () => {
    const { probe, bound } = scriptedProbe([...FORBIDDEN_PORTS]);
    await expect(pairingPorts(1, probe, 30)).rejects.toThrow(
      "No free loopback ports outside the production ports",
    );
    expect(bound).toEqual([]);
  });

  test("releases what it bound when it cannot find enough ports", async () => {
    const { probe, released } = scriptedProbe([22000, 34121]);
    await expect(pairingPorts(2, probe, 10)).rejects.toThrow();
    expect(released).toEqual([22000]);
  });

  test("draws real candidates below the ephemeral ranges and outside the production ports", async () => {
    for (let index = 0; index < 1_000; index++) {
      const port = loopbackPairingPortProbe.candidate();
      expect(port).toBeGreaterThanOrEqual(20_000);
      expect(port).toBeLessThanOrEqual(32_767);
      expect(FORBIDDEN_PORTS.has(port)).toBe(false);
    }
    const ports = await pairingPorts(2);
    expect(new Set(ports).size).toBe(2);
  });
});

describe("published app executable", () => {
  test("resolves a repository-relative value against the repository root", () => {
    expect(
      pairingOldAppExecutable("/repo", {
        [PAIRING_OLD_APP_ENV]:
          " output/agent-testing/old/OrkestratorV2.app/Contents/MacOS/OrkestratorV2 ",
      }),
    ).toBe(
      path.join("/repo", "output/agent-testing/old/OrkestratorV2.app/Contents/MacOS/OrkestratorV2"),
    );
    expect(pairingOldAppExecutable("/repo", { [PAIRING_OLD_APP_ENV]: "/opt/app/x" })).toBe(
      "/opt/app/x",
    );
  });

  test("is undefined when unset or blank", () => {
    expect(pairingOldAppExecutable("/repo", {})).toBeUndefined();
    expect(pairingOldAppExecutable("/repo", { [PAIRING_OLD_APP_ENV]: "  " })).toBeUndefined();
  });
});

describe("pairing backend environment", () => {
  const home = "/run/root/backend/home";
  const env = pairingBackendEnvironment(
    {
      LANG: "en_GB.UTF-8",
      USER: "tester",
      PATH: "/host/bin",
      ORKESTRATOR_DATA_DIR: "/production",
      ORKESTRATOR_AGENT_MCP_TOKEN: "host-token",
      ANTHROPIC_API_KEY: "secret",
      GH_TOKEN: "secret",
      DISPLAY: ":0",
      HOME: "/Users/someone",
    },
    { home, tmp: "/run/root/backend/tmp", token: "pairing-token" },
    ["/tools/bun/bin"],
  );

  test("keeps only the allowlisted host variables", () => {
    expect(env.LANG).toBe("en_GB.UTF-8");
    expect(env.USER).toBe("tester");
    for (const name of [
      "ORKESTRATOR_DATA_DIR",
      "ORKESTRATOR_AGENT_MCP_TOKEN",
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "DISPLAY",
    ]) {
      expect(env[name]).toBeUndefined();
    }
    const orkestrator = Object.keys(env).filter((name) => name.startsWith("ORKESTRATOR_"));
    expect(orkestrator.sort()).toEqual([
      "ORKESTRATOR_CONTROL_MCP_PORT",
      "ORKESTRATOR_GATEWAY_TOKEN",
      "ORKESTRATOR_HOST_REACHABILITY_CHECK",
    ]);
    expect(env.ORKESTRATOR_GATEWAY_TOKEN).toBe("pairing-token");
    expect(env.ORKESTRATOR_CONTROL_MCP_PORT).toBe("0");
    expect(env.ORKESTRATOR_HOST_REACHABILITY_CHECK).toBe("off");
  });

  test("puts HOME, the XDG roots and TMPDIR under the run root, and builds PATH", () => {
    expect(env.HOME).toBe(home);
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
      expect(env[name]!.startsWith(`${home}${path.sep}`)).toBe(true);
    }
    expect(env.TMPDIR).toBe("/run/root/backend/tmp");
    expect(env.PATH!.split(path.delimiter)).toEqual([
      "/tools/bun/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]);
  });

  test("forces Git's fsmonitor off through Git's environment config", () => {
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    const count = Number(env.GIT_CONFIG_COUNT);
    const settings = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        env[`GIT_CONFIG_KEY_${index}`],
        env[`GIT_CONFIG_VALUE_${index}`],
      ]),
    );
    expect(settings).toEqual({ "core.fsmonitor": "false" });
  });
});
