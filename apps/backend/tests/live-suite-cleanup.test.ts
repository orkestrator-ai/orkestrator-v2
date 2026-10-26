import { describe, expect, test } from "bun:test";
import { removeLabelledResources } from "./container-live-cleanup";

/** An in-memory daemon that, like Docker Desktop 4.95 under load, 404s a multi-argument removal. */
function fakeDocker(resources: Record<"container" | "volume" | "network", string[]>, stuck = "") {
  const calls: string[][] = [];
  const kindOf = (args: string[]) =>
    args[0] === "volume" ? "volume" : args[0] === "network" ? "network" : "container";
  const docker = async (args: string[]): Promise<string> => {
    calls.push(args);
    const kind = kindOf(args);
    if (args.includes("-q") || args.includes("-aq")) return resources[kind].join("\n");
    const ids = args.slice(2);
    if (ids.length !== 1) throw new Error("Error response from daemon: 404 page not found");
    if (ids[0] === stuck) throw new Error("Error response from daemon: volume is in use");
    resources[kind] = resources[kind].filter((id) => id !== ids[0]);
    return "";
  };
  return { docker, calls };
}

describe("live-suite cleanup", () => {
  test("removes each labelled resource with its own call, containers first", async () => {
    const { docker, calls } = fakeDocker({
      container: ["c1", "c2"],
      volume: ["v1"],
      network: ["n1"],
    });
    expect(await removeLabelledResources(docker, ["label=orkestrator-owner=x"])).toEqual([]);
    const removals = calls.filter((args) => args.includes("rm") && !args.includes("-q"));
    expect(removals).toEqual([
      ["rm", "-f", "c1"],
      ["rm", "-f", "c2"],
      ["volume", "rm", "v1"],
      ["network", "rm", "n1"],
    ]);
    expect(
      calls
        .filter((args) => args.includes("--filter"))
        .every((args) => args.at(-1) === "label=orkestrator-owner=x"),
    ).toBe(true);
  });

  test("reports what it could not remove instead of leaking it silently", async () => {
    const { docker } = fakeDocker({ container: [], volume: ["v1", "v2"], network: [] }, "v2");
    expect(await removeLabelledResources(docker, ["label=a"])).toEqual(["volume v2"]);
    expect(
      await removeLabelledResources(async () => Promise.reject(new Error("down")), ["label=a"]),
    ).toEqual(["container unlisted", "volume unlisted", "network unlisted"]);
  });

  test("touches nothing without a filter", async () => {
    const { docker, calls } = fakeDocker({ container: ["c1"], volume: [], network: [] });
    expect(await removeLabelledResources(docker, [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
