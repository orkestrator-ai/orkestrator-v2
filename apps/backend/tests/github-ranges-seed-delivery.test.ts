import { describe, expect, test } from "bun:test";
import {
  deliverGithubRangesSeedBeforeBoot,
  parseSeedConsumer,
  type SeedDeliveryDependencies,
} from "../src/core/github-ranges-seed-delivery";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";

// What `docker inspect` prints for the delivery's format: the restricted
// marker, the resource role, the gateway a workload joins and the mounts.
const GATEWAY_BOUND = "restricted\tegress-gateway\t\t/run;/etc/orkestrator-seed;\n";
const GATEWAY_LEGACY = "restricted\tegress-gateway\t\t/run;\n";
const RUNTIME_IN_CONTAINER_BOUND = "restricted\t\t\t/workspace;/etc/orkestrator-seed;\n";
const RUNTIME_IN_CONTAINER_LEGACY = "restricted\t<no value>\t<no value>\t/workspace;\n";
const RUNTIME_BEHIND_GATEWAY = "restricted\t\tork-env-egress\t/workspace;\n";
const RUNTIME_FULL = "\t\t\t/workspace;\n";

describe("which containers take the GitHub ranges seed", () => {
  test("only a gateway or a restricted runtime without one runs the firewall", () => {
    expect(parseSeedConsumer(GATEWAY_BOUND)).toEqual({ firewall: true, bound: true });
    expect(parseSeedConsumer(GATEWAY_LEGACY)).toEqual({ firewall: true, bound: false });
    expect(parseSeedConsumer(RUNTIME_IN_CONTAINER_BOUND)).toEqual({ firewall: true, bound: true });
    expect(parseSeedConsumer(RUNTIME_IN_CONTAINER_LEGACY)).toEqual({
      firewall: true,
      bound: false,
    });
    expect(parseSeedConsumer(RUNTIME_BEHIND_GATEWAY)?.firewall).toBe(false);
    expect(parseSeedConsumer(RUNTIME_FULL)?.firewall).toBe(false);
    // A mount below the seed directory is not the seed bind.
    expect(parseSeedConsumer("restricted\t\t\t/etc/orkestrator-seed/x;\n")?.bound).toBe(false);
    // Anything else is not this format's answer.
    expect(parseSeedConsumer("false\n")).toBeNull();
    expect(parseSeedConsumer("a\tb\tc\td\ne\tf\tg\th\n")).toBeNull();
  });
});

function fakes(inspect: string | Error, options: { seed?: string | null; copy?: boolean } = {}) {
  const calls = { inspect: [] as string[][], seed: [] as string[], copy: [] as string[][] };
  const dependencies: SeedDeliveryDependencies = {
    run: (async (_command: string, args: string[] = []) => {
      calls.inspect.push(args);
      if (inspect instanceof Error) throw inspect;
      return { stdout: inspect, stderr: "" };
    }) as unknown as SeedDeliveryDependencies["run"],
    seed: async (dataDir) => {
      calls.seed.push(dataDir);
      return options.seed === undefined ? "/data/github-ranges-seed/github-ranges" : options.seed;
    },
    copy: async (containerId, seedFile) => {
      calls.copy.push([containerId, seedFile]);
      return options.copy ?? true;
    },
  };
  return { calls, dependencies };
}

describe("a fresh seed before each boot", () => {
  test("a container that binds the directory is refreshed in place and nothing is copied", async () => {
    for (const inspect of [GATEWAY_BOUND, RUNTIME_IN_CONTAINER_BOUND]) {
      const { calls, dependencies } = fakes(inspect);
      expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", dependencies)).toBe(
        "bound",
      );
      expect(calls.seed).toEqual(["/data"]);
      expect(calls.copy).toEqual([]);
      expect(calls.inspect[0]?.at(-1)).toBe("abc123");
    }
    // Even with no seed to offer: the firewall then fetches, as it always could.
    const { dependencies } = fakes(GATEWAY_BOUND, { seed: null });
    expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", dependencies)).toBe("bound");
  });

  test("a container created before the bind gets a new copy of the refreshed seed", async () => {
    for (const inspect of [GATEWAY_LEGACY, RUNTIME_IN_CONTAINER_LEGACY]) {
      const { calls, dependencies } = fakes(inspect);
      const logs = captureLogs();
      try {
        expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", dependencies)).toBe(
          "copied",
        );
      } finally {
        logs.restore();
      }
      expect(calls.copy).toEqual([["abc123", "/data/github-ranges-seed/github-ranges"]]);
      expect(logs.records()).toMatchObject([{ event: "github-ranges.seed-copied-before-boot" }]);
    }
    const refused = fakes(GATEWAY_LEGACY, { copy: false });
    expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", refused.dependencies)).toBe(
      "not-copied",
    );
    const none = fakes(GATEWAY_LEGACY, { seed: null });
    expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", none.dependencies)).toBe(
      "no-seed",
    );
    expect(none.calls.copy).toEqual([]);
  });

  test("containers without a firewall cost no fetch, and a failed inspect is left to the start", async () => {
    for (const inspect of [RUNTIME_BEHIND_GATEWAY, RUNTIME_FULL]) {
      const { calls, dependencies } = fakes(inspect);
      expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", dependencies)).toBe(
        "not-firewall",
      );
      expect(calls.seed).toEqual([]);
      expect(calls.copy).toEqual([]);
    }
    for (const inspect of [new Error("No such container"), "false\n"]) {
      const { calls, dependencies } = fakes(inspect);
      expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", dependencies)).toBe(
        "inspect-failed",
      );
      expect(calls.seed).toEqual([]);
    }
  });

  test("a seed lookup or copy that throws never fails the boot", async () => {
    const { dependencies } = fakes(GATEWAY_LEGACY);
    dependencies.seed = async () => {
      throw new Error("disk full");
    };
    expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", dependencies)).toBe(
      "no-seed",
    );
    const throwing = fakes(GATEWAY_LEGACY);
    throwing.dependencies.copy = async () => {
      throw new Error("daemon gone");
    };
    expect(await deliverGithubRangesSeedBeforeBoot("/data", "abc123", throwing.dependencies)).toBe(
      "not-copied",
    );
  });
});
