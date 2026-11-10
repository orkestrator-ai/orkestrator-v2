import { constants as fsConstants, promises as fs } from "node:fs";
import { pack } from "tar-stream";
import path from "node:path";
import { isPathInsideRoot } from "./commands-project-files.js";
import { DOCKER_LABEL_PROJECT_SEED_REFUSED } from "./constants.js";
import { classifyDockerCopyFailure } from "./docker-copy-refusal.js";
import { runCommand } from "./shell.js";

/**
 * The project's own `.env`, `.env.local` and `opencode.json`, copied into a
 * new container.
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
 * in the setup terminal.
 */

export const PROJECT_SEED_FILES = [
  { name: ".env", target: "project-env/.env" },
  { name: ".env.local", target: "project-env/.env.local" },
  { name: "opencode.json", target: "opencode-project-json" },
] as const;

export type ProjectSeedFileName = (typeof PROJECT_SEED_FILES)[number]["name"];

/** Larger than any real dotenv or OpenCode project file. */
export const PROJECT_SEED_FILE_MAX_BYTES = 1024 * 1024;

export const PROJECT_SEED_REFUSAL_REASONS = [
  "symlink",
  "not-a-file",
  "outside-project",
  "too-large",
  "changed-while-reading",
  "unreadable",
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

/** Reads and checks the project's seed files. Never throws for a refused file. */
export async function readProjectSeedFiles(
  projectPath: string,
  fallbackPath?: string,
  fallbackNames: readonly string[] = [],
): Promise<ReadProjectSeedFiles> {
  const result: ReadProjectSeedFiles = { accepted: [], refused: [] };
  const projectRoot = await fs.realpath(projectPath).catch(() => null);
  // A missing project folder has no seed files, as before.
  if (!projectRoot) return result;
  const fallbackRoot = fallbackPath ? await fs.realpath(fallbackPath).catch(() => null) : null;
  for (const { name, target } of PROJECT_SEED_FILES) {
    try {
      // Only absence permits fallback. A refusal must never be replaced by a
      // second source, even when the command-node manifest lists this name.
      let contents = await readSeedFile(projectRoot, name);
      if (contents === null && fallbackRoot && fallbackNames.includes(name)) {
        contents = await readSeedFile(fallbackRoot, name);
      }
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
 * Copies accepted seed files into a created, not yet started container, at
 * the paths the image's setup reads (`/project-env/<name>`,
 * `/opencode-project-json`). Archive ownership is explicit: docker cp's
 * default root ownership would make 0700/0600 inputs unreadable on old images.
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
  // At most three bounded file snapshots plus fixed tar headers enter memory.
  const owner = { uid: 1000, gid: 1000, uname: "node", gname: "node" };
  if (files.some((file) => file.target.startsWith("project-env/"))) {
    archive.entry({ name: "project-env", type: "directory", mode: 0o700, ...owner });
  }
  for (const file of files) {
    archive.entry({ name: file.target, mode: 0o600, ...owner }, file.contents);
  }
  archive.finalize();
  await runCommand("docker", ["cp", "-a", "-", `${containerId}:/`], {
    stdin: await collected,
    timeoutMs: 120_000,
  }).catch(async (error: unknown) => {
    // The CLI reports a refused stream copy as "must be a directory".
    throw await classifyDockerCopyFailure(
      containerId,
      error,
      "the project seed files into the container",
    );
  });
}

/** Container label value: `.env=symlink,opencode.json=outside-project`. */
export function projectSeedRefusalLabel(refused: readonly ProjectSeedRefusal[]): string {
  return refused.map(({ name, reason }) => `${name}=${reason}`).join(",");
}

export function parseProjectSeedRefusalLabel(value: string | null): ProjectSeedRefusal[] {
  if (!value) return [];
  const names = new Set<string>(PROJECT_SEED_FILES.map((file) => file.name));
  const reasons = new Set<string>(PROJECT_SEED_REFUSAL_REASONS);
  const refused: ProjectSeedRefusal[] = [];
  for (const entry of value.split(",")) {
    const [name, reason] = entry.split("=");
    if (name && reason && names.has(name) && reasons.has(reason)) {
      refused.push({
        name: name as ProjectSeedFileName,
        reason: reason as ProjectSeedRefusalReason,
      });
    }
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
};

/** One line per refused file, for the setup terminal. */
export function formatProjectSeedRefusals(refused: readonly ProjectSeedRefusal[]): string[] {
  return refused.map(
    ({ name, reason }) =>
      `[orkestrator] Skipped ${name} from the project folder: ${REFUSAL_EXPLANATIONS[reason]}. ` +
      "Only a regular file inside the project is copied into the container.",
  );
}
