import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fakePid } from "@orkestrator/protocol/testing/fake-pids";

import { AGENT_TEST_AGENT_TOOLS_PORT_RANGE } from "../../electron/runtime-profile.js";
import {
  agentToolsPortClaimsDir,
  chooseAgentToolsPort,
  claimAgentToolsPort,
  type AgentToolsPortOwner,
} from "./agent-tools-port-claims.js";
import { processStartTime } from "./profile-io.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { busy?: number[]; dead?: string[] } = {}) {
  const developmentRoot = await mkdtemp(path.join(os.tmpdir(), "ork-port-claims-"));
  roots.push(developmentRoot);
  const checked: number[] = [];
  const dead = new Set(options.dead ?? []);
  const owner = (profile: string, pid = 1000): AgentToolsPortOwner => ({
    profile,
    pid,
    startTime: 1,
  });
  const base = (profile: string) => ({
    developmentRoot,
    owner: owner(profile),
    // Never binds a real port: the range may be in use by real profiles.
    checkFree: async (port: number) => {
      checked.push(port);
      if (options.busy?.includes(port)) {
        throw new Error(`--agent-tools-port ${port} is already in use`);
      }
    },
    isLive: (holder: AgentToolsPortOwner) => !dead.has(holder.profile),
  });
  const claimFile = (port: number) =>
    path.join(agentToolsPortClaimsDir(developmentRoot), `${port}.json`);
  return { developmentRoot, base, checked, dead, claimFile };
}

const { first } = AGENT_TEST_AGENT_TOOLS_PORT_RANGE;

describe("--agent-tools-port auto", () => {
  test("takes the first unclaimed port and records the launcher that holds it", async () => {
    const s = await setup();
    expect(await chooseAgentToolsPort(s.base("a"))).toBe(first);
    expect(await chooseAgentToolsPort(s.base("b"))).toBe(first + 1);
    expect(JSON.parse(await readFile(s.claimFile(first), "utf8"))).toEqual({
      version: 1,
      port: first,
      profile: "a",
      pid: 1000,
      startTime: 1,
    });
    // No temporary or retired files are left behind.
    expect((await readdir(agentToolsPortClaimsDir(s.developmentRoot))).sort()).toEqual([
      `${first}.json`,
      `${first + 1}.json`,
    ]);
  });

  test("a profile restarting keeps its own port, and prefers its recorded one", async () => {
    const s = await setup();
    expect(await chooseAgentToolsPort(s.base("a"))).toBe(first);
    expect(await chooseAgentToolsPort(s.base("a"))).toBe(first);
    expect(await chooseAgentToolsPort({ ...s.base("b"), preferred: first + 4 })).toBe(first + 4);
    // A recorded port outside the range is not preferred.
    expect(await chooseAgentToolsPort({ ...s.base("c"), preferred: 40000 })).toBe(first + 1);
  });

  test("a stopped launcher's claim is replaced", async () => {
    const s = await setup();
    expect(await chooseAgentToolsPort(s.base("a"))).toBe(first);
    s.dead.add("a");
    expect(await chooseAgentToolsPort(s.base("b"))).toBe(first);
    expect(JSON.parse(await readFile(s.claimFile(first), "utf8")).profile).toBe("b");
  });

  test("an unreadable claim protects nothing", async () => {
    const s = await setup();
    await chooseAgentToolsPort(s.base("seed"));
    await writeFile(s.claimFile(first), "not json");
    expect(await chooseAgentToolsPort(s.base("b"))).toBe(first);
  });

  test("a port something listens on is skipped and not left claimed", async () => {
    const s = await setup({ busy: [first] });
    expect(await chooseAgentToolsPort(s.base("a"))).toBe(first + 1);
    expect(s.checked).toEqual([first, first + 1]);
    await expect(readFile(s.claimFile(first), "utf8")).rejects.toThrow();
  });

  test("an exhausted range refuses and names every port's reason", async () => {
    const range = { first, last: first + 2 };
    const s = await setup({ busy: [first + 2] });
    await chooseAgentToolsPort({ ...s.base("a"), range });
    await chooseAgentToolsPort({ ...s.base("b"), range });
    await expect(chooseAgentToolsPort({ ...s.base("c"), range })).rejects.toThrow(
      `--agent-tools-port auto found no free port in ${first}-${first + 2} (${first} claimed by a, ${first + 1} claimed by b, ${first + 2} in use)`,
    );
  });

  test("launchers choosing at the same time each get a different port", async () => {
    const s = await setup();
    const profiles = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const ports = await Promise.all(profiles.map((name) => chooseAgentToolsPort(s.base(name))));
    expect(new Set(ports).size).toBe(profiles.length);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(first);
      expect(port).toBeLessThan(first + profiles.length);
    }
  });

  test("launchers replacing the same stale claims at the same time each get a different port", async () => {
    const s = await setup();
    const { last } = AGENT_TEST_AGENT_TOOLS_PORT_RANGE;
    // Every port carries a claim from an earlier run whose launcher is gone.
    for (let port = first; port <= last; port += 1) {
      await chooseAgentToolsPort({ ...s.base(`old${port}`), range: { first: port, last: port } });
      s.dead.add(`old${port}`);
    }
    const profiles = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const ports = await Promise.all(profiles.map((name) => chooseAgentToolsPort(s.base(name))));
    expect(new Set(ports).size).toBe(profiles.length);
    // Each launcher holds exactly the port it was given, no other claim names
    // it, and no temporary or retired file is left behind.
    const directory = agentToolsPortClaimsDir(s.developmentRoot);
    const names = (await readdir(directory)).sort();
    expect(names.every((name) => /^\d+\.json$/.test(name))).toBe(true);
    const holders = new Map<string, number[]>();
    for (const name of names) {
      const claim = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      holders.set(claim.profile, [...(holders.get(claim.profile) ?? []), claim.port]);
    }
    profiles.forEach((name, index) => expect(holders.get(name)).toEqual([ports[index]!]));
  });

  // Another launcher's retire moves a fresh claim aside, finds it is not the
  // stale claim it read, and links it back. A launcher re-reading its claim in
  // between finds no file.
  async function moveClaimAside(file: string): Promise<() => Promise<void>> {
    const aside = `${file}.test.retired`;
    await rename(file, aside);
    return async () => {
      await link(aside, file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await rm(aside, { force: true });
    };
  }

  test("a claim moved aside during the check and put back is kept", async () => {
    const s = await setup();
    let putBack: Promise<void> | undefined;
    const port = await chooseAgentToolsPort({
      ...s.base("a"),
      checkFree: async (port) => {
        s.checked.push(port);
        if (s.checked.length > 1) return;
        const restore = await moveClaimAside(s.claimFile(port));
        putBack = new Promise((resolve) => setTimeout(resolve, 20)).then(restore);
      },
    });
    await putBack;
    expect(port).toBe(first);
    expect(s.checked).toEqual([first]);
    expect(await readdir(agentToolsPortClaimsDir(s.developmentRoot))).toEqual([`${first}.json`]);
    expect(JSON.parse(await readFile(s.claimFile(first), "utf8")).profile).toBe("a");
  });

  test("a claim moved aside and put back only later is published again, not stranded", async () => {
    const s = await setup();
    let restore: (() => Promise<void>) | undefined;
    const checkFree = async (port: number) => {
      s.checked.push(port);
      if (restore) {
        // The other launcher's link-back arrives after this one gave up waiting.
        await restore();
        restore = undefined;
        return;
      }
      if (s.checked.length === 1) restore = await moveClaimAside(s.claimFile(port));
    };
    expect(await chooseAgentToolsPort({ ...s.base("a"), checkFree })).toBe(first);
    expect(await readdir(agentToolsPortClaimsDir(s.developmentRoot))).toEqual([`${first}.json`]);
    expect(JSON.parse(await readFile(s.claimFile(first), "utf8")).profile).toBe("a");

    // An exact port is kept the same way instead of being refused.
    s.checked.length = 0;
    expect(await claimAgentToolsPort({ ...s.base("b"), port: first + 3, checkFree })).toBe(
      first + 3,
    );
    expect(JSON.parse(await readFile(s.claimFile(first + 3), "utf8")).profile).toBe("b");
  });

  test("the default liveness check follows the launcher's PID and start time", async () => {
    const s = await setup();
    const { isLive: _injected, ...base } = s.base("x");
    const startTime = processStartTime(process.pid);
    expect(startTime).not.toBeNull();
    await chooseAgentToolsPort({
      ...base,
      owner: { profile: "live", pid: process.pid, startTime: startTime! },
    });
    await chooseAgentToolsPort({
      ...base,
      owner: { profile: "gone", pid: fakePid(7500), startTime: 1 },
    });
    // The live launcher's claim holds; the gone one's is replaced.
    expect(await chooseAgentToolsPort(base)).toBe(first + 1);
  });
});

describe("--agent-tools-port <n> claims", () => {
  test("refuses a port another running profile has claimed", async () => {
    const s = await setup();
    expect(await claimAgentToolsPort({ ...s.base("a"), port: first + 3 })).toBe(first + 3);
    await expect(claimAgentToolsPort({ ...s.base("b"), port: first + 3 })).rejects.toThrow(
      `--agent-tools-port ${first + 3} is claimed by the running profile a`,
    );
    // An automatic choice also steps around it.
    expect(await chooseAgentToolsPort({ ...s.base("c"), preferred: first + 3 })).toBe(first);
    s.dead.add("a");
    expect(await claimAgentToolsPort({ ...s.base("b"), port: first + 3 })).toBe(first + 3);
  });

  test("a busy port keeps the bind check's own error", async () => {
    const s = await setup({ busy: [first] });
    await expect(claimAgentToolsPort({ ...s.base("a"), port: first })).rejects.toThrow(
      `--agent-tools-port ${first} is already in use`,
    );
  });
});
