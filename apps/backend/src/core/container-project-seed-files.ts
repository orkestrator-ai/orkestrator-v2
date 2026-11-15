import { constants as fsConstants, promises as fs } from "node:fs";
import { pack } from "tar-stream";
import path from "node:path";
import { DEFAULT_ENV_FILE_PATTERNS } from "@orkestrator/protocol/app-config-defaults";
import { isPathInsideRoot } from "./commands-project-files.js";
import { DOCKER_LABEL_PROJECT_SEED_REFUSED } from "./constants.js";
import { copyIntoContainer } from "./docker-copy-refusal.js";
import {
  ENV_FILE_PATTERN_LIMITS,
  findEnvFilePatternCandidates,
  hasUnsafeNameCharacters,
} from "./project-env-file-patterns.js";
import { runCommand } from "./shell.js";

/**
 * The project files copied into a new environment: whatever the "Environment
 * Files" setting (`envFilePatterns`, by default `.env` and `.env.local`)
 * matches, plus the project's `opencode.json` for containers.
 *
 * They come from the project checkout, which is repository content: a branch
 * can commit `.env -> ~/.ssh` or `.env.local -> /var/run/docker.sock`. These
 * used to be bind mounts, and Docker resolves a bind source on the host (as
 * root on a rootful daemon), so any host path could reach the container.
 * Each file is now read by the backend before the container is created: it
 * must be a regular file, not a link, whose real path stays inside the
 * project. The bytes read are the bytes copied in (`docker cp`) once the
 * container exists, so the checkout cannot change between the check and the
 * copy. A refused file is skipped, never a failed environment; the reason is
 * recorded on the container (`DOCKER_LABEL_PROJECT_SEED_REFUSED`) and shown
 * in the setup terminal. Pattern matching and its bounds live in
 * `project-env-file-patterns.ts`; more matches than the bounds allow copies
 * none of them.
 */

/** The image's setup reads these two from `/project-env/<name>`. */
export const PROJECT_ENV_DIRECT_NAMES: ReadonlySet<string> = new Set([".env", ".env.local"]);

/**
 * Names that go through this reader, never the generic files-to-copy staging
 * (which follows links inside the project). A local worktree's reader skips
 * `opencode.json`, so there it stays with that staging
 * (`filesLeftForConfiguredCopy`).
 */
export const RESERVED_PROJECT_SEED_NAMES: ReadonlySet<string> = new Set([
  ".env",
  ".env.local",
  "opencode.json",
]);

export const PROJECT_OPENCODE_SEED = { name: "opencode.json", target: "opencode-project-json" };

/** Where a matched file lands below the container root. */
export function envFileContainerTarget(name: string): string {
  return PROJECT_ENV_DIRECT_NAMES.has(name) ? `project-env/${name}` : `project-files/${name}`;
}

export type ProjectSeedFileName = string;

/** Larger than any real dotenv or OpenCode project file. */
export const PROJECT_SEED_FILE_MAX_BYTES = 1024 * 1024;

/** The name an aggregate refusal (a bound on all the matches) is recorded under. */
export const ENV_FILE_PATTERNS_REFUSAL_NAME = "Environment Files";

export const PROJECT_SEED_REFUSAL_REASONS = [
  "symlink",
  "not-a-file",
  "outside-project",
  "too-large",
  "changed-while-reading",
  "unreadable",
  "invalid-pattern",
  "too-many-patterns",
  "unsafe-name",
  "linked-destination",
  "too-many-matches",
  "matches-too-large",
  "scan-limit",
] as const;

export type ProjectSeedRefusalReason = (typeof PROJECT_SEED_REFUSAL_REASONS)[number];

export interface ProjectSeedRefusal {
  name: ProjectSeedFileName;
  reason: ProjectSeedRefusalReason;
}

export interface ReadProjectSeedFiles {
  /** Accepted files, keyed by their path below the container root. */
  accepted: { name: ProjectSeedFileName; target: string; contents: Buffer }[];
  refused: ProjectSeedRefusal[];
  /**
   * Every path this reader decided, accepted or refused. The generic
   * files-to-copy staging must not reread one: a refusal is never replaced
   * by a second source.
   */
  handled: string[];
}

export interface ReadProjectSeedFilesOptions {
  /** The "Environment Files" setting; the default reproduces `.env` and `.env.local`. */
  envFilePatterns?: readonly string[];
  /** A command node's staged copies, used only for an absent literal name. */
  fallbackPath?: string;
  fallbackNames?: readonly string[];
  /** Paths the repository's own files-to-copy list names; left to that copy. */
  exclude?: readonly string[];
  /** Containers also take `opencode.json`; a worktree has its own checkout. */
  includeOpenCodeConfig?: boolean;
}

class SeedFileRefused extends Error {
  constructor(readonly reason: ProjectSeedRefusalReason) {
    super(reason);
  }
}

async function readSeedFile(projectRoot: string, name: string): Promise<Buffer | null> {
  const source = path.join(projectRoot, name);
  const listed = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw new SeedFileRefused("unreadable");
  });
  if (!listed) return null;
  if (listed.isSymbolicLink()) throw new SeedFileRefused("symlink");
  if (!listed.isFile()) throw new SeedFileRefused("not-a-file");
  if (listed.size > PROJECT_SEED_FILE_MAX_BYTES) throw new SeedFileRefused("too-large");
  const real = await fs.realpath(source).catch(() => {
    throw new SeedFileRefused("unreadable");
  });
  if (!isPathInsideRoot(real, projectRoot)) throw new SeedFileRefused("outside-project");

  // O_NOFOLLOW refuses a link swapped in since the lstat; O_NONBLOCK keeps a
  // FIFO swapped in from blocking the open. The handle must be the file that
  // was listed.
  const handle = await fs
    .open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      throw new SeedFileRefused(error.code === "ELOOP" ? "symlink" : "unreadable");
    });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new SeedFileRefused("not-a-file");
    if (opened.dev !== listed.dev || opened.ino !== listed.ino) {
      throw new SeedFileRefused("changed-while-reading");
    }
    const buffer = Buffer.alloc(PROJECT_SEED_FILE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > PROJECT_SEED_FILE_MAX_BYTES) throw new SeedFileRefused("too-large");
    return Buffer.from(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof SeedFileRefused) throw error;
    throw new SeedFileRefused("unreadable");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function displayName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f\\]/g, "?");
}

async function readWithFallback(
  projectRoot: string,
  fallbackRoot: string | null,
  name: string,
  mayFallBack: boolean,
): Promise<Buffer | null> {
  // Only absence permits fallback. A refusal must never be replaced by a
  // second source, even when the command-node manifest lists this name.
  const contents = await readSeedFile(projectRoot, name);
  if (contents !== null || !fallbackRoot || !mayFallBack) return contents;
  return readSeedFile(fallbackRoot, name);
}

/** Reads and checks the project's seed files. Never throws for a refused file. */
export async function readProjectSeedFiles(
  projectPath: string,
  options: ReadProjectSeedFilesOptions = {},
): Promise<ReadProjectSeedFiles> {
  const result: ReadProjectSeedFiles = { accepted: [], refused: [], handled: [] };
  const projectRoot = await fs.realpath(projectPath).catch(() => null);
  // A missing project folder has no seed files, as before.
  if (!projectRoot) return result;
  const fallbackRoot = options.fallbackPath
    ? await fs.realpath(options.fallbackPath).catch(() => null)
    : null;
  const fallbackNames = new Set(options.fallbackNames ?? []);
  const excluded = new Set(options.exclude ?? []);
  const includeOpenCode = options.includeOpenCodeConfig ?? true;

  const found = await findEnvFilePatternCandidates(
    projectRoot,
    options.envFilePatterns ?? DEFAULT_ENV_FILE_PATTERNS,
  );
  for (const { name, reason } of found.refused) {
    result.refused.push({ name: displayName(name), reason });
  }
  const candidates = found.candidates.filter(
    ({ name }) => !excluded.has(name) && !(includeOpenCode && name === PROJECT_OPENCODE_SEED.name),
  );
  result.handled.push(...candidates.map(({ name }) => name));

  const aggregate = (reason: ProjectSeedRefusalReason) =>
    result.refused.push({ name: ENV_FILE_PATTERNS_REFUSAL_NAME, reason });
  if (found.scanLimitReached) aggregate("scan-limit");
  else if (candidates.length > ENV_FILE_PATTERN_LIMITS.matches) aggregate("too-many-matches");
  else {
    const accepted: ReadProjectSeedFiles["accepted"] = [];
    let totalBytes = 0;
    for (const { name, literal } of candidates) {
      if (hasUnsafeNameCharacters(name)) {
        result.refused.push({ name: displayName(name), reason: "unsafe-name" });
        continue;
      }
      try {
        const contents = await readWithFallback(
          projectRoot,
          fallbackRoot,
          name,
          literal && fallbackNames.has(name),
        );
        if (!contents) continue;
        totalBytes += contents.length;
        accepted.push({ name, target: envFileContainerTarget(name), contents });
      } catch (error) {
        result.refused.push({
          name,
          reason: error instanceof SeedFileRefused ? error.reason : "unreadable",
        });
      }
    }
    if (totalBytes > ENV_FILE_PATTERN_LIMITS.totalBytes) aggregate("matches-too-large");
    else result.accepted.push(...accepted);
  }

  if (includeOpenCode) {
    const { name, target } = PROJECT_OPENCODE_SEED;
    result.handled.push(name);
    try {
      const contents = await readWithFallback(
        projectRoot,
        fallbackRoot,
        name,
        fallbackNames.has(name),
      );
      if (contents) result.accepted.push({ name, target, contents });
    } catch (error) {
      result.refused.push({
        name,
        reason: error instanceof SeedFileRefused ? error.reason : "unreadable",
      });
    }
  }
  return result;
}

/**
 * The patterns and exclusions one environment's read uses. A reserved name
 * (`.env`, `.env.local`) that the repository's files-to-copy list or a
 * command node's staged manifest names is read here as a literal pattern, as
 * it always was, so removing it from the setting does not drop a file those
 * lists asked for. Every other files-to-copy entry stays with that copy.
 */
export function projectSeedReadPlan(
  envFilePatterns: readonly string[] | undefined,
  filesToCopy: readonly string[],
  seededFiles: readonly string[],
): { envFilePatterns: string[]; exclude: string[] } {
  const reservedListed = [...filesToCopy, ...seededFiles].filter(
    (name) => RESERVED_PROJECT_SEED_NAMES.has(name) && name !== PROJECT_OPENCODE_SEED.name,
  );
  return {
    envFilePatterns: [
      ...new Set([...(envFilePatterns ?? DEFAULT_ENV_FILE_PATTERNS), ...reservedListed]),
    ],
    exclude: filesToCopy.filter((name) => !RESERVED_PROJECT_SEED_NAMES.has(name)),
  };
}

/**
 * The files-to-copy entries the generic staging still copies after this
 * reader. `.env` and `.env.local` never go to that staging. `opencode.json`
 * stays with it when the reader did not take it (`includeOpenCodeConfig:
 * false`, a local worktree): an untracked or command-node copy listed in
 * files-to-copy is not in the worktree's checkout, and dropping it would lose
 * a file that list asked for.
 */
export function filesLeftForConfiguredCopy(
  filesToCopy: readonly string[],
  read: Pick<ReadProjectSeedFiles, "handled">,
  options: Pick<ReadProjectSeedFilesOptions, "includeOpenCodeConfig"> = {},
): string[] {
  const includeOpenCode = options.includeOpenCodeConfig ?? true;
  const reserved = [...RESERVED_PROJECT_SEED_NAMES].filter(
    (name) => includeOpenCode || name !== PROJECT_OPENCODE_SEED.name,
  );
  const handled = new Set([...read.handled, ...reserved]);
  return filesToCopy.filter((name) => !handled.has(name));
}

/**
 * Writes accepted files into a fresh local worktree. A path the branch
 * already has (a committed file, or a link, dangling or not) is left alone,
 * as `.env` always was; a link on the way to it is refused rather than
 * written through. `wx` creates the file and never follows a final link.
 */
export async function writeProjectSeedFilesToWorktree(
  worktreeRoot: string,
  files: ReadProjectSeedFiles["accepted"],
): Promise<ProjectSeedRefusal[]> {
  const refused: ProjectSeedRefusal[] = [];
  for (const file of files) {
    const parts = file.name.split("/");
    let current = worktreeRoot;
    let blocked = false;
    let exists = false;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stats = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stats) break;
      if (index === parts.length - 1) exists = true;
      else if (stats.isSymbolicLink() || !stats.isDirectory()) blocked = true;
      if (blocked) break;
    }
    if (blocked) {
      refused.push({ name: file.name, reason: "linked-destination" });
      continue;
    }
    if (exists) continue;
    const destination = path.join(worktreeRoot, ...parts);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs
      .writeFile(destination, file.contents, { mode: 0o600, flag: "wx" })
      .catch((error: NodeJS.ErrnoException) => {
        // Something appeared there since the check: leave it, as above.
        if (error.code !== "EEXIST") throw error;
      });
  }
  return refused;
}

/**
 * Copies accepted seed files into a created, not yet started container, at
 * the paths the image's setup reads (`/project-env/<name>` for `.env` and
 * `/.env.local`, `/project-files/<path>` for every other match, which the
 * setup copies into `/workspace/<path>`, and `/opencode-project-json`). The
 * setup refuses a committed link on the destination path
 * (`copy_project_file_into_workspace` in `docker/workspace-setup.sh`).
 * Archive ownership is explicit: docker cp's default root ownership would
 * make 0700/0600 inputs unreadable on old images.
 */
export async function copyProjectSeedFilesIntoContainer(
  containerId: string,
  files: ReadProjectSeedFiles["accepted"],
): Promise<void> {
  if (files.length === 0) return;
  const archive = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  })();
  // Bounded: the matches total at most ENV_FILE_PATTERN_LIMITS.totalBytes,
  // plus one 1 MiB opencode.json and fixed tar headers.
  const owner = { uid: 1000, gid: 1000, uname: "node", gname: "node" };
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.target.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join("/"));
    }
  }
  // A parent always sorts before its children.
  for (const directory of [...directories].sort()) {
    archive.entry({ name: directory, type: "directory", mode: 0o700, ...owner });
  }
  for (const file of files) {
    archive.entry({ name: file.target, mode: 0o600, ...owner }, file.contents);
  }
  archive.finalize();
  // The CLI reports a refused stream copy as "must be a directory"; a busy
  // filesystem is retried (`copyIntoContainer`).
  await copyIntoContainer(
    containerId,
    ["cp", "-a", "-", `${containerId}:/`],
    { stdin: await collected, timeoutMs: 120_000 },
    "the project seed files into the container",
  );
}

/** A label holds at most this many refusals; the rest are only logged. */
export const PROJECT_SEED_REFUSAL_LABEL_MAX_ENTRIES = 24;
const REFUSAL_NAME_MAX_LENGTH = 512;

/**
 * Container label value: `.env=symlink,opencode.json=outside-project`. Names
 * are URI-encoded, so a matched path holding `,` or `=` cannot split an entry
 * (the fixed names encode to themselves, so older labels still parse).
 */
export function projectSeedRefusalLabel(refused: readonly ProjectSeedRefusal[]): string {
  return refused
    .slice(0, PROJECT_SEED_REFUSAL_LABEL_MAX_ENTRIES)
    .map(({ name, reason }) => `${encodeURIComponent(name)}=${reason}`)
    .join(",");
}

export function parseProjectSeedRefusalLabel(value: string | null): ProjectSeedRefusal[] {
  if (!value) return [];
  const reasons = new Set<string>(PROJECT_SEED_REFUSAL_REASONS);
  const refused: ProjectSeedRefusal[] = [];
  for (const entry of value.split(",").slice(0, PROJECT_SEED_REFUSAL_LABEL_MAX_ENTRIES)) {
    const [encoded, reason, extra] = entry.split("=");
    if (!encoded || !reason || extra !== undefined || !reasons.has(reason)) continue;
    let name: string;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    // The label is shown in a terminal: never let it carry a control sequence.
    if (name.length > REFUSAL_NAME_MAX_LENGTH || hasUnsafeNameCharacters(name)) continue;
    refused.push({ name, reason: reason as ProjectSeedRefusalReason });
  }
  return refused;
}

/** The refusals recorded on a container; none when it predates the label. */
export async function readProjectSeedRefusals(containerId: string): Promise<ProjectSeedRefusal[]> {
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "inspect",
        "-f",
        `{{ index .Config.Labels "${DOCKER_LABEL_PROJECT_SEED_REFUSED}" }}`,
        containerId,
      ],
      { timeoutMs: 10_000 },
    );
    const value = stdout.trim();
    return parseProjectSeedRefusalLabel(value === "<no value>" ? null : value);
  } catch {
    return [];
  }
}

const REFUSAL_EXPLANATIONS: Record<ProjectSeedRefusalReason, string> = {
  symlink: "it is a symbolic link",
  "not-a-file": "it is not a regular file",
  "outside-project": "it resolves outside the project folder",
  "too-large": `it is larger than ${PROJECT_SEED_FILE_MAX_BYTES / (1024 * 1024)} MiB`,
  "changed-while-reading": "it changed while it was being read",
  unreadable: "it could not be read",
  "invalid-pattern":
    "it is not a usable pattern (patterns are relative paths using * and ?, without **, .. or .git)",
  "too-many-patterns": `only the first ${ENV_FILE_PATTERN_LIMITS.patterns} patterns are used`,
  "unsafe-name": "its name holds a control character or a backslash",
  "linked-destination": "the new worktree has a link on its path",
  "too-many-matches": `the patterns match more than ${ENV_FILE_PATTERN_LIMITS.matches} files, so none was copied`,
  "matches-too-large": `the matching files total more than ${ENV_FILE_PATTERN_LIMITS.totalBytes / (1024 * 1024)} MiB, so none was copied`,
  "scan-limit": `matching looked at more than ${ENV_FILE_PATTERN_LIMITS.scannedEntries} directory entries, so none was copied`,
};

const PATTERN_REASONS: ReadonlySet<ProjectSeedRefusalReason> = new Set([
  "too-many-matches",
  "matches-too-large",
  "scan-limit",
]);

/** One line per refused file, for the setup terminal. */
export function formatProjectSeedRefusals(
  refused: readonly ProjectSeedRefusal[],
  destination: "container" | "worktree" = "container",
): string[] {
  const into = destination === "container" ? "the container" : "the worktree";
  return refused.map(({ name, reason }) => {
    const explanation = REFUSAL_EXPLANATIONS[reason];
    if (reason === "invalid-pattern" || reason === "too-many-patterns") {
      return (
        `[orkestrator] Ignored the Environment Files pattern ${JSON.stringify(name)}: ` +
        `${explanation}. Edit it in Settings.`
      );
    }
    if (PATTERN_REASONS.has(reason)) {
      return (
        `[orkestrator] Copied no Environment Files matches into ${into}: ${explanation}. ` +
        "Narrow the patterns in Settings."
      );
    }
    return (
      `[orkestrator] Skipped ${name} from the project folder: ${explanation}. ` +
      `Only a regular file inside the project is copied into ${into}.`
    );
  });
}

/**
 * Refusals from creating a local worktree, held until its setup terminal
 * shows them once. Bounded: a worktree whose setup never runs cannot grow it.
 */
const pendingWorktreeRefusals = new Map<string, ProjectSeedRefusal[]>();
const PENDING_WORKTREE_REFUSALS_MAX = 64;

export function rememberWorktreeSeedRefusals(
  environmentId: string,
  refused: readonly ProjectSeedRefusal[],
): void {
  pendingWorktreeRefusals.delete(environmentId);
  if (refused.length === 0) return;
  while (pendingWorktreeRefusals.size >= PENDING_WORKTREE_REFUSALS_MAX) {
    const oldest = pendingWorktreeRefusals.keys().next().value;
    if (oldest === undefined) break;
    pendingWorktreeRefusals.delete(oldest);
  }
  pendingWorktreeRefusals.set(
    environmentId,
    refused.slice(0, PROJECT_SEED_REFUSAL_LABEL_MAX_ENTRIES),
  );
}

export function takeWorktreeSeedRefusals(environmentId: string): ProjectSeedRefusal[] {
  const refused = pendingWorktreeRefusals.get(environmentId) ?? [];
  pendingWorktreeRefusals.delete(environmentId);
  return refused;
}
