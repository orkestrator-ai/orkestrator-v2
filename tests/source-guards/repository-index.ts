import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * One listing of the repository and one read per file, shared by every
 * repository-wide guard (`scripts/guards.ts`). Each guard used to walk the
 * tree and read its files itself, so a guard run cost a dozen walks.
 *
 * The listing is `git ls-files -co --exclude-standard`: tracked files plus
 * untracked ones that are not ignored, which is what a commit could contain.
 * Dependencies, build output and other ignored paths are never listed.
 */
export interface SourceIndex {
  /** Repository-relative, `/`-separated, sorted. May name a tracked file deleted from the working tree. */
  readonly files: readonly string[];
  /**
   * The file's text, or `null` when it is not a regular file in the working
   * tree (deleted, a directory, or a symbolic link, which is never followed).
   */
  read(relative: string): string | null;
}

export class RepositoryIndex implements SourceIndex {
  private readonly sources = new Map<string, string | null>();

  constructor(
    readonly root: string,
    readonly files: readonly string[],
  ) {}

  /** The listing Git gives for `root`, in one `git ls-files` call. */
  static fromGit(root: string): RepositoryIndex {
    const result = spawnSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`git ls-files failed in ${root}: ${result.stderr || result.error?.message}`);
    const files = [...new Set(result.stdout.split("\0").filter((file) => file.length > 0))].sort();
    return new RepositoryIndex(root, files);
  }

  /**
   * Every regular file under `root`, without Git: the guards' fixture tests
   * build trees in temporary directories. Skips `node_modules`, `dist` and
   * `.git`, and never follows a directory symlink.
   */
  static fromWalk(root: string): RepositoryIndex {
    const files: string[] = [];
    const visit = (relativeDirectory: string): void => {
      const entries = readdirSync(path.join(root, relativeDirectory), { withFileTypes: true });
      for (const entry of entries) {
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!WALK_SKIPPED_DIRECTORIES.has(entry.name)) visit(relative);
        } else if (entry.isFile()) {
          files.push(relative);
        }
      }
    };
    visit("");
    return new RepositoryIndex(root, files.sort());
  }

  read(relative: string): string | null {
    if (this.sources.has(relative)) return this.sources.get(relative)!;
    let source: string | null = null;
    const absolute = path.join(this.root, relative);
    try {
      if (lstatSync(absolute).isFile()) source = readFileSync(absolute, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    this.sources.set(relative, source);
    return source;
  }

  /** Files equal to `prefix` or beneath it, as `git ls-files -- <prefix>` lists them. */
  under(prefix: string): string[] {
    const directory = `${prefix.replace(/\/+$/, "")}/`;
    return this.files.filter((file) => file === prefix || file.startsWith(directory));
  }
}

const WALK_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", "dist", ".git"]);

/** Whether any directory on `relative`'s path is one of `names`. */
export function underDirectoryNamed(relative: string, names: ReadonlySet<string>): boolean {
  const segments = relative.split("/");
  segments.pop();
  return segments.some((segment) => names.has(segment));
}
