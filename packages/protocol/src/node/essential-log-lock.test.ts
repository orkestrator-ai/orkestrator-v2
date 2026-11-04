import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEssentialLogLock } from "./essential-log-lock.js";

test("a live lock cannot be stolen; dead and interrupted owners recover safely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "essential-lock-"));
  try {
    const acquire = createEssentialLogLock(root);
    const contender = createEssentialLogLock(root);
    const release = acquire();
    expect(release).not.toBeNull();
    expect(contender()).toBeNull();
    expect(contender()).toBeNull();
    release!();
    const next = contender();
    expect(next).not.toBeNull();
    next!();
    expect(readdirSync(root)).toEqual([]);

    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    const deadOwner = `${child.pid}-${randomUUID()}`;
    mkdirSync(path.join(root, ".writer-lock", deadOwner), { recursive: true });
    mkdirSync(path.join(root, `.writer-stage-${deadOwner}`, deadOwner), { recursive: true });
    expect(acquire()).toBeNull(); // Reclaims the old publication; does not own it yet.
    expect(existsSync(path.join(root, `.writer-stage-${deadOwner}`))).toBe(false);
    const recovered = acquire();
    expect(recovered).not.toBeNull();
    recovered!();

    // Death between removing the child and the root leaves an empty lock.
    mkdirSync(path.join(root, ".writer-lock"));
    // Windows refuses rename onto even an empty destination directory.
    const emptyRecovered = acquire() ?? acquire();
    expect(emptyRecovered).not.toBeNull();
    emptyRecovered!();
    expect(readdirSync(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
