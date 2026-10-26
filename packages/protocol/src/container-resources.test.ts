import { describe, expect, test } from "bun:test";
import { unenforceableAxes } from "./container-resources";

describe("unenforceableAxes", () => {
  const limits = { cpus: 2, memoryMiB: 4096, pids: null };

  test("names only set axes the daemon cannot enforce", () => {
    expect(
      unenforceableAxes(limits, {
        rootless: false,
        support: { cpuQuota: false, memoryLimit: true, pidsLimit: false },
      }),
    ).toEqual(["cpus"]);
    expect(
      unenforceableAxes(limits, {
        rootless: false,
        support: { cpuQuota: true, memoryLimit: true, pidsLimit: true },
      }),
    ).toEqual([]);
  });

  test("unknown support is trusted except on a rootless daemon", () => {
    const unknown = { cpuQuota: null, memoryLimit: null, pidsLimit: null };
    expect(unenforceableAxes(limits, { rootless: false, support: unknown })).toEqual([]);
    expect(unenforceableAxes(limits, { rootless: true, support: unknown })).toEqual([
      "cpus",
      "memoryMiB",
    ]);
  });
});
