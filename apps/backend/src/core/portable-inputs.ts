import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { environmentStateDirectory } from "./environment-state-paths.js";

/**
 * Portable agent inputs, staged per environment (containers plan step 08).
 *
 * Instead of bind-mounting whole host agent homes (histories, databases,
 * transcripts and all) into every container, the backend copies the same
 * allowlist `docker/entrypoint.sh` consumes into a private revision directory
 * and binds only those staged subtrees, read-only, at the paths the entrypoint
 * already reads. The entrypoint's own bounded copy then runs unchanged.
 *
 * Only enabled providers are staged. Sources are read without following
 * symlinks (every ancestor and the entry itself), each file is re-checked
 * after opening so a swapped path cannot be read, and bounds are enforced
 * while copying. A revision is written under a temporary name and renamed
 * into place, so a container never binds a half-written revision.
 */

export const PORTABLE_INPUT_SPEC_VERSION = 1;

export type InputLimits = {
  fileBytes: number;
  directoryEntries: number;
  directoryBytes: number;
  totalEntries: number;
  totalBytes: number;
};

export const INPUT_LIMITS: InputLimits = {
  fileBytes: 10 * 1024 * 1024,
  directoryEntries: 5_000,
  directoryBytes: 256 * 1024 * 1024,
  totalEntries: 20_000,
  totalBytes: 512 * 1024 * 1024,
};

type DirectoryMode =
  /** Copy the directory as one unit; over-bound skips the whole directory. */
  | "tree"
  /** Copy each top-level entry as its own unit. */
  | "entries";

export interface InputSource {
  /** Staged sub-directory, also the name of the bind mount it feeds. */
  stage: string;
  /** Mount point inside the container (the path entrypoint.sh reads). */
  target: string;
  /** Host directory the allowlist is read from. */
  root: string | null;
  files?: readonly string[];
  directories?: readonly { path: string; mode: DirectoryMode; exclude?: readonly string[] }[];
}

export interface InputFile {
  stage: string;
  target: string;
  /** Host file. */
  source: string | null;
}

export interface ProviderInputSpec {
  provider: AgentPlatform | "git";
  directories: InputSource[];
  files: InputFile[];
}

export interface InputSourceRoots {
  home: string;
  /** Agent-test profiles read credentials from isolated locations. */
  agentTest: boolean;
  agentTestHostHome?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  xdgConfigHome?: string;
  xdgDataHome?: string;
  xdgStateHome?: string;
}

export function defaultInputSourceRoots(
  runtimeFlavor: string | undefined,
  claudeConfigDirEnv: string,
): InputSourceRoots {
  const agentTest = runtimeFlavor === "agent-test";
  return {
    home: os.homedir(),
    agentTest,
    agentTestHostHome: process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim() || undefined,
    claudeConfigDir: process.env[claudeConfigDirEnv]?.trim() || undefined,
    codexHome: process.env.CODEX_HOME?.trim() || undefined,
    xdgConfigHome: process.env.XDG_CONFIG_HOME?.trim() || undefined,
    xdgDataHome: process.env.XDG_DATA_HOME?.trim() || undefined,
    xdgStateHome: process.env.XDG_STATE_HOME?.trim() || undefined,
  };
}

/**
 * The versioned allowlist, per provider. It mirrors `docker/entrypoint.sh`
 * exactly — the entrypoint copies these same names from the same mount
 * points — so staging never exposes anything the container would not have
 * copied anyway. Keep the two in step.
 */
export function portableInputSpec(roots: InputSourceRoots): ProviderInputSpec[] {
  const { home, agentTest } = roots;
  const hostHome = agentTest && roots.agentTestHostHome ? roots.agentTestHostHome : home;
  const join = (base: string | undefined, ...parts: string[]) =>
    base ? path.join(base, ...parts) : null;
  const configHome = agentTest ? roots.xdgConfigHome : path.join(home, ".config");
  const dataHome = agentTest ? roots.xdgDataHome : path.join(home, ".local", "share");
  const stateHome = agentTest ? roots.xdgStateHome : path.join(home, ".local", "state");
  return [
    {
      provider: "claude",
      directories: [
        {
          stage: "claude-config",
          target: "/claude-config",
          root: agentTest ? (roots.claudeConfigDir ?? null) : path.join(home, ".claude"),
          files: ["CLAUDE.md", "settings.local.json", ".credentials.json"],
          directories: [
            { path: "commands", mode: "entries" },
            { path: "agents", mode: "entries" },
            { path: "ide", mode: "entries" },
            { path: "plugins", mode: "entries" },
          ],
        },
      ],
      files: [
        {
          stage: "claude.json",
          target: "/claude-config.json",
          source: join(hostHome, ".claude.json"),
        },
      ],
    },
    {
      provider: "opencode",
      directories: [
        {
          stage: "opencode-config",
          target: "/opencode-config",
          root: join(configHome, "opencode"),
          // User-authored: every entry except host-platform node_modules.
          directories: [{ path: ".", mode: "entries", exclude: ["node_modules"] }],
        },
        {
          stage: "opencode-data",
          target: "/opencode-data",
          root: join(dataHome, "opencode"),
          files: ["auth.json", "account.json"],
          directories: [
            { path: "storage", mode: "entries" },
            { path: "snapshot", mode: "entries" },
          ],
        },
      ],
      files: [
        {
          stage: "opencode-model.json",
          target: "/opencode-state/model.json",
          source: join(stateHome, "opencode", "model.json"),
        },
      ],
    },
    {
      provider: "codex",
      directories: [
        {
          stage: "codex-home",
          target: "/codex-home",
          root: agentTest ? (roots.codexHome ?? null) : path.join(home, ".codex"),
          files: [
            "auth.json",
            "config.toml",
            "AGENTS.md",
            "hooks.json",
            "models_cache.json",
            ".codex-global-state.json",
            "cloud-config-bundle-cache.json",
            "cloud-requirements-cache.json",
          ],
          directories: [
            { path: "rules", mode: "tree" },
            { path: "skills", mode: "tree" },
            { path: "prompts", mode: "tree" },
            { path: "vendor_imports", mode: "tree" },
            // plugins/.plugin-appserver holds host-platform binaries.
            { path: "plugins/cache", mode: "tree" },
          ],
        },
      ],
      files: [],
    },
    {
      provider: "grok",
      directories: [
        {
          stage: "grok-home",
          target: "/grok-home",
          root: path.join(hostHome, ".grok"),
          files: [
            "auth.json",
            "config.toml",
            "trusted_folders.toml",
            "agent_id",
            "models_cache.json",
          ],
          directories: [
            { path: "hooks", mode: "entries" },
            { path: "skills", mode: "entries" },
          ],
        },
        {
          stage: "grok-config",
          target: "/grok-config",
          root: path.join(hostHome, ".config", "grok"),
          directories: [{ path: ".", mode: "tree" }],
        },
      ],
      files: [],
    },
    {
      provider: "pi",
      directories: [
        {
          stage: "pi-config",
          target: "/pi-config",
          root: path.join(hostHome, ".pi"),
          files: [
            "agent/auth.json",
            "agent/models.json",
            "agent/settings.json",
            "agent/mcp.json",
            "agent/SYSTEM.md",
            "agent/APPEND_SYSTEM.md",
          ],
          // Sessions are the host's own history and are never staged.
          directories: [
            { path: "agent/skills", mode: "entries" },
            { path: "agent/prompts", mode: "entries" },
            { path: "agent/extensions", mode: "entries" },
            { path: "agent/themes", mode: "entries" },
          ],
        },
      ],
      files: [],
    },
    {
      provider: "git",
      directories: [],
      files: agentTest
        ? []
        : [{ stage: "gitconfig", target: "/tmp/gitconfig", source: path.join(home, ".gitconfig") }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

export type SkipReason =
  | "symlink"
  | "not-regular"
  | "too-large"
  | "too-many-entries"
  | "aggregate-budget"
  | "unreadable"
  | "changed-while-reading";

export interface ProviderInputSummary {
  provider: ProviderInputSpec["provider"];
  files: number;
  bytes: number;
  /** Counts only: skipped names are user file names and stay private. */
  skipped: Partial<Record<SkipReason, number>>;
}

export interface StagedMount {
  source: string;
  target: string;
}

export interface StagedInputs {
  revision: string;
  directory: string;
  mounts: StagedMount[];
  providers: ProviderInputSummary[];
  specVersion: number;
  stagedAt: string;
}

class Budget {
  entries = 0;
  bytes = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}
  fits(entries: number, bytes: number): boolean {
    return this.entries + entries <= this.maxEntries && this.bytes + bytes <= this.maxBytes;
  }
  take(entries: number, bytes: number): void {
    this.entries += entries;
    this.bytes += bytes;
  }
}

class Skip extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason);
  }
}

/** Throws unless every component below `root` up to `relative` is a real directory. */
async function assertNoSymlinkAncestry(root: string, relative: string): Promise<void> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Skip("symlink");
  const parts = relative.split("/").filter((part) => part && part !== ".");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Skip("symlink");
    if (!stat.isDirectory()) throw new Skip("not-regular");
  }
}

async function copyRegularFile(
  source: string,
  destination: string,
  limit: number,
): Promise<number> {
  const before = await lstat(source);
  if (before.isSymbolicLink()) throw new Skip("symlink");
  if (!before.isFile()) throw new Skip("not-regular");
  if (before.size > limit) throw new Skip("too-large");
  const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      throw new Skip(error.code === "ELOOP" ? "symlink" : "unreadable");
    },
  );
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) {
      throw new Skip("changed-while-reading");
    }
    // Read at most limit+1 bytes: growth past the bound is detected while
    // copying, not from the earlier size.
    const buffer = Buffer.alloc(Math.min(limit + 1, Math.max(opened.size, 0) + 1));
    let total = 0;
    const chunks: Buffer[] = [];
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new Skip("too-large");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
    return total;
  } finally {
    await handle.close();
  }
}

interface TreeEntry {
  relative: string;
  kind: "file" | "directory";
  size: number;
}

/** Lists a tree without following links; symlinks are reported, not entered. */
async function listTree(
  root: string,
  maxEntries: number,
  exclude: readonly string[],
): Promise<{ entries: TreeEntry[]; symlinks: number }> {
  const entries: TreeEntry[] = [];
  let symlinks = 0;
  const walk = async (relative: string): Promise<void> => {
    const names = await readdir(path.join(root, relative));
    for (const name of names) {
      if (!relative && exclude.includes(name)) continue;
      const child = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path.join(root, child));
      if (stat.isSymbolicLink()) {
        symlinks += 1;
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ relative: child, kind: "directory", size: 0 });
        if (entries.length > maxEntries) throw new Skip("too-many-entries");
        await walk(child);
      } else if (stat.isFile()) {
        entries.push({ relative: child, kind: "file", size: stat.size });
        if (entries.length > maxEntries) throw new Skip("too-many-entries");
      }
      // Sockets, devices and FIFOs are runtime artifacts, never inputs.
    }
  };
  await walk("");
  return { entries, symlinks };
}

class ProviderCopier {
  readonly summary: ProviderInputSummary;
  constructor(
    provider: ProviderInputSummary["provider"],
    private readonly total: Budget,
    private readonly limits: InputLimits,
  ) {
    this.summary = { provider, files: 0, bytes: 0, skipped: {} };
  }

  skip(reason: SkipReason, count = 1): void {
    this.summary.skipped[reason] = (this.summary.skipped[reason] ?? 0) + count;
  }

  private record(files: number, bytes: number): void {
    this.summary.files += files;
    this.summary.bytes += bytes;
    this.total.take(files, bytes);
  }

  async file(root: string, relative: string, destinationRoot: string): Promise<void> {
    try {
      await assertNoSymlinkAncestry(root, relative);
      const source = path.join(root, relative);
      const stat = await lstat(source).catch(() => null);
      if (!stat) return;
      if (!this.total.fits(1, stat.size)) throw new Skip("aggregate-budget");
      const bytes = await copyRegularFile(
        source,
        path.join(destinationRoot, relative),
        this.limits.fileBytes,
      );
      this.record(1, bytes);
    } catch (error) {
      if (error instanceof Skip) this.skip(error.reason);
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.skip("unreadable");
    }
  }

  /** Copies one unit (a directory tree or a single entry) all-or-nothing. */
  private async unit(
    root: string,
    relative: string,
    destinationRoot: string,
    exclude: readonly string[],
  ): Promise<void> {
    const source = path.join(root, relative);
    const stat = await lstat(source).catch(() => null);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Skip("symlink");
    if (stat.isFile()) {
      if (!this.total.fits(1, stat.size)) throw new Skip("aggregate-budget");
      const bytes = await copyRegularFile(
        source,
        path.join(destinationRoot, relative),
        this.limits.fileBytes,
      );
      this.record(1, bytes);
      return;
    }
    if (!stat.isDirectory()) throw new Skip("not-regular");
    const { entries, symlinks } = await listTree(source, this.limits.directoryEntries, exclude);
    if (symlinks > 0) this.skip("symlink", symlinks);
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (bytes > this.limits.directoryBytes) throw new Skip("too-large");
    if (entries.some((entry) => entry.kind === "file" && entry.size > this.limits.fileBytes)) {
      throw new Skip("too-large");
    }
    const files = entries.filter((entry) => entry.kind === "file");
    if (!this.total.fits(files.length, bytes)) throw new Skip("aggregate-budget");
    await mkdir(path.join(destinationRoot, relative), { recursive: true, mode: 0o700 });
    let copied = 0;
    let copiedBytes = 0;
    for (const entry of entries) {
      const target = path.join(destinationRoot, relative, entry.relative);
      if (entry.kind === "directory") {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      try {
        copiedBytes += await copyRegularFile(
          path.join(source, entry.relative),
          target,
          this.limits.fileBytes,
        );
        copied += 1;
        if (copiedBytes > this.limits.directoryBytes) throw new Skip("too-large");
      } catch (error) {
        // One file changing mid-copy skips that file, not its siblings.
        if (error instanceof Skip && error.reason !== "too-large") this.skip(error.reason);
        else throw error;
      }
    }
    this.record(copied, copiedBytes);
  }

  async directory(
    root: string,
    spec: { path: string; mode: DirectoryMode; exclude?: readonly string[] },
    destinationRoot: string,
  ): Promise<void> {
    const relative = spec.path === "." ? "" : spec.path;
    try {
      if (relative) await assertNoSymlinkAncestry(root, `${relative}/x`);
      else await assertNoSymlinkAncestry(root, "x");
      if (spec.mode === "tree") {
        await this.unit(root, relative || ".", destinationRoot, spec.exclude ?? []);
        return;
      }
      const directory = path.join(root, relative);
      const stat = await lstat(directory).catch(() => null);
      if (!stat) return;
      if (stat.isSymbolicLink()) throw new Skip("symlink");
      if (!stat.isDirectory()) throw new Skip("not-regular");
      const names = (await readdir(directory)).filter(
        (name) => !(spec.exclude ?? []).includes(name),
      );
      if (names.length > this.limits.directoryEntries) throw new Skip("too-many-entries");
      for (const name of names) {
        try {
          await this.unit(root, relative ? `${relative}/${name}` : name, destinationRoot, []);
        } catch (error) {
          if (error instanceof Skip) this.skip(error.reason);
          else this.skip("unreadable");
        }
      }
    } catch (error) {
      if (error instanceof Skip) this.skip(error.reason);
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.skip("unreadable");
    }
  }
}

function portableInputsDirectory(dataDir: string, environmentId: string): string {
  return environmentStateDirectory(dataDir, "portable-inputs", environmentId);
}

/**
 * Stages the allowlisted inputs of `providers` into a new revision for one
 * environment and returns the bind mounts that expose it. Only staged
 * subtrees are mounted — never the revision's parent, never another
 * environment's revisions.
 */
export async function stagePortableInputs(
  dataDir: string,
  environmentId: string,
  providers: ReadonlySet<ProviderInputSpec["provider"]>,
  roots: InputSourceRoots,
  now = new Date(),
  limits: InputLimits = INPUT_LIMITS,
): Promise<StagedInputs> {
  const parent = portableInputsDirectory(dataDir, environmentId);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const revision = `r${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
  const partial = path.join(parent, `.${revision}.partial`);
  const directory = path.join(parent, revision);
  await mkdir(partial, { mode: 0o700 });
  const total = new Budget(limits.totalEntries, limits.totalBytes);
  const summaries: ProviderInputSummary[] = [];
  const mounts: StagedMount[] = [];
  try {
    for (const spec of portableInputSpec(roots)) {
      if (!providers.has(spec.provider)) continue;
      const copier = new ProviderCopier(spec.provider, total, limits);
      for (const source of spec.directories) {
        if (!source.root) continue;
        // The home entry itself is resolved, as the bind mount it replaces
        // was (a dotfiles manager may link it); nothing below it is followed.
        const root = await realpath(source.root).catch(() => null);
        if (!root) continue;
        const stageRoot = path.join(partial, source.stage);
        for (const file of source.files ?? []) await copier.file(root, file, stageRoot);
        for (const directory of source.directories ?? []) {
          await copier.directory(root, directory, stageRoot);
        }
        if (
          await lstat(stageRoot).then(
            () => true,
            () => false,
          )
        ) {
          mounts.push({ source: path.join(directory, source.stage), target: source.target });
        }
      }
      for (const file of spec.files) {
        if (!file.source) continue;
        const real = await realpath(file.source).catch(() => null);
        if (!real) continue;
        const staged = path.join(partial, "files", file.stage);
        await copier.file(path.dirname(real), path.basename(real), staged);
        const stagedFile = path.join(staged, path.basename(real));
        if (
          await lstat(stagedFile).then(
            () => true,
            () => false,
          )
        ) {
          mounts.push({
            source: path.join(directory, "files", file.stage, path.basename(real)),
            target: file.target,
          });
        }
      }
      summaries.push(copier.summary);
    }
    const stagedAt = now.toISOString();
    await writeFile(
      path.join(partial, "manifest.json"),
      JSON.stringify({
        specVersion: PORTABLE_INPUT_SPEC_VERSION,
        revision,
        stagedAt,
        providers: summaries,
      }),
      { mode: 0o600 },
    );
    await rename(partial, directory);
    return {
      revision,
      directory,
      mounts,
      providers: summaries,
      specVersion: PORTABLE_INPUT_SPEC_VERSION,
      stagedAt,
    };
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Docker arguments binding exactly the staged subtrees, read-only. */
export function stagedInputMountArguments(staged: StagedInputs): string[] {
  // `--mount` (unlike `-v`) fails on a missing source instead of creating a
  // host directory.
  return staged.mounts.flatMap((mount) => [
    "--mount",
    `type=bind,src=${mount.source},dst=${mount.target},readonly`,
  ]);
}

/**
 * Removes this environment's revisions that no container still binds.
 * `referenced` must come from Docker (labels of every container of the
 * environment, including recovery copies); a stopped container whose bind
 * source is gone could not start again.
 */
export async function pruneInputRevisions(
  dataDir: string,
  environmentId: string,
  referenced: ReadonlySet<string>,
  now = Date.now(),
): Promise<number> {
  const parent = portableInputsDirectory(dataDir, environmentId);
  const names = await readdir(parent).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (referenced.has(name)) continue;
    if (!/^\.?r[0-9a-z]+-[0-9a-f]{8}(\.partial)?$/.test(name)) continue;
    // A revision (or a partial one) this recent may belong to a staging or a
    // container creation still in progress, whose label does not exist yet.
    const modified = await lstat(path.join(parent, name)).then(
      (info) => info.mtimeMs,
      () => null,
    );
    if (modified === null || now - modified < INPUT_REVISION_PRUNE_GRACE_MS) continue;
    await rm(path.join(parent, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Unreferenced revisions younger than this are kept. */
export const INPUT_REVISION_PRUNE_GRACE_MS = 30 * 60_000;

/**
 * Empties one provider's staged inputs inside an existing revision, so a
 * container that binds the revision sees nothing of that provider from now
 * on, including after a restart (its entrypoint imports from these mounts).
 * Directory mounts are emptied in place; a file mount keeps its inode (a bind
 * mount would otherwise go on showing the deleted file) and is truncated.
 * Returns false when the revision does not exist.
 */
export async function scrubStagedProvider(
  dataDir: string,
  environmentId: string,
  revision: string,
  provider: ProviderInputSpec["provider"],
): Promise<boolean> {
  if (!/^r[0-9a-z]+-[0-9a-f]{8}$/.test(revision)) return false;
  const directory = path.join(portableInputsDirectory(dataDir, environmentId), revision);
  const exists = await lstat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!exists) return false;
  // Stage names do not depend on where the sources live.
  const spec = portableInputSpec({ home: "/", agentTest: false }).find(
    (entry) => entry.provider === provider,
  );
  if (!spec) return true;
  for (const source of spec.directories) {
    const stageRoot = path.join(directory, source.stage);
    const entries = await readdir(stageRoot).catch(() => [] as string[]);
    for (const entry of entries) {
      await rm(path.join(stageRoot, entry), { recursive: true, force: true });
    }
  }
  for (const file of spec.files) {
    const stageDirectory = path.join(directory, "files", file.stage);
    const entries = await readdir(stageDirectory).catch(() => [] as string[]);
    for (const entry of entries) {
      const target = path.join(stageDirectory, entry);
      const info = await lstat(target).catch(() => null);
      if (info?.isFile()) await truncate(target, 0);
    }
  }
  return true;
}

export interface EnvironmentInputsManifest {
  revision: string;
  stagedAt: string;
  specVersion: number;
  providers: ProviderInputSummary[];
}

export async function readInputsManifest(
  dataDir: string,
  environmentId: string,
  revision: string,
): Promise<EnvironmentInputsManifest | null> {
  if (!/^r[0-9a-z]+-[0-9a-f]{8}$/.test(revision)) return null;
  const file = path.join(
    portableInputsDirectory(dataDir, environmentId),
    revision,
    "manifest.json",
  );
  try {
    const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.size > 256 * 1024) return null;
      const parsed = JSON.parse(
        (await handle.readFile()).toString("utf8"),
      ) as EnvironmentInputsManifest;
      return parsed && typeof parsed.revision === "string" ? parsed : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
