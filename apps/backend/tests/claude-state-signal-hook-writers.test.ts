/**
 * The container hook writer, docker/orkestrator-state-signal.sh, run for real:
 * twenty concurrent `sh` writers serialize on the snapshot lock, and a writer
 * that cannot take a lock another process holds skips its write. Real
 * processes contending for a lock depend on how busy the host is, so the file
 * is in the slow tier; the rest of the state signal is in
 * claude-state-signal-integration.test.ts.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../docker/orkestrator-state-signal.sh");

// Real `sh` writers contend for a lock; under an aggregate's load twenty of
// them take well over Bun's generic five seconds.
setDefaultTimeout(30_000);

test("hook writers serialize counters and retain a completed turn without any config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ork-state-counters-"));
  const stateFile = join(dir, "state");
  const env = {
    ...process.env,
    ORKESTRATOR_STATE_FILE: stateFile,
    ORKESTRATOR_STATE_SIGNAL_CONFIG: join(dir, "absent"),
    // The script's one-second lock deadline skips a write, by design, when
    // the lock is held that long. Twenty writers take ~80 ms unloaded but
    // over a second under an aggregate suite's load, which is what this
    // test used to fail on (flake 1102). Serialization is the property here.
    ORKESTRATOR_STATE_LOCK_WAIT: "60",
  };
  try {
    const writers = Array.from({ length: 20 }, () =>
      Bun.spawn(["sh", SCRIPT, "working"], { env, stdout: "pipe", stderr: "pipe" }),
    );
    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual(Array(20).fill(0));
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("working 20 0");
    expect(spawnSync("sh", [SCRIPT, "waiting"], { env }).status).toBe(0);
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("waiting 21 1");
    expect(readFileSync(stateFile, "utf8").trim()).toBe("waiting");
    // A duplicate Stop cannot manufacture another completion.
    expect(spawnSync("sh", [SCRIPT, "waiting"], { env }).status).toBe(0);
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("waiting 22 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hook writer that cannot take the lock in time skips its write and still succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ork-state-lock-"));
  const stateFile = join(dir, "state");
  const snapshot = `${stateFile}-snapshot`;
  const env = {
    ...process.env,
    ORKESTRATOR_STATE_FILE: stateFile,
    ORKESTRATOR_STATE_SIGNAL_CONFIG: join(dir, "absent"),
  };
  expect(spawnSync("sh", [SCRIPT, "working"], { env }).status).toBe(0);
  const holder = Bun.spawn(
    ["sh", "-c", 'exec 9>"$1"; flock 9; echo held; read -r _', "sh", `${snapshot}.lock`],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("held");
    reader.releaseLock();
    // No wait, and a malformed wait (which falls back to the default): the
    // hook still exits 0 and the snapshot is untouched.
    for (const wait of ["0", "1.5"]) {
      const result = spawnSync("sh", [SCRIPT, "waiting"], {
        env: { ...env, ORKESTRATOR_STATE_LOCK_WAIT: wait },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(snapshot, "utf8").trim()).toBe("working 1 0");
    }
    holder.stdin.end();
    await holder.exited;
    // Once the lock is free the next writer counts from the last persisted value.
    expect(spawnSync("sh", [SCRIPT, "waiting"], { env }).status).toBe(0);
    expect(readFileSync(snapshot, "utf8").trim()).toBe("waiting 2 1");
  } finally {
    holder.stdin.end();
    await holder.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
