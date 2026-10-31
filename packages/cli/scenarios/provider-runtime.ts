import { copyFile, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PINNED_TOOLCHAIN_VERSIONS } from "@orkestrator/toolchain/manifest";
import { LEGACY_ENABLED_AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";

/**
 * What a live Pi, Cursor or Grok scenario needs beyond the packaged CLI.
 *
 * The published package installs the Cursor and Pi bridges' SDKs from the
 * registry on first use (`scripts/bridges.ts`), which a scenario should not
 * depend on, so the scenario backend gets its own resource root: the packaged
 * Claude and Codex bridges plus the selected provider's bridge as this
 * worktree built it, SDKs vendored, laid out the way the desktop app ships it
 * (`<bridge>/dist` and `package.json`). The published package is unchanged,
 * and the CLI, backend and claude/codex bridges under test are still the
 * packaged ones. A fresh data directory enables only the legacy platforms,
 * so the provider is enabled too.
 *
 * Every provider with a pinned binary gets it installed into the data
 * directory: an agent-test backend never falls back to PATH (#1270), so a
 * Claude, Codex, OpenCode, Pi or Grok session would otherwise fail to start.
 */

/** Providers whose agent binary the toolchain pins (`toolchain install --tool`). */
const PINNED_TOOLS: ReadonlySet<string> = new Set(Object.keys(PINNED_TOOLCHAIN_VERSIONS));

/** Providers whose bridge a scenario takes from this worktree, with that bridge. */
export const REPOSITORY_BRIDGES: Readonly<Record<string, string>> = Object.freeze({
  pi: "pi-bridge",
  cursor: "cursor-bridge",
  grok: "acp-bridge",
});

const PACKAGED_BRIDGES = ["claude-bridge", "codex-bridge"] as const;

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}

export interface ProviderRuntime {
  /** Extra `serve` arguments. */
  serveArgs: string[];
  /** Pinned tools to install into the data directory before `serve`. */
  toolchainTools: string[];
}

export async function prepareProviderRuntime(options: {
  root: string;
  dataDir: string;
  provider?: string;
  packageRoot: string;
  repositoryRoot?: string;
}): Promise<ProviderRuntime> {
  const bridge = options.provider ? REPOSITORY_BRIDGES[options.provider] : undefined;
  const toolchainTools =
    options.provider && PINNED_TOOLS.has(options.provider) ? [options.provider] : [];
  if (!options.provider || !bridge) return { serveArgs: [], toolchainTools };
  const repositoryRoot = options.repositoryRoot ?? path.resolve(options.packageRoot, "../..");
  const resourceRoot = path.join(options.root, "resources");
  await mkdir(resourceRoot, { recursive: true, mode: 0o700 });
  for (const name of PACKAGED_BRIDGES) {
    const packaged = path.join(options.packageRoot, "resources", name);
    if (!(await isFile(path.join(packaged, "dist", "index.js"))))
      throw new Error(`The packaged ${name} is missing; run \`bun run build\` in packages/cli`);
    await symlink(packaged, path.join(resourceRoot, name));
  }
  const source = path.join(repositoryRoot, "bridges", bridge);
  if (!(await isFile(path.join(source, "dist", "index.js"))))
    throw new Error(`${bridge} is not built; run \`mise run build:${bridge}\``);
  await mkdir(path.join(resourceRoot, bridge));
  await symlink(path.join(source, "dist"), path.join(resourceRoot, bridge, "dist"));
  await copyFile(
    path.join(source, "package.json"),
    path.join(resourceRoot, bridge, "package.json"),
  );
  await writeFile(
    path.join(options.dataDir, "agent-platforms.json"),
    `${JSON.stringify({ enabled: [...LEGACY_ENABLED_AGENT_PLATFORMS, options.provider] })}\n`,
    { mode: 0o600 },
  );
  return {
    serveArgs: ["--resource-root", resourceRoot],
    toolchainTools,
  };
}
