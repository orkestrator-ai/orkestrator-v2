import { expect, mock, test } from "bun:test";
import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry } = await createCommandFixtures();
import type { CommandContext } from "./command-fixtures";
import { resetResourceCaches } from "../src/core/container-resources";
import { resetDockerTopologyCache } from "../src/core/docker-image";
import { withDockerScript } from "./container-lifecycle-fixtures";

for (const limits of [null, { cpus: null, memoryMiB: null, pids: null }]) {
  test(`global budget command preserves ${limits === null ? "clear" : "explicit unrestricted"} semantics`, async () => {
    const setter = mock(async () => ({}));
    const context = {
      storage: { setContainerResourceLimits: setter },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("set_container_resource_limits")!;
    expect(await command({ limits }, context)).toEqual({ limits });
    expect(setter).toHaveBeenCalledWith(limits ?? undefined);
  });
}

test("a global budget the daemon cannot enforce is saved and reported, not silently accepted", async () => {
  resetResourceCaches();
  resetDockerTopologyCache();
  const setter = mock(async () => ({}));
  const context = {
    storage: { setContainerResourceLimits: setter },
  } as unknown as CommandContext;
  const command = createCommandRegistry().get("set_container_resource_limits")!;
  // Rootless with only the memory controller delegated.
  const info = {
    ServerVersion: "29.9.2",
    OperatingSystem: "Alpine Linux v3.24",
    NCPU: 8,
    MemTotal: 16 * 1024 ** 3,
    CgroupVersion: "2",
    CgroupDriver: "systemd",
    CpuCfsQuota: false,
    MemoryLimit: true,
    PidsLimit: false,
    SecurityOptions: ["name=rootless", "name=cgroupns"],
  };
  try {
    await withDockerScript(
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '${JSON.stringify(info)}' ;;
  context) printf 'unix:///run/user/1000/docker.sock\\n' ;;
esac
exit 0
`,
      async () => {
        const limits = { cpus: 2, memoryMiB: 4096, pids: 1024 };
        expect(await command({ limits }, context)).toEqual({
          limits,
          unenforceable: ["cpus", "pids"],
        });
        // Still saved: the daemon may change, and Docker may be unreachable.
        expect(setter).toHaveBeenCalledWith(limits);
        expect(
          await command({ limits: { cpus: null, memoryMiB: 2048, pids: null } }, context),
        ).toEqual({ limits: { cpus: null, memoryMiB: 2048, pids: null } });
      },
    );
  } finally {
    resetResourceCaches();
    resetDockerTopologyCache();
  }
});
