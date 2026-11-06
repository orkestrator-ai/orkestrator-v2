import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  AGENT_TEST_AGENT_TOOLS_PORT_RANGE,
  parseRuntimeProfile,
  RESERVED_AGENT_TOOLS_PORTS,
  resolveRuntimeProfile,
} from "../../electron/runtime-profile.js";
import { parseAgentTestArguments, parseDevArguments } from "./arguments.js";
import { startDevelopment } from "./lifecycle.js";
import * as profileIo from "./profile-io.js";
import { assertAgentToolsPortFree } from "./profile-io.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");

describe("dev:test --agent-tools-port", () => {
  test("parses an exact port for dev:test only", () => {
    expect(parseAgentTestArguments(["--agent-tools-port", "31500"]).agentToolsPort).toBe(31500);
    expect(parseAgentTestArguments([]).agentToolsPort).toBeUndefined();
    expect(() => parseDevArguments(["--agent-tools-port", "31500"])).toThrow(
      "--agent-tools-port is only supported by mise run dev:test",
    );
    expect(() => parseAgentTestArguments(["--agent-tools-port"])).toThrow(
      "Missing value for --agent-tools-port",
    );
  });

  test("refuses the installed app's ports and anything that is not a usable port", () => {
    expect(RESERVED_AGENT_TOOLS_PORTS).toEqual([34121, 34122, 45507]);
    for (const port of RESERVED_AGENT_TOOLS_PORTS) {
      expect(() => parseAgentTestArguments(["--agent-tools-port", String(port)])).toThrow(
        `--agent-tools-port ${port} is reserved`,
      );
    }
    for (const value of ["0", "80", "1023", "65536", "31500.5", "-1", "0x7b0c", "315oo"]) {
      expect(() => parseAgentTestArguments(["--agent-tools-port", value])).toThrow(
        "--agent-tools-port must be a whole number from 1024 to 65535",
      );
    }
  });

  test("the documented range is ten ports clear of the reserved ones", () => {
    const { first, last } = AGENT_TEST_AGENT_TOOLS_PORT_RANGE;
    expect(last - first + 1).toBe(10);
    for (const port of RESERVED_AGENT_TOOLS_PORTS) {
      expect(port < first || port > last).toBe(true);
    }
    expect(last).toBeLessThan(32768);
  });

  test("the profile records it, and only for agent-test", () => {
    const base = { repositoryRoot, requestedId: "agent-tools-port-qa" } as const;
    const profile = resolveRuntimeProfile({ ...base, flavor: "agent-test", agentToolsPort: 31501 });
    expect(profile.agentToolsPort).toBe(31501);
    expect(parseRuntimeProfile(JSON.parse(JSON.stringify(profile))).agentToolsPort).toBe(31501);
    expect("agentToolsPort" in resolveRuntimeProfile({ ...base, flavor: "agent-test" })).toBe(
      false,
    );
    expect(() =>
      parseRuntimeProfile({ ...profile, agentToolsPort: RESERVED_AGENT_TOOLS_PORTS[0] }),
    ).toThrow("Runtime profile agentToolsPort 34121 is reserved");
    expect(() => parseRuntimeProfile({ ...profile, agentToolsPort: "31501" })).toThrow(
      "Runtime profile agentToolsPort must be a whole number",
    );
    expect(() => parseRuntimeProfile({ ...profile, flavor: "development" })).toThrow(
      "only supported by agent-test profiles",
    );
  });

  test("a busy port is refused rather than replaced", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "0.0.0.0", resolve));
    const port = (holder.address() as net.AddressInfo).port;
    try {
      await expect(assertAgentToolsPortFree(port)).rejects.toThrow(
        `--agent-tools-port ${port} is already in use`,
      );
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
    // Free again: the check holds nothing once it answers.
    await assertAgentToolsPortFree(port);
    await assertAgentToolsPortFree(port);
  });
});

describe("dev:test startup with --agent-tools-port", () => {
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-agent-tools-port-"));
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const profileFile = path.join(roots.developmentRoot, "profiles", "atp-qa", "profile.json");
    const checked: number[] = [];
    let busy = false;
    const seeds = [
      spyOn(profileIo, "seedInstalledModelCatalogCaches").mockResolvedValue([]),
      spyOn(profileIo, "seedAgentTestProviderCredentials").mockResolvedValue([]),
      spyOn(profileIo, "seedInstalledAgentToolchains").mockResolvedValue({
        seeded: ["claude@test"],
        failed: [],
      }),
    ];
    const notice = spyOn(console, "log").mockImplementation(() => {});
    const statusFile = path.join(path.dirname(profileFile), "runtime", "status.json");
    /** Starts until the (stubbed) Electron compile, which fails on purpose. */
    const start = async (extra: string[]) => {
      // The failed start left a status naming this process as its launcher,
      // which a restart would take for a live profile.
      await rm(statusFile, { force: true });
      return startDevelopment(
        parseAgentTestArguments([
          "--profile",
          "atp-qa",
          "--no-agent-credentials",
          "--agent-platforms",
          "claude",
          ...extra,
        ]),
        "agent-test",
        {
          roots,
          prune: async () => [],
          typecheck: () => ({ status: 2, stderr: "intentional compile stop" }),
          checkAgentToolsPort: async (port) => {
            checked.push(port);
            if (busy) throw new Error(`--agent-tools-port ${port} is already in use`);
          },
        },
      );
    };
    const stored = async () =>
      JSON.parse(await readFile(profileFile, "utf8")) as { agentToolsPort?: number };
    return {
      start,
      stored,
      profileFile,
      checked,
      setBusy: (value: boolean) => {
        busy = value;
      },
      cleanup: async () => {
        for (const seed of seeds) seed.mockRestore();
        notice.mockRestore();
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  test("records the port and keeps it on a restart without the flag", async () => {
    const f = await fixture();
    try {
      await expect(f.start(["--agent-tools-port", "31502"])).rejects.toThrow(
        "Electron compilation failed",
      );
      expect((await f.stored()).agentToolsPort).toBe(31502);
      await expect(f.start([])).rejects.toThrow("Electron compilation failed");
      expect((await f.stored()).agentToolsPort).toBe(31502);
      // A later flag replaces the recorded port.
      await expect(f.start(["--agent-tools-port", "31503"])).rejects.toThrow(
        "Electron compilation failed",
      );
      expect((await f.stored()).agentToolsPort).toBe(31503);
      expect(f.checked).toEqual([31502, 31502, 31503]);
    } finally {
      await f.cleanup();
    }
  });

  test("a busy port stops the start before the profile is written", async () => {
    const f = await fixture();
    try {
      f.setBusy(true);
      await expect(f.start(["--agent-tools-port", "31504"])).rejects.toThrow(
        "--agent-tools-port 31504 is already in use",
      );
      expect(await stat(f.profileFile).catch(() => null)).toBeNull();
      expect(f.checked).toEqual([31504]);
    } finally {
      await f.cleanup();
    }
  });

  test("without the flag nothing is checked or recorded", async () => {
    const f = await fixture();
    try {
      await expect(f.start([])).rejects.toThrow("Electron compilation failed");
      expect("agentToolsPort" in (await f.stored())).toBe(false);
      expect(f.checked).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});
