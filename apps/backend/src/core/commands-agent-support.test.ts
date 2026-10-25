import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import {
  resolveAgentBinary,
  resolveBunBinary,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveOpenCodeBinary,
  resolvePiBinary,
} from "./commands-agent-support.js";
import { checkHostTool } from "./host-tools.js";

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function contextWith(
  bundled: boolean | readonly string[],
  runtimeFlavor?: CommandContext["runtimeFlavor"],
): Promise<CommandContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-resolve-bun-"));
  directories.push(root);
  const names = bundled === true ? ["bun"] : bundled === false ? [] : bundled;
  if (names.length > 0) await mkdir(path.join(root, "resources", "bin"), { recursive: true });
  for (const name of names) await writeFile(path.join(root, "resources", "bin", name), "");
  return {
    resourceRoot: path.join(root, "resources"),
    appRoot: path.join(root, "app"),
    ...(runtimeFlavor ? { runtimeFlavor } : {}),
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

const PATH_FALLBACK_AGENTS = [
  ["claude", resolveClaudeBinary],
  ["codex", resolveCodexBinary],
  ["opencode", resolveOpenCodeBinary],
  ["pi", resolvePiBinary],
] as const;

describe("PATH fallback for agent binaries", () => {
  test.each(PATH_FALLBACK_AGENTS)(
    "%s prefers the managed toolchain copy",
    async (name, resolve) => {
      for (const flavor of ["production", "agent-test"] as const) {
        const context = await contextWith([name], flavor);
        expect(resolve(context)).toBe(path.join(context.resourceRoot, "bin", name));
      }
    },
  );

  test.each(PATH_FALLBACK_AGENTS)(
    "%s falls back to PATH outside an agent-test profile",
    async (name, resolve) => {
      for (const flavor of [undefined, "production", "development"] as const) {
        expect(resolve(await contextWith(false, flavor))).toBe(name);
      }
    },
  );

  test.each(PATH_FALLBACK_AGENTS)(
    "%s refuses PATH in an agent-test profile that did not provision it",
    async (name, resolve) => {
      const context = await contextWith(false, "agent-test");
      expect(() => resolve(context)).toThrow(
        `not installed in this agent-test profile's toolchain; start the profile with ${name} in --agent-platforms.`,
      );
      // Extension discovery spawns through the same resolver.
      expect(() => resolveAgentBinary(context, name)).toThrow(/agent-test profile/);
    },
  );

  test("availability reporting and spawning agree in an agent-test profile", async () => {
    // The profile provisioned Codex only. Claude may well be on the host's
    // PATH, but the profile reports it unavailable and cannot spawn it.
    const context = await contextWith(["codex"], "agent-test");
    expect(await checkHostTool(context, "codex")).toBe(true);
    expect(resolveCodexBinary(context)).toBe(path.join(context.resourceRoot, "bin", "codex"));
    expect(await checkHostTool(context, "claude")).toBe(false);
    expect(() => resolveClaudeBinary(context)).toThrow(/agent-test profile/);
  });
});
