import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BRIDGE_TEST_TIMEOUT_MS,
  children,
  cleanupTrackedResources,
  temporaryDirectory,
  waitForExit,
} from "./acp-test-harness";

describe("ACP test harness child tracking", () => {
  test(
    "awaits and deregisters live and already-exited children before deleting fixtures",
    async () => {
      const liveDirectory = await temporaryDirectory();
      const readyPath = resolve(liveDirectory, "ready");
      const exitPath = resolve(liveDirectory, "exited");
      const live = spawn(
        process.execPath,
        [
          "-e",
          `await Bun.write(process.env.HARNESS_READY_PATH, "ready");
process.on("SIGTERM", async () => {
  try {
    await Bun.write(process.env.HARNESS_EXIT_PATH, "exited");
    process.exit(0);
  } catch {
    process.exit(1);
  }
});
setInterval(() => {}, 1_000);`,
        ],
        {
          env: {
            ...process.env,
            HARNESS_EXIT_PATH: exitPath,
            HARNESS_READY_PATH: readyPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.add(live);
      while (
        !(await access(readyPath).then(
          () => true,
          () => false,
        ))
      ) {
        await Bun.sleep(5);
      }

      await cleanupTrackedResources();
      expect(live.exitCode).toBe(0);
      expect(children.has(live)).toBe(false);
      await expect(access(liveDirectory)).rejects.toThrow();

      const settledDirectory = await temporaryDirectory();
      const settled = spawn(process.execPath, ["-e", ""], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(settled);
      await waitForExit(settled);
      expect(children.has(settled)).toBe(true);

      await cleanupTrackedResources();
      expect(children.has(settled)).toBe(false);
      await expect(access(settledDirectory)).rejects.toThrow();
    },
    BRIDGE_TEST_TIMEOUT_MS,
  );
});
