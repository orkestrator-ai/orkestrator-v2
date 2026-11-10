import { describe, expect, test } from "bun:test";
import { cleanupEvidenceContainers } from "../scripts/rootless-budget-evidence-cleanup";

describe("budget evidence cleanup", () => {
  const label = "orkestrator-s0019-budget-evidence=this-run";

  function daemon(containers: Map<string, string>, removeFails = false, listFails = false) {
    const calls: string[][] = [];
    const docker = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "ps") {
        expect(args).toEqual(["ps", "-aq", "--filter", `label=${label}`]);
        return {
          ok: !listFails,
          stdout: listFails
            ? ""
            : Array.from(containers)
                .filter(([, owner]) => owner === label)
                .map(([id]) => id)
                .join("\n"),
          stderr: listFails ? "daemon unavailable" : "",
        };
      }
      expect(args.slice(0, 2)).toEqual(["rm", "-f"]);
      const id = args[2]!;
      expect(containers.get(id)).toBe(label);
      if (!removeFails) containers.delete(id);
      return { ok: !removeFails, stdout: "", stderr: removeFails ? "removal failed" : "" };
    };
    return { docker, calls };
  }

  test("removes a created container after startup fails without a returned id", async () => {
    // docker run created this resource, then failed before returning a usable id.
    const containers = new Map([
      ["failed-start", label],
      ["running-probe", label],
      ["another-run", "orkestrator-s0019-budget-evidence=other-run"],
      ["unrelated", ""],
    ]);
    const { docker } = daemon(containers);
    expect(await cleanupEvidenceContainers(docker, label)).toEqual({
      unresolvedCleanup: [],
      leftovers: "",
    });
    expect(Array.from(containers.keys())).toEqual(["another-run", "unrelated"]);
  });

  test("tolerates creation failure leaving no container", async () => {
    const { docker, calls } = daemon(new Map([["unrelated", "other-owner"]]));
    expect(await cleanupEvidenceContainers(docker, label)).toEqual({
      unresolvedCleanup: [],
      leftovers: "",
    });
    expect(calls.every((args) => args[0] === "ps")).toBe(true);
  });

  test("reports removal failures and recomputes leftovers", async () => {
    const { docker } = daemon(new Map([["failed-start", label]]), true);
    expect(await cleanupEvidenceContainers(docker, label)).toEqual({
      unresolvedCleanup: ["failed-start"],
      leftovers: "failed-start",
    });
  });

  test("reports discovery failure instead of claiming there are no leftovers", async () => {
    const { docker, calls } = daemon(new Map(), false, true);
    expect(await cleanupEvidenceContainers(docker, label)).toEqual({
      unresolvedCleanup: [],
      leftovers: "",
      cleanupError: "daemon unavailable",
    });
    expect(calls).toHaveLength(1);
  });
});
