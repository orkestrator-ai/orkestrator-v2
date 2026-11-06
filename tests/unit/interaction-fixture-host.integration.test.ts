import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startInteractionFixtureHost,
  stopInteractionFixtureHost,
} from "../../e2e/interaction-fixture-host";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function script(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "interaction-lifecycle-test-"));
  directories.push(directory);
  const file = join(directory, "host.ts");
  writeFileSync(file, source);
  return { file, directory };
}

test("readiness timeout stops a delayed host and its fake provider, removing their temp files", async () => {
  const { file, directory } = script(`
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env.RECORD!, JSON.stringify({ directory: process.env.TMPDIR!, providerPid: provider.pid }));
    process.on("SIGTERM", () => { provider.kill("SIGTERM"); process.exit(0); });
    setTimeout(() => console.log("INTERACTION_FIXTURE_READY:1234"), 60_000);
  `);
  const record = join(directory, "tempdir");
  await expect(startInteractionFixtureHost(file, { RECORD: record }, 1000)).rejects.toThrow(
    "startup timed out",
  );
  const recorded = JSON.parse(readFileSync(record, "utf8")) as {
    directory: string;
    providerPid: number;
  };
  expect(existsSync(recorded.directory)).toBe(false);
  const providerRunning = () => {
    try {
      const state = execFileSync("ps", ["-p", String(recorded.providerPid), "-o", "stat="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return Boolean(state) && !state.startsWith("Z");
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false;
      throw error;
    }
  };
  for (let attempt = 0; attempt < 20 && providerRunning(); attempt++) await Bun.sleep(25);
  expect(providerRunning()).toBe(false);
}, 10_000);

test("cleanup completes when a host has already exited by signal", async () => {
  const { file } = script(
    `console.log("INTERACTION_FIXTURE_READY:1234"); setInterval(() => {}, 1000);`,
  );
  const host = await startInteractionFixtureHost(file);
  try {
    const exited = new Promise<void>((resolve) => host.process.once("exit", () => resolve()));
    host.process.kill("SIGKILL");
    await exited;
    expect(host.process.exitCode).toBeNull();
    expect(host.process.signalCode).toBe("SIGKILL");
    await stopInteractionFixtureHost(host, 100);
    expect(existsSync(host.directory)).toBe(false);
  } finally {
    await stopInteractionFixtureHost(host, 100);
  }
});

test("cleanup force-stops a host that ignores SIGTERM", async () => {
  const { file } = script(
    `process.on("SIGTERM", () => {}); console.log("INTERACTION_FIXTURE_READY:1234"); setInterval(() => {}, 1000);`,
  );
  const host = await startInteractionFixtureHost(file);
  await stopInteractionFixtureHost(host, 100);
  expect(host.process.signalCode).toBe("SIGKILL");
  expect(existsSync(host.directory)).toBe(false);
});
