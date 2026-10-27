import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as dockerImage from "../src/core/docker-image";
import { environmentInputStatus } from "../src/core/portable-input-status";
import { stagePortableInputs } from "../src/core/portable-inputs";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  dockerImage.resetDockerTopologyCache();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("rootless staged input status", () => {
  for (const scenario of [
    "old-image",
    "relay-image",
    "rootful",
    "inspect-failed",
    "manifest-missing",
    "manifest-failed",
  ] as const) {
    test(`${scenario} reports unreadable only for a known rootless image without the relay`, async () => {
      const dir = await tempDir("ork-input-status-");
      cleanup.push(dir);
      const environment = lifecycleEnvironment({ containerId: "existing" });
      const staged = await stagePortableInputs(dir, environment.id, new Set(), {
        home: dir,
        agentTest: false,
      });
      const { context } = memoryLifecycleContext([environment], dir);
      Object.assign(context.storage, {
        loadConfig: async () => ({ global: { enabledAgentPlatforms: [] } }),
      });
      const capabilities = spyOn(dockerImage, "imageCapabilities");
      if (scenario === "manifest-failed")
        capabilities.mockRejectedValue(new Error("manifest unavailable"));
      else
        capabilities.mockResolvedValue(
          scenario === "manifest-missing"
            ? null
            : { "staged-inputs": scenario === "relay-image" ? 3 : 2 },
        );
      try {
        await withDockerScript(
          `#!/bin/sh
case "$1" in
  info) echo '{"OSType":"linux","SecurityOptions":${scenario === "rootful" ? "[]" : '["name=rootless"]'}}' ;;
  inspect)
    case "$3" in
      *Labels*) echo '${staged.revision}' ;;
      *) ${scenario === "inspect-failed" ? "exit 1" : "echo sha256:fixture"} ;;
    esac ;;
  *) exit 1 ;;
esac
`,
          async () => {
            const status = await environmentInputStatus(environment.id, context);
            expect(status.mode).toBe("staged");
            expect(status.unreadableOnRootless ?? false).toBe(scenario === "old-image");
            expect(capabilities).toHaveBeenCalledTimes(
              scenario === "rootful" || scenario === "inspect-failed" ? 0 : 1,
            );
          },
        );
      } finally {
        capabilities.mockRestore();
      }
    });
  }
});
