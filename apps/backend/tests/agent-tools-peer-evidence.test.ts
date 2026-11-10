import { describe, expect, test } from "bun:test";
import {
  cleanupEvidenceResources,
  daemonIsRootless,
  removeTrackedResources,
  startEvidenceListener,
} from "../scripts/agent-tools-peer-evidence-support.js";

describe("peer evidence resource ownership", () => {
  test("failed first removal does not lose IDs or prevent later cleanup; finalization retries before networks", async () => {
    const created = { containers: ["first", "second", "third"], networks: ["owned-network"] };
    const calls: string[][] = [];
    let failFirst = true;
    const docker = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rm" && args[2] === "first" && failFirst) {
        failFirst = false;
        throw new Error("removal timeout");
      }
    };
    await removeTrackedResources(created.containers, (id) => docker(["rm", "-f", id]));
    expect(created.containers).toEqual(["first"]);
    expect(calls).toEqual([
      ["rm", "-f", "first"],
      ["rm", "-f", "second"],
      ["rm", "-f", "third"],
    ]);
    expect(await cleanupEvidenceResources(created, docker)).toEqual({
      containers: [],
      networks: [],
    });
    expect(calls.slice(3)).toEqual([
      ["rm", "-f", "first"],
      ["network", "rm", "owned-network"],
    ]);
    expect(created).toEqual({ containers: [], networks: [] });
  });

  test("permanent failures remain tracked and are reported while other removals continue", async () => {
    const created = { containers: ["stuck", "removed"], networks: ["attached", "free"] };
    const calls: string[][] = [];
    const unresolved = await cleanupEvidenceResources(created, async (args) => {
      calls.push(args);
      if (args.includes("stuck") || args.includes("attached"))
        throw new Error("Docker unavailable");
    });
    expect(calls).toHaveLength(4);
    expect(unresolved).toEqual({ containers: ["stuck"], networks: ["attached"] });
    expect(created).toEqual(unresolved);
  });
});

describe("peer evidence listener", () => {
  test("skips forbidden/ephemeral candidates before listen and retries occupied permitted ports", async () => {
    const candidates = [0, 34121, 34122, 52000, 52001];
    const listened: number[] = [];
    await startEvidenceListener(
      async (port) => {
        listened.push(port);
        if (port === 52000) throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
      },
      () => candidates.shift()!,
    );
    expect(listened).toEqual([52000, 52001]);
  });

  test("bounds retries without ever binding a reserved port", async () => {
    let calls = 0;
    await expect(
      startEvidenceListener(
        async () => {
          calls += 1;
        },
        () => 34121,
      ),
    ).rejects.toThrow("32 candidates");
    expect(calls).toBe(0);
  });

  test("propagates listener failures other than address-in-use", async () => {
    await expect(
      startEvidenceListener(
        async () => {
          throw new Error("denied");
        },
        () => 52000,
      ),
    ).rejects.toThrow("denied");
  });
});

describe("peer evidence daemon topology", () => {
  test("names a rootless daemon from docker info's security options", () => {
    // Captured from a disposable rootless daemon (Docker 29.9.2) on 2026-11-09.
    expect(
      daemonIsRootless('["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]\n'),
    ).toBe(true);
    expect(daemonIsRootless('["rootless"]')).toBe(true);
  });

  test("a rootful, empty or unexpected answer is not rootless", () => {
    expect(daemonIsRootless('["name=seccomp,profile=builtin","name=cgroupns"]')).toBe(false);
    expect(daemonIsRootless('["name=rootlessish"]')).toBe(false);
    expect(daemonIsRootless("null")).toBe(false);
    expect(daemonIsRootless("")).toBe(false);
    expect(daemonIsRootless('{"rootless":true}')).toBe(false);
  });
});
