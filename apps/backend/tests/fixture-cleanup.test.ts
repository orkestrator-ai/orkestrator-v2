import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
