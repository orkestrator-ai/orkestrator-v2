import { expect, mock, test } from "bun:test";
import { openCodeEnvironmentListenerRecheck } from "./opencode-environment-listener.js";
import type { StorageService } from "./storage.js";
import type { Environment } from "./models.js";

test("only checks a current container, never a local or missing environment", async () => {
  let environment: Partial<Environment> | null = null;
  const getEnvironment = mock(async () => environment as Environment | null);
  const recheck = mock(async (_id: string, _kind: "opencode" | "opencode2") => "ours" as const);
  const check = openCodeEnvironmentListenerRecheck(
    { getEnvironment } as Pick<StorageService, "getEnvironment">,
    recheck,
  );
  for (const value of [
    null,
    { environmentType: "local", containerId: "old" },
    { environmentType: "containerized" },
    { environmentType: "containerized", containerId: " " },
  ] as Array<Partial<Environment> | null>) {
    environment = value;
    await expect(check("env-1")).resolves.toBeUndefined();
  }
  expect(recheck).not.toHaveBeenCalled();
  environment = { environmentType: "containerized", containerId: " container-1 " };
  await expect(check("env-1")).resolves.toBe("ours");
  expect(recheck).toHaveBeenLastCalledWith("container-1", "opencode");
  environment.containerId = "container-2";
  await check("env-1");
  expect(recheck).toHaveBeenLastCalledWith("container-2", "opencode");
  getEnvironment.mockRejectedValueOnce(new Error("unavailable"));
  await expect(check("env-1")).resolves.toBeUndefined();
  expect(recheck).toHaveBeenCalledTimes(2);
});
