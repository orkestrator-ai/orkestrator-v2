/**
 * The vendor step stages the Agent SDK for `dist/index.js` without the SDK's
 * platform packages. Each of those holds a whole Claude Code binary (about
 * 320 MB), and nothing that runs `dist/` uses it: the bridge always passes
 * `CLAUDE_CLI_PATH` as `pathToClaudeCodeExecutable`, and the SDK looks for its
 * own binary only when that is unset (pinned by `sdk-compatibility.test.ts`).
 * `dist/` is what the desktop app packs and the container image installs, so a
 * platform package vendored here is a dead copy in every download. See
 * docs/development/upgrade-agents.md, "The SDK's own Claude binary is not vendored".
 */
import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vendorClaudeAgentSdk } from "../scripts/vendor.js";

/**
 * A bun-isolated layout: the bridge's `node_modules/@anthropic-ai/claude-agent-sdk`
 * is a symlink into a store whose `@anthropic-ai/` also holds the platform
 * package beside the SDK, as `bun install` lays it out.
 */
async function isolatedLayout(root: string): Promise<string> {
  const store = path.join(root, "store", "node_modules", "@anthropic-ai");
  const sdk = path.join(store, "claude-agent-sdk");
  const platform = path.join(store, "claude-agent-sdk-darwin-arm64");
  await mkdir(sdk, { recursive: true });
  await mkdir(platform, { recursive: true });
  await writeFile(path.join(sdk, "package.json"), '{"name":"@anthropic-ai/claude-agent-sdk"}\n');
  await writeFile(path.join(sdk, "sdk.mjs"), "export {};\n");
  await writeFile(path.join(platform, "package.json"), '{"name":"platform"}\n');
  await writeFile(path.join(platform, "claude"), "binary\n");

  const packageRoot = path.join(root, "claude-bridge");
  const scope = path.join(packageRoot, "node_modules", "@anthropic-ai");
  await mkdir(scope, { recursive: true });
  await symlink(sdk, path.join(scope, "claude-agent-sdk"));
  return packageRoot;
}

describe("vendorClaudeAgentSdk", () => {
  test("copies the SDK, dereferenced, and none of its platform packages", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "claude-vendor-")));
    try {
      const packageRoot = await isolatedLayout(root);
      // A tree an older vendor step left behind is replaced, not merged into.
      const stale = path.join(
        packageRoot,
        "dist",
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk-darwin-arm64",
      );
      await mkdir(stale, { recursive: true });
      await writeFile(path.join(stale, "claude"), "stale binary\n");

      const staged = await vendorClaudeAgentSdk(packageRoot);

      const scope = path.join(packageRoot, "dist", "node_modules", "@anthropic-ai");
      expect(staged).toEqual(["claude-agent-sdk"]);
      expect(await readdir(scope)).toEqual(["claude-agent-sdk"]);
      expect(await readdir(path.join(packageRoot, "dist", "node_modules"))).toEqual([
        "@anthropic-ai",
      ]);
      // A real directory: the packaged app carries no workspace store to link into.
      expect((await lstat(path.join(scope, "claude-agent-sdk"))).isSymbolicLink()).toBe(false);
      expect(await readFile(path.join(scope, "claude-agent-sdk", "sdk.mjs"), "utf8")).toBe(
        "export {};\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
