import { describe, expect, test } from "bun:test";

const script = new URL("../scripts/agent-mail-store-size-bench.ts", import.meta.url).pathname;

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("agent mail store size benchmark", () => {
  test("rejects malformed, empty, missing and nonpositive sizes", async () => {
    for (const args of [
      ["--sizes", "abc"],
      ["--sizes", "0"],
      ["--sizes", ""],
      ["--sizes"],
      ["--sizes", "1,abc"],
      ["--sizes", "Infinity"],
    ]) {
      const result = await run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--sizes requires");
      expect(result.stdout).not.toContain('"targetMiB"');
    }
  });

  test("rejects exhaustion including the warm-up sample before measuring", async () => {
    for (const args of [
      ["--environments", "2", "--tabs", "1", "--iterations", "20"],
      ["--iterations", "300"],
      ["--environments", "8", "--tabs", "1", "--iterations", "4"],
    ]) {
      const result = await run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("includes warm-up");
      expect(result.stdout).not.toContain('"targetMiB"');
    }
  });

  test("fractional sizes complete with fresh mutation targets and report send growth", async () => {
    const result = await run([
      "--sizes",
      "0.5,1",
      "--environments",
      "8",
      "--tabs",
      "1",
      "--iterations",
      "3",
    ]);
    expect(result.exitCode).toBe(0);
    const rows = result.stdout
      .split("\n")
      .filter((line) => line.startsWith('{"targetMiB":'))
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.targetMiB)).toEqual([0.5, 1]);
    for (const row of rows) {
      expect(row.finalShape.storeBytes).toBeGreaterThan(row.storeBytes);
      expect(Number.isInteger(row.finalShape.pendingInjects)).toBe(true);
      expect(row.injectClaimMs.ms).toBeGreaterThan(0);
      expect(row.backoffResetMs.ms).toBeGreaterThan(0);
    }
  }, 30_000);
});
