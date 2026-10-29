import { afterEach, expect, test } from "bun:test";
import {
  egressGatewayOf,
  rememberNetworkOwner,
  resetNetworkOwnerCache,
} from "./container-network-owner.js";
import { withDockerScript } from "../../tests/container-lifecycle-fixtures.js";

afterEach(resetNetworkOwnerCache);

test("updating an owner at capacity retains other entries; a new key evicts only the oldest", async () => {
  resetNetworkOwnerCache();
  for (let index = 0; index < 512; index += 1) rememberNetworkOwner(`workload-${index}`, "gateway");
  rememberNetworkOwner("workload-256", "updated-gateway");
  await withDockerScript(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'bridge\\n'
`,
    async (log) => {
      for (let index = 0; index < 512; index += 1) {
        expect(await egressGatewayOf(`workload-${index}`)).toBe(
          index === 256 ? "updated-gateway" : "gateway",
        );
      }
      expect(await log.read()).toBe("");
      rememberNetworkOwner("new-workload", null);
      expect(await egressGatewayOf("new-workload")).toBeNull();
      expect(await egressGatewayOf("workload-1")).toBe("gateway");
      expect(await egressGatewayOf("workload-0")).toBeNull();
      const calls = (await log.read()).trim().split("\n");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("{{.HostConfig.NetworkMode}} workload-0");
    },
  );
});
