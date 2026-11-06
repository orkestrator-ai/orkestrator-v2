import { describe, expect, test } from "bun:test";
import {
  AgentToolsPeerFilter,
  isLoopbackPeer,
  loadOwnedDockerSubnets,
  MISS_RELOAD_INTERVAL_MS,
  parseIpv4,
  parseIpv4Subnet,
} from "./agent-tools-peer-filter.js";
import { reportDockerNetworkChange } from "./docker-network-changes.js";
import type { runCommand } from "./shell.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("peer address parsing", () => {
  test("IPv4, its mapped form, and nothing else", () => {
    expect(parseIpv4("172.17.0.2")).toBe(0xac110002);
    expect(parseIpv4("::ffff:172.17.0.2")).toBe(0xac110002);
    expect(parseIpv4("::FFFF:10.0.0.1")).toBe(0x0a000001);
    for (const value of ["", "256.0.0.1", "1.2.3", "1.2.3.4.5", "fe80::1", "a.b.c.d", undefined]) {
      expect(parseIpv4(value)).toBeNull();
    }
  });

  test("subnets are IPv4 CIDRs, normalized to their base", () => {
    expect(parseIpv4Subnet("172.25.3.9/16")).toMatchObject({ base: 0xac190000, mask: 0xffff0000 });
    expect(parseIpv4Subnet("0.0.0.0/0")).toMatchObject({ base: 0, mask: 0 });
    expect(parseIpv4Subnet("10.0.0.1/32")).toMatchObject({ base: 0x0a000001, mask: 0xffffffff });
    for (const value of ["fd00::/64", "172.17.0.0", "172.17.0.0/33", "x/8"]) {
      expect(parseIpv4Subnet(value)).toBeNull();
    }
  });

  test("loopback covers 127/8 and ::1 in every form", () => {
    for (const value of ["127.0.0.1", "127.1.2.3", "::ffff:127.0.0.1", "::1"]) {
      expect(isLoopbackPeer(value)).toBe(true);
    }
    for (const value of ["128.0.0.1", "192.168.4.51", "::2", "", undefined, null]) {
      expect(isLoopbackPeer(value)).toBe(false);
    }
  });
});

describe("AgentToolsPeerFilter", () => {
  test("loopback-only admits loopback and refuses every other address without I/O", async () => {
    const filter = AgentToolsPeerFilter.loopbackOnly();
    expect(filter.verdict("127.0.0.1")).toBe("admit");
    expect(filter.verdict("172.17.0.2")).toBe("refuse");
    expect(filter.verdict("100.81.128.8")).toBe("refuse");
    expect(filter.verdict(undefined)).toBe("refuse");
    expect(await filter.admits("192.168.4.51")).toBe(false);
  });

  test("the first unknown peer loads the subnets; members are admitted, others refused", async () => {
    let loads = 0;
    const filter = new AgentToolsPeerFilter({
      loadSubnets: async () => {
        loads += 1;
        return ["172.17.0.0/16", "172.25.0.0/16", "fd00::/64", "garbage"];
      },
    });
    expect(filter.verdict("172.25.0.2")).toBe("reload");
    expect(await filter.admits("172.25.0.2")).toBe(true);
    expect(loads).toBe(1);
    expect(filter.allowedSubnets()).toEqual(["172.17.0.0/16", "172.25.0.0/16"]);
    expect(filter.verdict("::ffff:172.17.0.9")).toBe("admit");
    // Inside the interval, an outside peer is refused without reading Docker.
    expect(filter.verdict("192.168.4.51")).toBe("refuse");
    expect(await filter.admits("192.168.4.51")).toBe(false);
    expect(loads).toBe(1);
  });

  test("an unknown peer reloads at most once per interval", async () => {
    let now = 0;
    let loads = 0;
    const filter = new AgentToolsPeerFilter({
      now: () => now,
      loadSubnets: async () => {
        loads += 1;
        return loads >= 2 ? ["10.200.0.0/24"] : [];
      },
    });
    expect(await filter.admits("10.200.0.5")).toBe(false);
    now += MISS_RELOAD_INTERVAL_MS - 1;
    expect(await filter.admits("10.200.0.5")).toBe(false);
    expect(loads).toBe(1);
    now += 1;
    expect(await filter.admits("10.200.0.5")).toBe(true);
    expect(loads).toBe(2);
  });

  test("a reported network change makes the next unknown peer reload at once", async () => {
    let subnets = ["172.17.0.0/16"];
    let loads = 0;
    const filter = new AgentToolsPeerFilter({
      now: () => 0,
      loadSubnets: async () => {
        loads += 1;
        return subnets;
      },
    });
    const unfollow = filter.followNetworkChanges();
    try {
      expect(await filter.admits("172.17.0.2")).toBe(true);
      subnets = ["172.17.0.0/16", "172.30.0.0/16"];
      reportDockerNetworkChange();
      expect(await filter.admits("172.30.0.2")).toBe(true);
      expect(loads).toBe(2);
      // Removal shrinks the list the same way.
      subnets = ["172.17.0.0/16"];
      reportDockerNetworkChange();
      expect(await filter.admits("172.30.0.2")).toBe(false);
      expect(loads).toBe(3);
    } finally {
      unfollow();
    }
    // Unsubscribed: a change no longer reaches it.
    subnets = ["172.31.0.0/16"];
    reportDockerNetworkChange();
    expect(await filter.admits("172.31.0.2")).toBe(false);
    expect(loads).toBe(3);
  });

  test("a change reported once the list is loaded reloads eagerly, before any peer asks", async () => {
    let loads = 0;
    const filter = new AgentToolsPeerFilter({
      now: () => 0,
      loadSubnets: async () => {
        loads += 1;
        return ["172.17.0.0/16"];
      },
    });
    filter.networksChanged();
    expect(loads).toBe(0);
    await filter.reload();
    filter.networksChanged();
    expect(loads).toBe(2);
  });

  test("a change reported during a load is not lost: the peer waits for the next load", async () => {
    const first = deferred<string[]>();
    const answers = [first.promise, Promise.resolve(["172.40.0.0/16"])];
    const filter = new AgentToolsPeerFilter({
      now: () => 0,
      loadSubnets: () => answers.shift() ?? Promise.resolve(["172.40.0.0/16"]),
    });
    const pending = filter.admits("172.40.0.3");
    filter.networksChanged();
    first.resolve([]);
    expect(await pending).toBe(true);
  });

  test("concurrent unknown peers share one load", async () => {
    const gate = deferred<string[]>();
    let loads = 0;
    const filter = new AgentToolsPeerFilter({
      loadSubnets: () => {
        loads += 1;
        return gate.promise;
      },
    });
    const both = Promise.all([filter.admits("10.1.0.2"), filter.admits("10.9.0.2")]);
    gate.resolve(["10.1.0.0/16"]);
    expect(await both).toEqual([true, false]);
    expect(loads).toBe(1);
  });

  test("a failed read revokes the previous list and waits the interval before retrying", async () => {
    let now = 0;
    let fail = false;
    let loads = 0;
    const filter = new AgentToolsPeerFilter({
      now: () => now,
      loadSubnets: async () => {
        loads += 1;
        if (fail) throw new Error("docker unavailable");
        return ["172.17.0.0/16"];
      },
    });
    expect(await filter.admits("172.17.0.2")).toBe(true);
    fail = true;
    filter.networksChanged();
    await filter.reload();
    expect(filter.allowedSubnets()).toEqual([]);
    const loadsAfterFailure = loads;
    expect(await filter.admits("10.0.0.2")).toBe(false);
    expect(loads).toBe(loadsAfterFailure);
    now += MISS_RELOAD_INTERVAL_MS;
    expect(await filter.admits("10.0.0.2")).toBe(false);
    expect(loads).toBe(loadsAfterFailure + 1);
    // A null answer (Docker unreachable) is a failure too.
    const unreachable = new AgentToolsPeerFilter({ loadSubnets: async () => null });
    expect(await unreachable.admits("172.17.0.2")).toBe(false);
  });

  for (const failure of ["null", "throw"] as const) {
    test(`formerly allowed peers retry after a failed removal refresh (${failure})`, async () => {
      let now = 0;
      let loads = 0;
      const filter = new AgentToolsPeerFilter({
        now: () => now,
        loadSubnets: async () => {
          loads += 1;
          if (loads === 1) return ["10.1.0.0/24"];
          if (loads === 2) {
            if (failure === "throw") throw new Error("Docker unavailable");
            return null;
          }
          return [];
        },
      });
      expect(await filter.admits("10.1.0.2")).toBe(true);
      filter.networksChanged();
      expect(await filter.admits("10.1.0.2")).toBe(false);
      expect(filter.allowedSubnets()).toEqual([]);
      expect(loads).toBe(2);
      now = MISS_RELOAD_INTERVAL_MS - 1;
      expect(await filter.admits("10.1.0.2")).toBe(false);
      expect(loads).toBe(2);
      now += 1;
      expect(await filter.admits("10.1.0.2")).toBe(false);
      expect(loads).toBe(3);
    });
  }

  test("cached members refresh on expiry without requests from unknown peers", async () => {
    let now = 0;
    let subnets = ["10.1.0.0/24"];
    const filter = new AgentToolsPeerFilter({ now: () => now, loadSubnets: async () => subnets });
    expect(await filter.admits("10.1.0.2")).toBe(true);
    subnets = [];
    now = MISS_RELOAD_INTERVAL_MS;
    expect(filter.verdict("10.1.0.2")).toBe("reload");
    expect(await filter.admits("10.1.0.2")).toBe(false);
  });

  test("a cached member waits through every superseded refresh before removal is decided", async () => {
    const refreshes = [deferred<string[]>(), deferred<string[]>(), deferred<string[]>()];
    let loads = 0;
    const filter = new AgentToolsPeerFilter({
      now: () => 0,
      loadSubnets: () => {
        loads += 1;
        return loads === 1 ? Promise.resolve(["10.1.0.0/24"]) : refreshes[loads - 2]!.promise;
      },
    });
    expect(await filter.admits("10.1.0.2")).toBe(true);
    filter.networksChanged();
    let settled = false;
    const waiting = filter.admits("10.1.0.2").then((answer) => {
      settled = true;
      return answer;
    });
    for (const [index, refresh] of refreshes.entries()) {
      if (index < refreshes.length - 1) filter.networksChanged();
      refresh.resolve(index === refreshes.length - 1 ? [] : ["10.1.0.0/24"]);
      // Flush the async load and its finally/replacement callbacks.
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      if (index < refreshes.length - 1) {
        expect(settled).toBe(false);
        expect(filter.verdict("10.1.0.2")).toBe("reload");
      }
    }
    expect(await waiting).toBe(false);
    expect(loads).toBe(4);
  });

  test("refusals are logged at most once a minute", () => {
    let now = 0;
    const filter = new AgentToolsPeerFilter({ now: () => now });
    const internals = filter as unknown as { refusalsSinceLog: number };
    filter.recordRefusal("192.168.4.51");
    expect(internals.refusalsSinceLog).toBe(0);
    filter.recordRefusal("192.168.4.51");
    filter.recordRefusal("192.168.4.52");
    expect(internals.refusalsSinceLog).toBe(2);
    now += 60_000;
    filter.recordRefusal("192.168.4.51");
    expect(internals.refusalsSinceLog).toBe(0);
  });
});

describe("loadOwnedDockerSubnets", () => {
  test("reads the default bridge and every network labelled with the owner", async () => {
    const calls: string[][] = [];
    const run = (async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "ls")
        return { stdout: "aaaaaaaaaaaa\nbbbbbbbbbbbb\n\nnot an id\n", stderr: "" };
      const name = args.at(-1);
      if (name === "bridge") return { stdout: "172.17.0.0/16 \n", stderr: "" };
      if (name === "aaaaaaaaaaaa") return { stdout: "172.25.0.0/16 fd00:1::/64 \n", stderr: "" };
      throw new Error("Error: No such network: bbbbbbbbbbbb");
    }) as unknown as typeof runCommand;
    expect(await loadOwnedDockerSubnets("0123456789abcdef", run)).toEqual([
      "172.17.0.0/16",
      "172.25.0.0/16",
    ]);
    expect(calls[0]).toEqual([
      "network",
      "ls",
      "--filter",
      "label=orkestrator-owner=0123456789abcdef",
      "--format",
      "{{.ID}}",
    ]);
    expect(calls.slice(1).map((args) => args.at(-1))).toEqual([
      "bridge",
      "aaaaaaaaaaaa",
      "bbbbbbbbbbbb",
    ]);
  });

  test("is null when Docker cannot list networks", async () => {
    const run = (async () => {
      throw new Error("Cannot connect to the Docker daemon");
    }) as unknown as typeof runCommand;
    expect(await loadOwnedDockerSubnets("0123456789abcdef", run)).toBeNull();
  });
});
