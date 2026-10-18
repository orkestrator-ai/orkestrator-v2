import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { resolveBunBinary } from "./commands-agent-support.js";

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function contextWith(bundled: boolean): Promise<CommandContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-resolve-bun-"));
  directories.push(root);
  if (bundled) {
    await mkdir(path.join(root, "resources", "bin"), { recursive: true });
    await writeFile(path.join(root, "resources", "bin", "bun"), "");
  }
  return {
    resourceRoot: path.join(root, "resources"),
    appRoot: path.join(root, "app"),
  } as unknown as CommandContext;
}

describe("resolveBunBinary", () => {
  test("prefers the bundled binary over the running Bun", async () => {
    const context = await contextWith(true);
    expect(resolveBunBinary(context, { execPath: "/opt/bun/bin/bun", bun: true })).toBe(
      path.join(context.resourceRoot, "bin", "bun"),
    );
  });

  test("uses the running Bun rather than a PATH lookup when nothing is bundled", async () => {
    // The published CLI's `serve`: a PATH `bun` may be a version-manager
    // shim that cannot resolve from `/`, where exec control spawns it.
    const context = await contextWith(false);
    expect(resolveBunBinary(context, { execPath: "/opt/bun/bin/bun", bun: true })).toBe(
      "/opt/bun/bin/bun",
    );
  });

  test("falls back to PATH only when the backend is not running on Bun", async () => {
    const context = await contextWith(false);
    expect(resolveBunBinary(context, { execPath: "/usr/bin/node", bun: false })).toBe("bun");
  });
});
