import { expect, test } from "bun:test";
import { createForeignOwnerDecoys, DockerClient } from "../scenarios/docker-decoys.js";
import { RunManifest, type ScenarioContext } from "../scenarios/harness.js";
import { runOne } from "../scripts/run-scenarios.js";
import { scenarioOptions, scenarioRuntime } from "./support/scenario-runner.js";

const labels = ["--label", "environment-id=ours", "--label", "orkestrator-owner=foreign"];
const name = "foreign-decoy";

/** Script Docker's resource state, including the protection that hid volume regressions. */
function fixture() {
  const volumes = new Set<string>();
  let container: string | undefined;
  let mounted: string | undefined;
  const calls: string[][] = [];
  type Result = {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
  let intercept: (args: string[]) => Result | undefined = () => undefined;
  const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "" });
  const fail = (stderr: string): Result => ({ status: 1, stdout: "", stderr });
  const client = new DockerClient((args) => {
    calls.push(args);
    const intercepted = intercept(args);
    if (intercepted) return intercepted;
    const id = args.at(-1)!;
    if (args[0] === "volume" && args[1] === "create") {
      volumes.add(id);
      return ok(id);
    }
    if (args[0] === "create") {
      container = "container-id";
      mounted = args[args.indexOf("--mount") + 1]!.split("source=")[1]!.split(",")[0];
      return ok(container);
    }
    if (args[0] === "rm") {
      if (!container) return fail(`Error response from daemon: No such container: ${id}`);
      container = undefined;
      return ok(id);
    }
    if (args[0] === "volume" && args[1] === "rm") {
      if (!volumes.has(id)) return fail(`Error response from daemon: remove ${id}: no such volume`);
      if (container && mounted === id) return fail("volume is in use");
      volumes.delete(id);
      return ok(id);
    }
    if (args[1] === "inspect") {
      if (args[0] === "container")
        return container
          ? ok('created never never 0 {"orkestrator-owner":"foreign"}')
          : fail(`Error response from daemon: No such container: ${id}`);
      return volumes.has(id)
        ? ok('{"orkestrator-owner":"foreign"}')
        : fail(`Error response from daemon: get ${id}: no such volume`);
    }
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const context: Pick<ScenarioContext, "cleanup"> = { cleanup: [] };
  return {
    context,
    client,
    calls,
    volumes,
    setIntercept(value: typeof intercept) {
      intercept = value;
    },
    create(target = context) {
      return createForeignOwnerDecoys(target, labels, name, "test:owned", client);
    },
    clear() {
      container = undefined;
      volumes.clear();
    },
  };
}

test("unmounted volume negative control detects an ownership regression without in-use protection", () => {
  const docker = fixture();
  const decoys = docker.create();
  expect(docker.volumes.size).toBe(2);
  decoys.assertUnchanged("start");
  // Docker would refuse deletion of the mounted volume, masking an ownership bug.
  expect(() => docker.client.remove("volume", name)).toThrow("volume is in use");
  decoys.assertUnchanged("mounted deletion refused");
  // The otherwise identically labelled unmounted volume has no such protection.
  docker.client.remove("volume", `${name}-unmounted`);
  expect(() => decoys.assertUnchanged("delete")).toThrow("no such volume");
});

for (const type of ["container", "volume"] as const) {
  for (const failure of ["nonzero", "timeout"] as const) {
    test(`${type} cleanup ${failure} fails the scenario and records cleanupErrors`, async () => {
      const docker = fixture();
      const runtime = scenarioRuntime();
      const manifest = new RunManifest(null);
      docker.setIntercept((args) => {
        if (type === "container" ? args[0] !== "rm" : !(args[0] === "volume" && args[1] === "rm"))
          return;
        return failure === "timeout"
          ? { status: null, stdout: "", stderr: "", error: new Error("ETIMEDOUT") }
          : { status: 1, stdout: "", stderr: "permission denied" };
      });
      const result = await runOne(
        {
          name: "foreign-owner",
          description: "controlled Docker",
          async run(context) {
            docker.create(context).assertUnchanged("delete");
          },
        },
        scenarioOptions,
        manifest,
        runtime.dependencies,
      );
      const error = result.cleanupErrors.find((entry) => entry.startsWith(`remove decoy ${type}`));
      expect(result.passed).toBe(false);
      expect(result.error).toBeUndefined();
      expect(error).toContain(failure === "timeout" ? "ETIMEDOUT" : "permission denied");
      expect(manifest.cleanupErrors).toContain(`foreign-owner: ${error}`);
      // Every callback still runs, including the unmounted volume after a container failure.
      expect(docker.calls.filter((args) => args[0] === "volume" && args[1] === "rm")).toHaveLength(
        2,
      );
      expect(runtime.stopped).toEqual(runtime.roots);
      expect(runtime.removed).toEqual(runtime.roots);
    });
  }
}

for (const alreadyAbsent of [false, true]) {
  test(`verified cleanup passes with resources ${alreadyAbsent ? "already absent" : "present"}`, async () => {
    const docker = fixture();
    const runtime = scenarioRuntime();
    const result = await runOne(
      {
        name: "foreign-owner",
        description: "controlled Docker",
        async run(context) {
          docker.create(context);
          if (alreadyAbsent) docker.clear();
        },
      },
      scenarioOptions,
      new RunManifest(null),
      runtime.dependencies,
    );
    expect(result.passed).toBe(true);
    expect(result.cleanupErrors).toEqual([]);
    expect(docker.volumes.size).toBe(0);
    const inspections = docker.calls.filter((args) => args[1] === "inspect" && args.length === 3);
    expect(inspections).toEqual([
      ["container", "inspect", "container-id"],
      ["volume", "inspect", name],
      ["volume", "inspect", `${name}-unmounted`],
    ]);
  });
}

for (const type of ["container", "volume"] as const) {
  test(`${type} cleanup detects a successful rm that left the resource behind`, () => {
    const docker = fixture();
    docker.create();
    docker.setIntercept((args) => {
      if (args[0] === "rm" || (args[0] === "volume" && args[1] === "rm"))
        return { status: 0, stdout: "", stderr: "" };
    });
    expect(() => docker.client.remove(type, type === "container" ? "container-id" : name)).toThrow(
      "still exists after removal",
    );
  });

  test(`${type} cleanup propagates inspection errors instead of treating them as absence`, () => {
    const docker = fixture();
    docker.create();
    docker.setIntercept((args) => {
      if (args[0] === "rm" || (args[0] === "volume" && args[1] === "rm"))
        return { status: 0, stdout: "", stderr: "" };
      if (args[1] === "inspect") return { status: 1, stdout: "", stderr: "daemon unavailable" };
    });
    expect(() => docker.client.remove(type, type === "container" ? "container-id" : name)).toThrow(
      "daemon unavailable",
    );
  });
}

test("a missing-resource response for another ID is a cleanup failure", () => {
  const docker = new DockerClient(() => ({
    status: 1,
    stdout: "",
    stderr: "Error response from daemon: No such container: somebody-else",
  }));
  expect(() => docker.remove("container", "ours")).toThrow("somebody-else");
});
