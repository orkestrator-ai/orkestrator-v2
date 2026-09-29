/**
 * Headless install of the pinned agent toolchain.
 *
 * The desktop app installs its toolchain through `ensurePinnedToolchains` while
 * it starts. A backend that runs without the desktop (`orkestrator serve`, a
 * server, a container) has no such step, so nothing ever fetched the pinned
 * binaries for it: it used whatever `claude`/`codex`/… happened to be on `PATH`.
 * This module is that step for everything that is not Electron, and it drives
 * the same manager, so a headless install has exactly the desktop's guarantees:
 * HTTPS and host allowlists, size and digest checks, an install lock, an
 * executable probe, and an activation directory that is only switched once the
 * whole set verified.
 *
 * Which tools are installed follows the data directory's own configuration —
 * the same `enabledAgentPlatforms` the desktop reads — so a host that enabled
 * two platforms does not download five.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import {
  ensurePinnedToolchains,
  type EnsurePinnedToolchainsOptions,
  type PinnedToolchainResult,
  type ToolchainProgress,
} from "./manager.js";
import {
  PINNED_TOOLCHAIN_VERSIONS,
  pinnedToolchainArtifacts,
  type ToolchainArtifact,
  type ToolchainName,
} from "./manifest.js";
import { CURRENT_TOOLCHAIN_LINK, currentToolchainBinDir } from "./layout.js";
import { loadAgentPlatformSelection } from "./platform-selection.js";

export { CURRENT_TOOLCHAIN_LINK, currentToolchainBinDir };

export type ToolchainSelectionSource =
  /** The caller named the tools. */
  | "explicit"
  /** The data directory's `enabledAgentPlatforms` chose them. */
  | "config"
  /** Nothing has been chosen yet, so every pinned tool is installed. */
  | "all";

export interface ToolchainSelection {
  tools: ToolchainName[];
  source: ToolchainSelectionSource;
}

export function isToolchainName(value: string): value is ToolchainName {
  return Object.hasOwn(PINNED_TOOLCHAIN_VERSIONS, value);
}

/**
 * Decide what to install.
 *
 * An explicit list wins. Otherwise the data directory's configuration decides;
 * platform ids that have no pinned binary (Cursor is SDK-only) simply drop out.
 * A directory nobody has configured yet gets every pinned tool: a fresh server
 * has no first-run dialog to choose in, and installing too much is recoverable
 * where a missing binary at the first turn is not.
 */
export async function resolveToolchainSelection(options: {
  dataDir: string;
  tools?: readonly string[];
}): Promise<ToolchainSelection> {
  const known = Object.keys(PINNED_TOOLCHAIN_VERSIONS) as ToolchainName[];
  if (options.tools !== undefined && options.tools.length > 0) {
    const unknown = options.tools.filter((tool) => !isToolchainName(tool));
    if (unknown.length > 0) {
      throw new Error(`Unknown tool: ${unknown.join(", ")}. Expected: ${known.join(", ")}`);
    }
    const requested = new Set(options.tools);
    return { tools: known.filter((name) => requested.has(name)), source: "explicit" };
  }
  const selection = await loadAgentPlatformSelection(options.dataDir);
  if (selection.needsFirstRunChoice) return { tools: known, source: "all" };
  const enabled = new Set<string>(selection.enabled);
  return { tools: known.filter((name) => enabled.has(name)), source: "config" };
}

export interface InstallToolchainOptions {
  dataDir: string;
  /** Overrides the configuration; names from `PINNED_TOOLCHAIN_VERSIONS`. */
  tools?: readonly string[];
  platform?: NodeJS.Platform;
  architecture?: string;
  fetchImpl?: EnsurePinnedToolchainsOptions["fetchImpl"];
  onProgress?: (progress: ToolchainProgress) => void;
  /** Substituted by tests; production always uses the real manager. */
  ensure?: (options: EnsurePinnedToolchainsOptions) => Promise<PinnedToolchainResult>;
}

export interface InstallToolchainResult extends ToolchainSelection {
  dataDir: string;
  rootDir: string;
  /** This set's own activation directory. Stable for exactly these pins. */
  binDir: string;
  /** The pointer to hand to a backend. */
  currentBinDir: string;
  executables: PinnedToolchainResult["executables"];
  versions: Partial<Record<ToolchainName, string>>;
  /**
   * Tools the previous `current` set had that this one does not. A narrower
   * selection (an explicit `--tool` list, or fewer enabled platforms) replaces
   * the set rather than adding to it, and a backend restarted afterwards would
   * silently stop finding these.
   */
  dropped: ToolchainName[];
}

/** What `installPinnedToolchains` would fetch, without touching the network or disk. */
export async function planToolchainInstall(
  options: Pick<InstallToolchainOptions, "dataDir" | "tools" | "platform" | "architecture">,
): Promise<ToolchainSelection & { artifacts: readonly ToolchainArtifact[] }> {
  const selection = await resolveToolchainSelection(options);
  const chosen = new Set<string>(selection.tools);
  const artifacts = pinnedToolchainArtifacts(options.platform, options.architecture).filter(
    (artifact) => chosen.has(artifact.name),
  );
  return { ...selection, artifacts };
}

/**
 * Install the pinned toolchain for the selected tools and point `bin/current` at
 * it. Safe to run repeatedly and while a backend is running: verified installs
 * are reused, and the running process keeps the executables it resolved.
 */
export async function installPinnedToolchains(
  options: InstallToolchainOptions,
): Promise<InstallToolchainResult> {
  const plan = await planToolchainInstall(options);
  if (plan.artifacts.length === 0) {
    throw new Error(
      "None of the selected agent platforms has a pinned binary to install " +
        "(SDK-only platforms such as Cursor need none). Name tools explicitly with --tool.",
    );
  }
  const ensure = options.ensure ?? ensurePinnedToolchains;
  const installed = await ensure({
    dataDir: options.dataDir,
    artifacts: plan.artifacts,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.architecture ? { architecture: options.architecture } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const before = await toolsInCurrent(installed.rootDir);
  const currentBinDir = await pointCurrentAt(installed.rootDir, installed.binDir);
  const chosen = new Set<string>(plan.tools);
  return {
    dropped: before.filter((tool) => !chosen.has(tool)),
    tools: plan.tools,
    source: plan.source,
    dataDir: options.dataDir,
    rootDir: installed.rootDir,
    binDir: installed.binDir,
    currentBinDir,
    executables: installed.executables,
    versions: Object.fromEntries(
      plan.artifacts.map((artifact) => [artifact.name, artifact.version]),
    ),
  };
}

/** The pinned tools the set `bin/current` points at provides right now. */
async function toolsInCurrent(rootDir: string): Promise<ToolchainName[]> {
  const entries: string[] = await readdir(path.join(rootDir, "bin", CURRENT_TOOLCHAIN_LINK)).catch(
    () => [],
  );
  return (Object.keys(PINNED_TOOLCHAIN_VERSIONS) as ToolchainName[]).filter((tool) =>
    entries.includes(tool),
  );
}

/**
 * Atomically repoint `bin/current` at a verified activation directory.
 *
 * The link is relative, so moving the data directory keeps it valid, and it is
 * replaced by renaming a fresh link over it, so a process resolving a binary
 * mid-update sees the old set or the new one and never a missing path. It only
 * ever replaces a symlink: anything else at that name is not ours to remove.
 */
async function pointCurrentAt(rootDir: string, binDir: string): Promise<string> {
  const binRoot = path.join(rootDir, "bin");
  // A wrong `binDir` must not point the link somewhere outside the toolchain tree.
  if (path.dirname(binDir) !== binRoot) {
    throw new Error(`Activation directory ${binDir} is not directly inside ${binRoot}`);
  }
  const link = path.join(binRoot, CURRENT_TOOLCHAIN_LINK);
  const target = path.basename(binDir);
  await mkdir(binRoot, { recursive: true, mode: 0o700 });
  const existing = await lstat(link).catch(() => null);
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`Refusing to replace ${link}: it is not a symbolic link`);
  }
  if (existing && (await readlink(link)) === target) return link;
  const temporary = path.join(binRoot, `.${CURRENT_TOOLCHAIN_LINK}-${randomUUID()}.tmp`);
  await symlink(target, temporary, "dir");
  try {
    await rename(temporary, link);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return link;
}

/**
 * Print each phase of each tool once, not every byte.
 *
 * The manager reports download progress continuously and downloads several
 * tools at once, so their reports interleave; remembering only the previous
 * line would repeat "Downloading codex" every time another tool spoke.
 */
export function createProgressLogger(
  log: (message: string) => void,
): (progress: ToolchainProgress) => void {
  const seen = new Set<string>();
  return (progress) => {
    const key = `${progress.phase}:${progress.tool ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    log(progress.message);
  };
}
