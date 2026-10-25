import { expect, mock, test } from "bun:test";
import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry } = await createCommandFixtures();
import type { CommandContext } from "./command-fixtures";

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
