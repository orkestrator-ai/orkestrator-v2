import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseLogRecordLine } from "@orkestrator/protocol/logger";

describe("backend entrypoint logging", () => {
  test.each([
    { supervised: true, requestedFormat: "text", expectedFormat: "json" },
    { supervised: true, requestedFormat: "json", expectedFormat: "json" },
    { supervised: false, requestedFormat: "text", expectedFormat: "text" },
    { supervised: false, requestedFormat: "json", expectedFormat: "json" },
  ])(
    "configures the real entrypoint before clearing supervision (%j)",
    async ({ supervised, requestedFormat, expectedFormat }) => {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-main-logging-"));
      try {
        await writeFile(
          path.join(dataDir, "config.json"),
          JSON.stringify({ global: { debugLogging: true } }),
        );
        // Import the actual main.ts in a child so its logger and module mocks
        // cannot affect other suites. Stop at the SSH setup boundary, after the
        // real standalone logging installer and before backend construction,
        // listeners, provider discovery or any persistent application work.
        const source = `
        import { mock } from "bun:test";
        import { createLogger } from "@orkestrator/protocol/logger";
        const boundary = new Error("logging startup boundary");
        mock.module("./core/fix-path.ts", () => ({ fixPath() {} }));
        mock.module("./ssh-agent-socket.ts", () => ({
          configureSshAgentSocketEnvironment() {
            if (process.env.ORKESTRATOR_DESKTOP_SUPERVISED !== undefined) {
              throw new Error("supervision flag reached child-process setup");
            }
            const log = createLogger("updater");
            log.warn("check.failed", { attempt: 2 });
            log.debug("downloaded", { version: "visible" });
            createLogger("desktop").info("saved-machines.attached", { count: 1 });
            throw boundary;
          },
        }));
        process.argv = [process.execPath, "main.ts", "--data-dir", ${JSON.stringify(dataDir)},
          "--runtime-flavor", ${JSON.stringify(supervised ? "production" : "agent-test")},
          "--port", "0", "--control-port", "0", "--loopback-client-port", "0"];
        let stopped = false;
        try { await import("./main.ts"); }
        catch (error) { if (error !== boundary) throw error; stopped = true; }
        if (!stopped) throw new Error("startup boundary was not reached");
        await Promise.all([
          new Promise(resolve => process.stdout.write("", resolve)),
          new Promise(resolve => process.stderr.write("", resolve)),
        ]);
      `;
        const child = spawnSync(process.execPath, ["--no-env-file", "--eval", source], {
          cwd: import.meta.dir,
          // An explicit environment keeps production connection credentials and
          // agent-test launchers' logging filters out of this wiring check.
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            ORKESTRATOR_LOG_FORMAT: requestedFormat,
            ORKESTRATOR_LOG_LEVEL: "error,updater=debug",
            ...(supervised ? { ORKESTRATOR_DESKTOP_SUPERVISED: "1" } : {}),
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 20_000,
          maxBuffer: 64 * 1024,
        });
        if (child.error) throw child.error;
        if (child.status !== 0)
          throw new Error(`Entrypoint exited ${child.status}: ${child.stderr}`);
        const output = child.stdout + child.stderr;
        const lines = output.trim().split("\n");
        expect(output).not.toContain("saved-machines.attached");
        if (expectedFormat === "json") {
          const records = lines.flatMap((line) => {
            const record = parseLogRecordLine(line);
            return record ? [record] : [];
          });
          expect(records).toContainEqual(
            expect.objectContaining({
              level: "debug",
              area: "updater",
              event: "downloaded",
              fields: { version: "visible" },
            }),
          );
          expect(records).toContainEqual(
            expect.objectContaining({
              level: "warn",
              area: "updater",
              event: "check.failed",
              fields: { attempt: 2 },
            }),
          );
        } else {
          expect(lines).toContain("[updater] downloaded version=visible");
          expect(lines).toContain("[updater] check.failed attempt=2");
          expect(lines.some((line) => parseLogRecordLine(line))).toBe(false);
        }
        // A supervised production backend must not tee a duplicate file even
        // when the persisted setting enables logging.
        expect(await readdir(dataDir)).not.toContain("logs");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
