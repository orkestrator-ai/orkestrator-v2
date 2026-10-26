import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_WORKSPACE_SETUP_COMMAND,
  CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE,
} from "./container-scripts.js";

// The image ships util-linux `flock`, and only its behaviour is the contract;
// other implementations (Homebrew's) differ. Without it these run on Linux only.
const hasFlock = /util-linux/.test(
  spawnSync("flock", ["--version"], { encoding: "utf8" }).stdout ?? "",
);
const LOCK = "/tmp/orkestrator-workspace-setup.lock";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** The setup command with the image's script replaced by `script` and its lock by `lock`. */
async function setupCommand(
  script: string,
): Promise<{ command: string; lock: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ork-setup-lock-"));
  dirs.push(dir);
  const setup = path.join(dir, "workspace-setup.sh");
  await fs.writeFile(setup, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const lock = path.join(dir, "setup.lock");
  return {
    command: CONTAINER_WORKSPACE_SETUP_COMMAND.replaceAll(
      "/usr/local/bin/workspace-setup.sh",
      setup,
    ).replaceAll(LOCK, lock),
    lock,
    dir,
  };
}

function run(command: string): Promise<{ code: number | null; output: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command]);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("close", (code) => resolve({ code, output, ms: Date.now() - started }));
  });
}

describe("container workspace setup command", () => {
  test("takes the image's lock and runs the image's script", () => {
    expect(CONTAINER_WORKSPACE_SETUP_COMMAND).toContain(
      `flock ${LOCK} -c '/usr/local/bin/workspace-setup.sh'`,
    );
    expect(CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE).not.toContain("'");
  });

  test.skipIf(!hasFlock)("runs setup at once when nothing holds the lock", async () => {
    const { command } = await setupCommand("echo ran; exit 3");
    const result = await run(command);
    expect(result.output).toBe("ran\n");
    expect(result.code).toBe(3);
  });

  test.skipIf(!hasFlock)(
    "waits for an orphaned run instead of starting a second one, and says so",
    async () => {
      const { command, lock, dir } = await setupCommand(
        `if [ -f "$(dirname "$0")/done" ]; then echo 'Workspace already set up.'; else echo ran; fi`,
      );
      // An earlier run whose terminal died: it still holds the lock, then
      // finishes setup successfully.
      const orphan = spawn("flock", [lock, "-c", `sleep 1; touch '${dir}/done'`]);
      const orphanClosed = new Promise((resolve) => orphan.on("close", resolve));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await run(command);
      await orphanClosed;
      expect(result.output).toBe(
        `${CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE}\nWorkspace already set up.\n`,
      );
      expect(result.code).toBe(0);
      expect(result.ms).toBeGreaterThanOrEqual(500);
    },
  );
});

test.skipIf(!hasFlock)("reruns setup after an orphan fails while holding the lock", async () => {
  const { command, lock, dir } = await setupCommand("echo reran; exit 0");
  const ready = path.join(dir, "orphan-ready");
  const release = path.join(dir, "release-orphan");
  const orphan = spawn("flock", [
    lock,
    "-c",
    `touch '${ready}'; while [ ! -f '${release}' ]; do sleep 0.02; done; exit 7`,
  ]);
  const orphanClosed = new Promise<number | null>((resolve) => orphan.on("close", resolve));
  try {
    const deadline = Date.now() + 2000;
    while (!(await fs.stat(ready).catch(() => null))) {
      if (Date.now() > deadline) throw new Error("orphan did not acquire setup lock");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const child = spawn("bash", ["-c", command]);
    let output = "";
    const waiting = new Promise<void>((resolve) =>
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE)) resolve();
      }),
    );
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    await waiting;
    expect(output).not.toContain("reran");
    await fs.writeFile(release, "");
    expect(await orphanClosed).toBe(7);
    expect(await closed).toBe(0);
    expect(output).toBe(`${CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE}\nreran\n`);
  } finally {
    await fs.writeFile(release, "");
    await orphanClosed;
  }
});
