import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeFixturesAfterSettlement } from "./fixture-cleanup.js";

for (const outcome of ["settled", "rejected", "stalled"] as const) {
  test(`fixture roots are removed when writers are ${outcome}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-fixture-cleanup-"));
    const pending = Promise.withResolvers<void>();
    try {
      const cleanup = removeFixturesAfterSettlement(
        () => {
          if (outcome === "rejected") throw new Error("writer failed");
          return outcome === "stalled" ? pending.promise : Promise.resolve();
        },
        [root],
        0,
      );
      if (outcome === "settled") await cleanup;
      else
        await expect(cleanup).rejects.toThrow(
          outcome === "stalled" ? "did not settle" : "writer failed",
        );
      expect(existsSync(root)).toBe(false);
    } finally {
      pending.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const rejects of [false, true]) {
  test(`a writer resuming after timeout cannot leave its root behind (rejects=${rejects})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `ork-fixture-cleanup-${process.pid}-`));
    const gate = Promise.withResolvers<void>();
    const cleanup = removeFixturesAfterSettlement(
      async () => {
        await gate.promise;
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, "manifest.json"), "{}");
        if (rejects) throw new Error("late writer failed");
      },
      [root],
      0,
    );
    try {
      await expect(cleanup).rejects.toThrow("did not settle");
      expect(existsSync(root)).toBe(false);
      gate.resolve();
      if (rejects) await expect(cleanup.settled).rejects.toThrow("late writer failed");
      else await cleanup.settled;
      expect(existsSync(root)).toBe(false);
    } finally {
      gate.resolve();
      await cleanup.settled.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
}
