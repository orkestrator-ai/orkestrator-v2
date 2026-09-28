/**
 * Measure the files a shell command changed, for the +N −M badge a shell tool
 * row shows alongside the one an edit tool row already has.
 *
 * A shell command's input says nothing reliable about what it will write —
 * `sed -i`, a heredoc'd Python script, a codemod and `git mv` all look alike —
 * so the change is measured rather than parsed. Around each command the probe
 * snapshots the worktree into a throwaway index (`GIT_INDEX_FILE` pointing at
 * a copy of the real one, `git add`, `git write-tree`) and diffs the two trees
 * with `git diff --numstat`. The real index, the working tree and every ref
 * are left alone. Snapshot objects live in a private temporary object store,
 * with the repository's objects available only as read-only alternates.
 *
 * Node-only: bridges and the backend import this subpath, never a renderer.
 *
 * Costs and their bounds:
 * - one snapshot at a time per repository, and callers that arrive while one
 *   is queued share it rather than taking their own;
 * - untracked files over {@link DEFAULT_MAX_UNTRACKED_FILE_BYTES} are never
 *   hashed, so a large log or database cannot be copied into the object store
 *   on every command — a change to one marks the result approximate instead;
 * - a repository with more than {@link DEFAULT_MAX_UNTRACKED_FILES} untracked
 *   files, or whose snapshots are repeatedly slower than
 *   {@link DEFAULT_SLOW_SNAPSHOT_MS}, stops being measured for the life of the
 *   probe. A missing badge costs less than an agent slowed on every command.
 *
 * A window measures everything that changed during it, not only what the
 * command wrote. Two measured or noted calls whose windows overlap in the same
 * repository are therefore reported `approximate`.
 *
 * Two ways to open a window:
 * - a provider with a pre-tool hook holds the command until {@link begin} has
 *   taken a fresh "before" snapshot;
 * - a provider that only reports a command once it is already running cannot
 *   snapshot in time — a fast `sed -i` would be over before the snapshot
 *   started. It opens with `{ baseline: true }` instead, and the "before" is
 *   the repository's latest snapshot: the one {@link prime} took at turn start,
 *   or the "after" of the previous measured or noted call, which is when the
 *   tree last changed as far as the agent is concerned.
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { MeasuredFileChange, MeasuredWorkspaceChange } from "./tool-diff.js";

export const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_UNTRACKED_FILES = 5_000;
export const DEFAULT_SLOW_SNAPSHOT_MS = 500;
/** Consecutive slow snapshots before a repository stops being measured. */
export const SLOW_SNAPSHOT_STRIKES = 2;
export const DEFAULT_MAX_REPORTED_FILES = 50;
/** Calls whose end never arrives (a crashed tool, a lost event) are dropped. */
export const DEFAULT_MAX_OPEN_CALLS = 256;
/**
 * A window open longer than this is presumed abandoned — its end was lost to
 * an interrupt or a denial nobody reported — and stops counting as an overlap.
 * Comfortably above the longest shell timeout the providers allow.
 */
export const DEFAULT_MAX_WINDOW_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const temporaryObjectDirectories = new Set<string>();
process.once("exit", () => {
  for (const directory of temporaryObjectDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Process teardown is best effort; no objects were written to the repo.
    }
  }
});

export interface GitResult {
  stdout: string;
}

/** Runs `git` with `args` in `cwd`; rejects on a non-zero exit. */
export type GitRunner = (
  args: string[],
  options: { cwd: string; env?: Record<string, string>; stdin?: string },
) => Promise<GitResult>;

export const runGit: GitRunner = (args, options) =>
  new Promise((resolvePromise, reject) => {
    const env = { ...process.env, ...options.env, GIT_OPTIONAL_LOCKS: "0" };
    if (options.stdin === undefined) {
      execFile(
        "git",
        args,
        { cwd: options.cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
        (error, stdout) => (error ? reject(error) : resolvePromise({ stdout: String(stdout) })),
      );
      return;
    }
    const child = spawn("git", args, { cwd: options.cwd, env, timeout: GIT_TIMEOUT_MS });
    let stdout = "";
    let stdoutBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= GIT_MAX_BUFFER) stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise({ stdout }) : reject(new Error(`git exited with ${code}`)),
    );
    // A git that exits before reading stdin surfaces EPIPE here, not a crash.
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin);
  });

export interface WorkspaceChangeProbeOptions {
  git?: GitRunner;
  maxUntrackedFileBytes?: number;
  maxUntrackedFiles?: number;
  slowSnapshotMs?: number;
  maxReportedFiles?: number;
  maxOpenCalls?: number;
  maxWindowMs?: number;
  tempDir?: string;
  now?: () => number;
}

interface RepoLocation {
  root: string;
  indexPath: string;
  objectsPath: string;
}

/** Large untracked files left out of a snapshot, by path → size:mtime. */
type SkippedFiles = Map<string, string>;

interface Snapshot {
  tree: string;
  skipped: SkippedFiles;
  objectDirectory: string;
}

interface RepoState {
  location: RepoLocation;
  disabled: boolean;
  slowStrikes: number;
  /** Snapshot currently running, if any. */
  running?: Promise<Snapshot | undefined>;
  /** Snapshot queued behind `running`, shared by everyone who asks meanwhile. */
  queued?: Promise<Snapshot | undefined>;
  /** Calls whose window is open in this repository. */
  open: Set<OpenCall>;
  /** The most recent completed snapshot, the baseline for `{ baseline: true }`. */
  latest?: Snapshot;
  /**
   * Some caller relies on `latest`, so a noted call's end must refresh it:
   * otherwise the next baseline command is charged with that edit.
   */
  keepsBaseline: boolean;
  snapshots: Set<Snapshot>;
  priming: boolean;
}

type OpenMode = "fresh" | "baseline" | "note";

interface OpenCall {
  id: string;
  repo: RepoState;
  measure: boolean;
  openedAt: number;
  overlapped: boolean;
  /** The "before" snapshot was taken after the command may already have run. */
  late: boolean;
  unavailable: boolean;
  before?: Promise<Snapshot | undefined>;
}

export interface BeginOptions {
  /** Measure from the repository's latest snapshot rather than a fresh one. */
  baseline?: boolean;
}

/**
 * One per bridge process. Every method is failure-silent: a probe that cannot
 * measure resolves `undefined` and the row simply shows no badge.
 */
export class WorkspaceChangeProbe {
  private readonly git: GitRunner;
  private readonly maxUntrackedFileBytes: number;
  private readonly maxUntrackedFiles: number;
  private readonly slowSnapshotMs: number;
  private readonly maxReportedFiles: number;
  private readonly maxOpenCalls: number;
  private readonly maxWindowMs: number;
  private readonly tempDir: string;
  private readonly now: () => number;
  /** Keyed by the cwd callers pass; several cwds may share one repository. */
  private readonly locations = new Map<string, Promise<RepoLocation | undefined>>();
  /** Keyed by repository root. */
  private readonly repos = new Map<string, RepoState>();
  private readonly calls = new Map<string, OpenCall>();
  private readonly opening = new Map<string, Promise<OpenCall | undefined>>();

  constructor(options: WorkspaceChangeProbeOptions = {}) {
    this.git = options.git ?? runGit;
    this.maxUntrackedFileBytes = options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES;
    this.maxUntrackedFiles = options.maxUntrackedFiles ?? DEFAULT_MAX_UNTRACKED_FILES;
    this.slowSnapshotMs = options.slowSnapshotMs ?? DEFAULT_SLOW_SNAPSHOT_MS;
    this.maxReportedFiles = options.maxReportedFiles ?? DEFAULT_MAX_REPORTED_FILES;
    this.maxOpenCalls = options.maxOpenCalls ?? DEFAULT_MAX_OPEN_CALLS;
    this.maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
    this.tempDir = options.tempDir ?? tmpdir();
    this.now = options.now ?? (() => performance.now());
  }

  /** Release retained baseline objects when the owning service shuts down. */
  async close(): Promise<void> {
    for (const repo of this.repos.values()) {
      await repo.running;
      await repo.queued;
      repo.keepsBaseline = false;
      repo.latest = undefined;
      await this.releaseUnusedObjects(repo);
    }
  }

  private async releaseUnusedObjects(repo: RepoState): Promise<void> {
    if (repo.open.size > 0 || repo.running || repo.queued) return;
    if (repo.disabled) repo.keepsBaseline = false;
    for (const snapshot of repo.snapshots) {
      if (repo.keepsBaseline && repo.latest === snapshot) continue;
      repo.snapshots.delete(snapshot);
      await this.removeObjectDirectory(snapshot.objectDirectory);
    }
    if (!repo.keepsBaseline) repo.latest = undefined;
  }

  private async removeObjectDirectory(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    temporaryObjectDirectories.delete(directory);
  }

  private objectEnv(
    repo: RepoState,
    directory: string,
    beforeDirectory?: string,
  ): Record<string, string> {
    return {
      GIT_OBJECT_DIRECTORY: directory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: beforeDirectory
        ? `${beforeDirectory}${delimiter}${repo.location.objectsPath}`
        : repo.location.objectsPath,
    };
  }

  /**
   * Open a measured window for a shell call and take its "before" snapshot.
   *
   * Resolves once the snapshot is taken, so a caller able to hold the command
   * (a pre-tool hook) can await it; one that only observes the start fires and
   * forgets with `{ baseline: true }`. Calling it again for an open id is a
   * no-op.
   */
  async begin(cwd: string, callId: string, options: BeginOptions = {}): Promise<void> {
    const call = await this.open(cwd, callId, options.baseline ? "baseline" : "fresh");
    if (call?.before) await call.before;
  }

  /**
   * Take a baseline snapshot, e.g. at turn start, for a provider that opens
   * its windows with `{ baseline: true }`.
   */
  async prime(cwd: string): Promise<void> {
    const repo = await this.repoFor(cwd);
    if (!repo) return;
    repo.keepsBaseline = true;
    repo.priming = true;
    try {
      await this.snapshotShared(repo, "fresh");
    } finally {
      repo.priming = false;
    }
  }

  /**
   * Open an unmeasured window for a call that changes files by other means (an
   * edit tool), so a shell call running alongside it is marked approximate.
   */
  async note(cwd: string, callId: string): Promise<void> {
    await this.open(cwd, callId, "note");
  }

  /**
   * Close a window. For a measured call, take the "after" snapshot and return
   * what changed; `undefined` when nothing could be measured. Zero counts
   * mean measured and untouched, which callers need not persist.
   */
  async end(callId: string): Promise<MeasuredWorkspaceChange | undefined> {
    // An observer that fires `begin` and forgets can see the end before the
    // repository lookup behind that `begin` has finished.
    await this.opening.get(callId);
    const call = this.calls.get(callId);
    if (!call) return undefined;
    this.calls.delete(callId);
    try {
      if (!call.measure || !call.before) {
        if (call.repo.keepsBaseline && !call.repo.disabled) {
          await this.snapshotShared(call.repo, "fresh");
        }
        return undefined;
      }

      const before = await call.before;
      if (!before || call.repo.disabled) return undefined;
      const after = await this.snapshotShared(call.repo, "fresh");
      if (!after || call.unavailable) return undefined;

      const change = await this.diff(call.repo, before, after).catch(() => undefined);
      if (!change) return undefined;
      if (call.overlapped || call.late || skippedFilesChanged(before.skipped, after.skipped)) {
        change.approximate = true;
      }
      return change;
    } finally {
      call.repo.open.delete(call);
      await this.releaseUnusedObjects(call.repo);
    }
  }

  /** Drop a window without measuring, e.g. a call that was denied. */
  discard(callId: string): void {
    const pending = this.opening.get(callId);
    if (pending) void pending.then(() => this.discardNow(callId));
    this.discardNow(callId);
  }

  private discardNow(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    this.calls.delete(callId);
    call.repo.open.delete(call);
    void this.releaseUnusedObjects(call.repo);
  }

  private open(cwd: string, callId: string, mode: OpenMode): Promise<OpenCall | undefined> {
    const pending = this.opening.get(callId);
    if (pending) return pending;
    const opening = this.openNow(cwd, callId, mode).finally(() => {
      if (this.opening.get(callId) === opening) this.opening.delete(callId);
    });
    this.opening.set(callId, opening);
    return opening;
  }

  private async openNow(
    cwd: string,
    callId: string,
    mode: OpenMode,
  ): Promise<OpenCall | undefined> {
    if (this.calls.has(callId)) return this.calls.get(callId);
    const repo = await this.repoFor(cwd);
    if (!repo || this.calls.has(callId)) return this.calls.get(callId);
    if (repo.disabled) return undefined;

    this.evictAbandoned();
    const measure = mode !== "note";
    const call: OpenCall = {
      id: callId,
      repo,
      measure,
      openedAt: this.now(),
      overlapped: false,
      late: false,
      unavailable: false,
    };
    if (repo.open.size > 0) {
      call.overlapped = true;
      for (const other of repo.open) other.overlapped = true;
    }
    repo.open.add(call);
    this.calls.set(callId, call);
    if (mode === "fresh") {
      // Any snapshot not yet finished can serve as "before": whatever it has
      // not read yet is still in its pre-command state or, if another call is
      // writing it, already marked approximate above.
      call.before = this.snapshotShared(repo, "any");
    } else if (mode === "baseline") {
      repo.keepsBaseline = true;
      if (repo.running) {
        call.before = repo.running;
        call.unavailable = repo.priming;
      } else if (repo.latest) {
        call.before = Promise.resolve(repo.latest);
      } else {
        // No baseline yet: the command may already have written by the time
        // this snapshot reads the tree.
        call.late = true;
        call.before = this.snapshotShared(repo, "fresh");
      }
    }
    return call;
  }

  private async repoFor(cwd: string): Promise<RepoState | undefined> {
    const location = await this.locate(cwd);
    if (!location) return undefined;
    let repo = this.repos.get(location.root);
    if (!repo) {
      repo = {
        location,
        disabled: false,
        slowStrikes: 0,
        open: new Set(),
        keepsBaseline: false,
        snapshots: new Set(),
        priming: false,
      };
      this.repos.set(location.root, repo);
    }
    return repo;
  }

  /** Calls are kept in open order, so the abandoned ones are at the front. */
  private evictAbandoned(): void {
    const cutoff = this.now() - this.maxWindowMs;
    for (const [id, call] of this.calls) {
      if (this.calls.size < this.maxOpenCalls && call.openedAt >= cutoff) return;
      this.discardNow(id);
    }
  }

  private locate(cwd: string): Promise<RepoLocation | undefined> {
    let location = this.locations.get(cwd);
    if (!location) {
      location = this.git(
        ["rev-parse", "--show-toplevel", "--git-path", "index", "--git-path", "objects"],
        { cwd },
      )
        .then(({ stdout }) => {
          const [root, index, objects] = stdout.split("\n");
          if (!root || !index || !objects) return undefined;
          return {
            root,
            indexPath: isAbsolute(index) ? index : resolve(cwd, index),
            objectsPath: isAbsolute(objects) ? objects : resolve(cwd, objects),
          };
        })
        .catch(() => undefined);
      this.locations.set(cwd, location);
    }
    return location;
  }

  /**
   * One snapshot at a time per repository. `any` joins the running snapshot
   * when there is one; `fresh` must start after the call, so it joins only a
   * snapshot that is still queued.
   */
  private snapshotShared(repo: RepoState, mode: "any" | "fresh"): Promise<Snapshot | undefined> {
    if (mode === "any" && repo.running) return repo.running;
    if (repo.queued) return repo.queued;
    if (!repo.running) return this.startSnapshot(repo);

    const queued = repo.running.then(() => {
      repo.queued = undefined;
      return this.startSnapshot(repo);
    });
    repo.queued = queued;
    return queued;
  }

  private startSnapshot(repo: RepoState): Promise<Snapshot | undefined> {
    const running = this.snapshot(repo)
      .then((snapshot) => {
        if (snapshot) repo.latest = snapshot;
        return snapshot;
      })
      .catch(() => undefined)
      .finally(() => {
        if (repo.running === running) repo.running = undefined;
        void this.releaseUnusedObjects(repo);
      });
    repo.running = running;
    return running;
  }

  private async snapshot(repo: RepoState): Promise<Snapshot | undefined> {
    if (repo.disabled) return undefined;
    const { root, indexPath } = repo.location;
    const started = this.now();
    const tempIndex = join(this.tempDir, `orkestrator-probe-${randomUUID()}.index`);
    const objectDirectory = await mkdtemp(join(this.tempDir, "orkestrator-probe-objects-"));
    temporaryObjectDirectories.add(objectDirectory);
    let retained = false;
    try {
      // Starting from the real index keeps its stat cache, so unchanged tracked
      // files are not re-read. A repository with no index yet starts empty.
      await copyFile(indexPath, tempIndex).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const env = { GIT_INDEX_FILE: tempIndex, ...this.objectEnv(repo, objectDirectory) };

      const untracked = splitNul(
        (await this.git(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: root }))
          .stdout,
      );
      if (untracked.length > this.maxUntrackedFiles) {
        repo.disabled = true;
        return undefined;
      }
      const included: string[] = [];
      const skipped: SkippedFiles = new Map();
      for (const path of untracked) {
        const stats = await lstat(join(root, path)).catch(() => undefined);
        if (!stats) continue;
        if (stats.size > this.maxUntrackedFileBytes) {
          skipped.set(path, `${stats.size}:${stats.mtimeMs}`);
        } else {
          included.push(path);
        }
      }

      await this.git(["add", "--update", "--", "."], { cwd: root, env });
      if (included.length > 0) {
        await this.git(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          cwd: root,
          env,
          stdin: included.map((path) => `:(literal)${path}\0`).join(""),
        });
      }
      const tree = (await this.git(["write-tree"], { cwd: root, env })).stdout.trim();
      if (!tree) return undefined;
      const snapshot = { tree, skipped, objectDirectory };
      repo.snapshots.add(snapshot);
      retained = true;
      return snapshot;
    } finally {
      await rm(tempIndex, { force: true }).catch(() => {});
      await rm(`${tempIndex}.lock`, { force: true }).catch(() => {});
      if (!retained) await this.removeObjectDirectory(objectDirectory);
      this.recordDuration(repo, this.now() - started);
    }
  }

  private recordDuration(repo: RepoState, elapsedMs: number): void {
    if (elapsedMs <= this.slowSnapshotMs) {
      repo.slowStrikes = 0;
      return;
    }
    repo.slowStrikes += 1;
    if (repo.slowStrikes >= SLOW_SNAPSHOT_STRIKES) repo.disabled = true;
  }

  private async diff(
    repo: RepoState,
    before: Snapshot,
    after: Snapshot,
  ): Promise<MeasuredWorkspaceChange> {
    if (before.tree === after.tree) return { additions: 0, deletions: 0, files: [] };
    const { stdout } = await this.git(
      ["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", before.tree, after.tree],
      {
        cwd: repo.location.root,
        env: this.objectEnv(repo, after.objectDirectory, before.objectDirectory),
      },
    );
    const files = parseNumstatZ(stdout);
    const statuses = await this.git(
      [
        "diff",
        "--name-status",
        "-z",
        "-M",
        "--no-ext-diff",
        "--no-textconv",
        before.tree,
        after.tree,
      ],
      {
        cwd: repo.location.root,
        env: this.objectEnv(repo, after.objectDirectory, before.objectDirectory),
      },
    );
    const fileStatuses = parseNameStatusZ(statuses.stdout);
    for (const file of files) file.status = fileStatuses.get(file.path) ?? "M";
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    const change: MeasuredWorkspaceChange = {
      additions,
      deletions,
      files: files.slice(0, this.maxReportedFiles),
    };
    if (files.length > this.maxReportedFiles) change.filesTruncated = true;
    return change;
  }
}

/** `-z` puts status, path, and optional rename source in separate fields. */
export function parseNameStatusZ(output: string): Map<string, MeasuredFileChange["status"]> {
  const tokens = output.split("\0");
  const statuses = new Map<string, MeasuredFileChange["status"]>();
  for (let index = 0; index < tokens.length - 1;) {
    const status = tokens[index++]?.[0];
    if (status === "R" || status === "C") {
      index += 1;
      const path = tokens[index++];
      if (path) statuses.set(path, "R");
    } else {
      const path = tokens[index++];
      if (path && (status === "A" || status === "D" || status === "M")) statuses.set(path, status);
    }
  }
  return statuses;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function skippedFilesChanged(before: SkippedFiles, after: SkippedFiles): boolean {
  if (before.size !== after.size) return true;
  for (const [path, stamp] of before) {
    if (after.get(path) !== stamp) return true;
  }
  return false;
}

/**
 * Parse `git diff --numstat -z`.
 *
 * A plain entry is `adds\tdels\tpath\0`; a rename is `adds\tdels\t\0old\0new\0`.
 * Binary files report `-` for both counts.
 */
export function parseNumstatZ(output: string): MeasuredFileChange[] {
  const tokens = output.split("\0");
  const files: MeasuredFileChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const header = tokens[index];
    if (!header) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(header);
    if (!match) continue;
    const [, rawAdditions, rawDeletions, inlinePath] = match;
    let path = inlinePath ?? "";
    let previousPath: string | undefined;
    if (path === "") {
      previousPath = tokens[index + 1];
      path = tokens[index + 2] ?? "";
      index += 2;
    }
    if (!path) continue;
    const binary = rawAdditions === "-" || rawDeletions === "-";
    files.push({
      path,
      additions: binary ? 0 : Number(rawAdditions),
      deletions: binary ? 0 : Number(rawDeletions),
      ...(binary ? { binary: true as const } : {}),
      ...(previousPath ? { previousPath } : {}),
    });
  }
  return files;
}
