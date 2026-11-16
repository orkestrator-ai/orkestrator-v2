import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PINNED_TOOLCHAIN_VERSIONS } from "@orkestrator/toolchain/manifest";

/**
 * The Claude CLI binary the Claude bridge's Agent SDK bundles, when it is the
 * pinned build (`PINNED_TOOLCHAIN_VERSIONS.claude`); undefined otherwise. It
 * comes from this checkout's `node_modules`, so a test that uses it never
 * reads the real data directory's toolchains.
 */
export function bundledPinnedClaudeCli(): string | undefined {
  try {
    const bridge = createRequire(
      join(import.meta.dir, "../../../bridges/claude-bridge/package.json"),
    );
    const sdkManifest = bridge.resolve("@anthropic-ai/claude-agent-sdk/package.json");
    const sdk = JSON.parse(readFileSync(sdkManifest, "utf8")) as { claudeCodeVersion?: string };
    if (sdk.claudeCodeVersion !== PINNED_TOOLCHAIN_VERSIONS.claude) return undefined;
    const platform = createRequire(sdkManifest).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const binary = join(dirname(platform), process.platform === "win32" ? "claude.exe" : "claude");
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}
