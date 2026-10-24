/**
 * Copying a project from one machine to another.
 *
 * A copy is a fresh clone of the project's Git remote on the target machine
 * plus the files Git does not carry that the user picked (untracked and
 * ignored ones: `.env` files, local configuration). Dependency and build
 * output is never picked by default: it is meant to be installed on the
 * target. The source project is never changed or removed.
 *
 * The command node runs every copy (`copy_project_to_node`), whichever two
 * machines it is between, and reports progress with
 * {@link PROJECT_COPY_CHANGED_EVENT}. See
 * `docs/architecture/command-nodes.md` ("Projects on leaf nodes").
 */

export const PROJECT_COPY_CHANGED_EVENT = "project-copy-changed";

/** Files and bytes one copy may move in total. */
export const MAX_PROJECT_COPY_FILES = 10_000;
export const MAX_PROJECT_COPY_BYTES = 2 * 1024 * 1024 * 1024;
/** Untracked and ignored entries one listing returns. */
export const MAX_PROJECT_COPY_CANDIDATES = 2_000;
/** Copies the command node keeps a record of. */
export const MAX_PROJECT_COPY_RECORDS = 50;
/** Bound on the configured default projects folder. */
export const MAX_DEFAULT_PROJECTS_DIRECTORY_CHARS = 4_096;

/**
 * Directory names whose contents are installed or built on each machine.
 * They are listed (so the user can still pick one) but never suggested.
 */
export const HEAVY_PROJECT_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".angular",
  ".turbo",
  ".parcel-cache",
  ".cache",
  ".expo",
  ".docusaurus",
  "storybook-static",
  "coverage",
  ".nyc_output",
  ".gradle",
  ".terraform",
  ".dart_tool",
  ".build",
  "DerivedData",
  "Pods",
  "vendor",
]);

/** Whether any segment of a relative path is dependency or build output. */
export function isHeavyProjectPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .filter(Boolean)
    .some((part) => HEAVY_PROJECT_DIRECTORY_NAMES.has(part));
}

/** `.env`, `.env.local`, `.env.development.local`…, but not an example or template. */
export function isEnvFileName(name: string): boolean {
  return /^\.env(\.[A-Za-z0-9_-]+)*$/.test(name) && !/\.(example|sample|template)$/i.test(name);
}

/** One untracked or ignored entry of a project root. */
export interface ProjectCopyCandidate {
  /** Relative to the project root, `/`-separated; a directory ends with `/`. */
  path: string;
  kind: "file" | "directory";
  /** Matched by `.gitignore` (otherwise merely untracked). */
  ignored: boolean;
  bytes: number;
  files: number;
  /** The walk stopped early: `bytes` and `files` are lower bounds. */
  truncated: boolean;
  /** `.env` files and the project's configured files to copy. */
  suggested: boolean;
  /** Dependency or build output, meant to be installed on the target. */
  heavy: boolean;
}

/** The regular files under a selection, as the source machine sees them. */
export interface ProjectCopyFileList {
  files: Array<{ path: string; bytes: number }>;
  totalBytes: number;
  /** Symbolic links, special files and protected paths that are not copied. */
  skipped: number;
  /** Files over the per-file transfer limit; not copied. */
  tooLarge: string[];
}

export interface ProjectCopyEndpoint {
  nodeId: string;
  projectId: string;
}

/** What the copy dialog shows before anything happens. */
export interface ProjectCopyOptions {
  source: ProjectCopyEndpoint & {
    nodeName: string;
    projectName: string;
    gitUrl: string | null;
  };
  /** Every connected machine, and whether each can receive this copy. */
  targets: Array<{
    nodeId: string;
    nodeName: string;
    available: boolean;
    /** It already has this repository; a copy there only adds missing files. */
    hasProject: boolean;
    projectId: string | null;
    /** The default location, when the machine can compute one. */
    defaultLocation: string | null;
    /** Why this machine cannot receive the copy, if it cannot. */
    unavailableReason?: string;
  }>;
  candidates: ProjectCopyCandidate[];
  candidatesTruncated: boolean;
  limits: { files: number; bytes: number };
}

export type ProjectCopyStage =
  | "queued"
  | "cloning"
  | "listing"
  | "copying"
  | "configuring"
  | "completed"
  | "failed";

/** One copy, as the command node records it. Never holds file contents. */
export interface ProjectCopyRecord {
  copyId: string;
  requestKey: string;
  source: ProjectCopyEndpoint & { nodeName: string; projectName: string };
  target: {
    nodeId: string;
    nodeName: string;
    location: string;
    projectId: string | null;
  };
  /** The paths the user picked (files and directories). */
  paths: string[];
  rememberFiles: boolean;
  stage: ProjectCopyStage;
  /** True when the target already had the repository and nothing was cloned. */
  reusedProject: boolean;
  progress: {
    files: number;
    totalFiles: number;
    bytes: number;
    totalBytes: number;
    /** Of `files`, the ones the target already had and kept. */
    existing?: number;
  };
  skipped: number;
  tooLarge: string[];
  startedAt: string;
  finishedAt?: string;
  /** Approved coordinator request this copy fulfils, if any. */
  actionRequestId?: string;
  error?: { code: string; message: string };
}

export function isProjectCopyRecord(value: unknown): value is ProjectCopyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ProjectCopyRecord>;
  return (
    typeof record.copyId === "string" &&
    typeof record.requestKey === "string" &&
    typeof record.stage === "string" &&
    !!record.source &&
    !!record.target &&
    Array.isArray(record.paths)
  );
}
