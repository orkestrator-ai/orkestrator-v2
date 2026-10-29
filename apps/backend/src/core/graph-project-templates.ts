import { constants as fsConstants, promises as fs, watch } from "node:fs";
import path from "node:path";
import {
  GRAPH_LIBRARY_BOUNDS,
  GRAPH_PROJECT_TEMPLATE_DIRECTORY,
  GRAPH_PROJECT_TEMPLATE_SUFFIX,
  graphProjectTemplatePath,
  type GraphProjectTemplateProblem,
  type GraphProjectTemplateSource,
} from "@orkestrator/protocol/graphs/library";
import { graphTemplateDigest } from "@orkestrator/protocol/graphs/compile";
import { parseGraphTemplate, type GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { isPathInsideRoot } from "./commands-project-files.js";
import { GraphTemplateError } from "./graph-template-errors.js";

/**
 * Project templates (D2, report §6.9): `.orkestrator/graphs/*.graph.json` in
 * the project's checkout on this machine (`Project.localPath`). A project on
 * another machine is read by that machine's backend; a project with no local
 * checkout has none.
 *
 * Reading is bounded (file count, bytes per file and in total), confined to
 * the checkout (the directory's real path must stay inside it, and only
 * regular files are opened, without following links), and never logs or
 * reports file contents. A scan is reused while the directory listing and
 * every file's identity, size and times are unchanged.
 *
 * Re-reading on change: the first scan of a project starts one
 * **non-recursive** watch on the deepest existing directory of
 * `.orkestrator/graphs`, `.orkestrator` or the checkout root (so creating the
 * directory is noticed too). An event drops the cached scan and, after a
 * short settle, rescans; when the templates changed, `onChange` is called so
 * clients re-read. Events are hints: the fingerprint check on every scan is
 * what keeps a missed event harmless. Non-recursive watches close without the
 * multi-second stall a recursive macOS watch has.
 */

export interface GraphProjectTemplateFile {
  /** `.orkestrator/graphs/<name>.graph.json`. */
  path: string;
  template: GraphTemplateV1;
  /** `graphTemplateDigest(template)`. */
  digest: string;
  bytes: number;
}

export interface GraphProjectTemplateScan {
  source: GraphProjectTemplateSource;
  /** Valid templates, by path. */
  files: GraphProjectTemplateFile[];
}

export interface GraphProjectWatchHandle {
  close(): void;
}

export type StartGraphProjectWatch = (
  directory: string,
  onEvent: () => void,
  onError: (error: unknown) => void,
) => GraphProjectWatchHandle;

export interface GraphProjectTemplatesOptions {
  /** The project's local checkout, or null without one; throws when the project is unknown. */
  checkoutOf: (projectId: string) => Promise<string | null>;
  /** The templates of a watched project changed on disk. */
  onChange?: (projectId: string) => void;
  /** Injected for tests; defaults to a non-recursive, non-persistent `fs.watch`. */
  startWatch?: StartGraphProjectWatch | null;
  settleMs?: number;
  /** Projects watched at once; the least recently scanned stops first. */
  maxWatchedProjects?: number;
}

const DEFAULT_SETTLE_MS = 250;
const DEFAULT_MAX_WATCHED_PROJECTS = 32;
const MAX_PROBLEM_ERRORS = 5;

const defaultStartWatch: StartGraphProjectWatch = (directory, onEvent, onError) => {
  const watcher = watch(directory, { persistent: false, recursive: false }, () => onEvent());
  watcher.on("error", onError);
  return watcher;
};

interface CachedScan {
  root: string;
  fingerprint: string;
  scan: GraphProjectTemplateScan;
}

interface ProjectWatch {
  target: string;
  handle: GraphProjectWatchHandle;
  timer?: ReturnType<typeof setTimeout>;
  signature?: string;
}

function emptySource(
  projectId: string,
  status: GraphProjectTemplateSource["status"],
  problems: GraphProjectTemplateProblem[] = [],
): GraphProjectTemplateSource {
  return {
    projectId,
    status,
    directory: GRAPH_PROJECT_TEMPLATE_DIRECTORY,
    files: 0,
    truncated: false,
    problems,
  };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** What the templates are, for "did anything change" (paths, digests, problems). */
function scanSignature(scan: GraphProjectTemplateScan): string {
  return JSON.stringify([
    scan.source.status,
    scan.source.truncated,
    scan.files.map((file) => [file.path, file.digest]),
    scan.source.problems.map((problem) => [problem.path, problem.code]),
  ]);
}

export class GraphProjectTemplates {
  private readonly cache = new Map<string, CachedScan>();
  private readonly watches = new Map<string, ProjectWatch>();
  private readonly startWatch: StartGraphProjectWatch | null;
  private readonly settleMs: number;
  private readonly maxWatchedProjects: number;
  private closed = false;

  constructor(private readonly options: GraphProjectTemplatesOptions) {
    this.startWatch = options.startWatch === undefined ? defaultStartWatch : options.startWatch;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.maxWatchedProjects = options.maxWatchedProjects ?? DEFAULT_MAX_WATCHED_PROJECTS;
  }

  /** The project's templates now (from cache when nothing changed). */
  async scan(projectId: string): Promise<GraphProjectTemplateScan> {
    const checkout = await this.options.checkoutOf(projectId);
    if (!checkout) {
      this.forget(projectId);
      return { source: emptySource(projectId, "no-checkout"), files: [] };
    }
    let root: string;
    try {
      root = await fs.realpath(checkout);
    } catch {
      this.forget(projectId);
      return {
        source: emptySource(projectId, "unavailable", [
          {
            path: GRAPH_PROJECT_TEMPLATE_DIRECTORY,
            code: "unreadable",
            message: "The project's checkout cannot be read",
          },
        ]),
        files: [],
      };
    }
    const scan = await this.read(projectId, root);
    this.watch(projectId, root, scan);
    return scan;
  }

  /** Stop watching a project and drop its cached scan (project removed or relocated). */
  forget(projectId: string): void {
    this.cache.delete(projectId);
    this.forgetWatch(projectId);
  }

  /** Stops every watch. Non-recursive watches close without blocking. */
  close(): void {
    this.closed = true;
    for (const projectId of this.watches.keys()) this.forget(projectId);
    this.cache.clear();
  }

  /** Projects watched now (tests). */
  watchedProjects(): string[] {
    return [...this.watches.keys()];
  }

  private async read(projectId: string, root: string): Promise<GraphProjectTemplateScan> {
    const directory = path.join(root, ...GRAPH_PROJECT_TEMPLATE_DIRECTORY.split("/"));
    let realDirectory: string;
    try {
      realDirectory = await fs.realpath(directory);
    } catch (error) {
      if (isMissing(error)) {
        const scan = { source: emptySource(projectId, "ok"), files: [] };
        this.cache.set(projectId, { root, fingerprint: "missing", scan });
        return scan;
      }
      return {
        source: this.unavailable(projectId, "The template directory cannot be read"),
        files: [],
      };
    }
    if (!isPathInsideRoot(realDirectory, root)) {
      return {
        source: this.unavailable(projectId, "The template directory leads outside the checkout"),
        files: [],
      };
    }
    let names: string[];
    try {
      names = (await fs.readdir(realDirectory))
        .filter((name) => name.endsWith(GRAPH_PROJECT_TEMPLATE_SUFFIX))
        .sort();
    } catch {
      return {
        source: this.unavailable(projectId, "The template directory cannot be read"),
        files: [],
      };
    }

    const problems: GraphProjectTemplateProblem[] = [];
    const truncated = names.length > GRAPH_LIBRARY_BOUNDS.maxProjectFiles;
    if (truncated) {
      problems.push({
        path: GRAPH_PROJECT_TEMPLATE_DIRECTORY,
        code: "too-many-files",
        message: `Only the first ${GRAPH_LIBRARY_BOUNDS.maxProjectFiles} template files (by name) are read`,
      });
      names = names.slice(0, GRAPH_LIBRARY_BOUNDS.maxProjectFiles);
    }

    // Stat everything first: the fingerprint decides whether to read at all.
    const candidates: { name: string; relative: string; size: number }[] = [];
    const fingerprint: string[] = [];
    for (const name of names) {
      const relative = graphProjectTemplatePath(name);
      if (!relative) {
        problems.push({
          path: `${GRAPH_PROJECT_TEMPLATE_DIRECTORY}/${name.slice(0, GRAPH_LIBRARY_BOUNDS.maxProjectFileNameChars)}`,
          code: "invalid-name",
          message: "Template file names use letters, digits, '.', '_' and '-' only",
        });
        continue;
      }
      try {
        const stat = await fs.lstat(path.join(realDirectory, name));
        fingerprint.push(`${name}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
        if (!stat.isFile()) {
          problems.push({
            path: relative,
            code: "not-a-file",
            message: "Only regular files are read (links are not followed)",
          });
          continue;
        }
        candidates.push({ name, relative, size: stat.size });
      } catch {
        problems.push({ path: relative, code: "unreadable", message: "The file cannot be read" });
      }
    }
    const key = `${realDirectory}\n${names.length}\n${fingerprint.join("\n")}`;
    const cached = this.cache.get(projectId);
    if (cached && cached.root === root && cached.fingerprint === key) return cached.scan;

    const files: GraphProjectTemplateFile[] = [];
    let totalBytes = 0;
    let fileCount = 0;
    for (const candidate of candidates) {
      fileCount += 1;
      if (candidate.size > GRAPH_LIBRARY_BOUNDS.maxProjectFileBytes) {
        problems.push({
          path: candidate.relative,
          code: "too-large",
          message: `A template file is at most ${GRAPH_LIBRARY_BOUNDS.maxProjectFileBytes} bytes`,
        });
        continue;
      }
      if (totalBytes + candidate.size > GRAPH_LIBRARY_BOUNDS.maxProjectTotalBytes) {
        problems.push({
          path: candidate.relative,
          code: "total-too-large",
          message: `Template files are read up to ${GRAPH_LIBRARY_BOUNDS.maxProjectTotalBytes} bytes per project`,
        });
        continue;
      }
      const read = await readBoundedFile(
        path.join(realDirectory, candidate.name),
        GRAPH_LIBRARY_BOUNDS.maxProjectFileBytes,
      );
      if (!read.ok) {
        problems.push({ path: candidate.relative, code: read.code, message: read.message });
        continue;
      }
      totalBytes += read.bytes;
      const parsed = parseGraphTemplate(read.text);
      if (!parsed.ok) {
        problems.push({
          path: candidate.relative,
          code: "invalid-template",
          message: `The file is not a valid graph template (${parsed.errors.length + parsed.omittedErrors} problems)`,
          errors: parsed.errors.slice(0, MAX_PROBLEM_ERRORS),
        });
        continue;
      }
      files.push({
        path: candidate.relative,
        template: parsed.value,
        digest: graphTemplateDigest(parsed.value),
        bytes: read.bytes,
      });
    }
    problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const scan: GraphProjectTemplateScan = {
      source: {
        projectId,
        status: "ok",
        directory: GRAPH_PROJECT_TEMPLATE_DIRECTORY,
        files: fileCount,
        truncated,
        problems,
      },
      files,
    };
    this.cache.set(projectId, { root, fingerprint: key, scan });
    return scan;
  }

  private unavailable(projectId: string, message: string): GraphProjectTemplateSource {
    this.cache.delete(projectId);
    return emptySource(projectId, "unavailable", [
      { path: GRAPH_PROJECT_TEMPLATE_DIRECTORY, code: "unreadable", message },
    ]);
  }

  /** Watch the deepest existing directory on the way to the template directory. */
  private watch(projectId: string, root: string, scan: GraphProjectTemplateScan): void {
    if (this.closed || !this.startWatch) return;
    void this.watchTarget(root).then((target) => {
      if (this.closed) return;
      const existing = this.watches.get(projectId);
      if (existing && existing.target === target) {
        // Most recently scanned last, for eviction.
        this.watches.delete(projectId);
        this.watches.set(projectId, existing);
        existing.signature ??= scanSignature(scan);
        return;
      }
      this.forgetWatch(projectId);
      let handle: GraphProjectWatchHandle;
      try {
        handle = this.startWatch!(
          target,
          () => this.onEvent(projectId),
          () => this.forget(projectId),
        );
      } catch {
        // No watch (descriptor limits, unsupported filesystem): scans still
        // fingerprint the directory, so changes are seen on the next list.
        return;
      }
      this.watches.set(projectId, { target, handle, signature: scanSignature(scan) });
      while (this.watches.size > this.maxWatchedProjects) {
        const oldest = this.watches.keys().next().value;
        if (oldest === undefined) break;
        this.forget(oldest);
      }
    });
  }

  private forgetWatch(projectId: string): void {
    const existing = this.watches.get(projectId);
    if (!existing) return;
    this.watches.delete(projectId);
    if (existing.timer) clearTimeout(existing.timer);
    existing.handle.close();
  }

  private async watchTarget(root: string): Promise<string> {
    const parts = GRAPH_PROJECT_TEMPLATE_DIRECTORY.split("/");
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const candidate = path.join(root, ...parts.slice(0, depth));
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isDirectory()) return candidate;
      } catch {
        // Try the parent.
      }
    }
    return root;
  }

  private onEvent(projectId: string): void {
    const watch = this.watches.get(projectId);
    if (!watch || this.closed) return;
    this.cache.delete(projectId);
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      void this.rescan(projectId, watch);
    }, this.settleMs);
    watch.timer.unref?.();
  }

  private async rescan(projectId: string, watch: ProjectWatch): Promise<void> {
    let scan: GraphProjectTemplateScan;
    try {
      scan = await this.scan(projectId);
    } catch (error) {
      // The project is gone: stop watching it.
      if (error instanceof GraphTemplateError) this.forget(projectId);
      return;
    }
    const current = this.watches.get(projectId) ?? watch;
    const signature = scanSignature(scan);
    if (current.signature === signature) return;
    current.signature = signature;
    this.options.onChange?.(projectId);
  }
}

type BoundedRead =
  | { ok: true; text: string; bytes: number }
  | {
      ok: false;
      code: "too-large" | "unreadable" | "not-a-file" | "invalid-template";
      message: string;
    };

/** Reads a regular file without following a final link, refusing more than `maxBytes`. */
async function readBoundedFile(filePath: string, maxBytes: number): Promise<BoundedRead> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ELOOP"
      ? {
          ok: false,
          code: "not-a-file",
          message: "Only regular files are read (links are not followed)",
        }
      : { ok: false, code: "unreadable", message: "The file cannot be read" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { ok: false, code: "not-a-file", message: "Only regular files are read" };
    }
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) {
      return {
        ok: false,
        code: "too-large",
        message: `A template file is at most ${maxBytes} bytes`,
      };
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      return { ok: true, text, bytes: length };
    } catch {
      return { ok: false, code: "invalid-template", message: "The file is not UTF-8 text" };
    }
  } catch {
    return { ok: false, code: "unreadable", message: "The file cannot be read" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
