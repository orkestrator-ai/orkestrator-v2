/**
 * Stage the Claude Agent SDK beside the built bundle, without its platform
 * binary.
 *
 * The build keeps `@anthropic-ai/claude-agent-sdk` external, so `dist/index.js`
 * resolves it from `dist/node_modules`, the only `node_modules` a packaged
 * desktop app or the container image carries for this bridge.
 *
 * The SDK's optional platform packages (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`,
 * plus `-musl` on Linux) are deliberately not copied. Each holds a whole Claude
 * Code binary, about 320 MB, and nothing that runs `dist/` uses it: the SDK
 * looks for its own binary only when `pathToClaudeCodeExecutable` is unset, and
 * the bridge always sets it from `CLAUDE_CLI_PATH` (`claudeExecutableOptions` in
 * `src/services/session-manager-core.ts`), which every backend launch path fills
 * with the managed toolchain binary or the bare name `claude`. A bridge started
 * without it fails with the SDK's "Native CLI binary ... not found" error rather
 * than running a second, unpinned engine. Live probes that want the SDK's own
 * binary run from `src/` against the workspace `node_modules`, which still has
 * it. To-do 8050 (retired) and `docs/development/upgrade-agents.md` record the
 * trace and the size.
 */
import { cp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Replace `<packageRoot>/dist/node_modules` with a dereferenced copy of the
 * main SDK package only. Returns the package names it staged under
 * `@anthropic-ai/`.
 */
export async function vendorClaudeAgentSdk(packageRoot: string): Promise<string[]> {
  const vendored = path.join(packageRoot, "dist", "node_modules");
  const destination = path.join(vendored, "@anthropic-ai");
  const sdkLink = path.join(packageRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  const sdkRoot = await realpath(sdkLink);

  await rm(vendored, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(sdkRoot, path.join(destination, "claude-agent-sdk"), {
    recursive: true,
    dereference: true,
  });

  return (await readdir(destination)).sort();
}

if (import.meta.main) {
  await vendorClaudeAgentSdk(path.resolve(import.meta.dir, ".."));
}
