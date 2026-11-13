import type { AnyNode } from "./ast";

export const GUARD_IDS = [
  "sleep-before-negative-assertion",
  "released-port-rebind",
  "subprocess-without-budget",
  "small-fake-pid",
  "window-orkestrator-direct",
  "direct-transport-import",
  "lib-backend-command-default",
  "window-orkestrator-portal",
  "workspace-command-bound-call",
  "raw-webrequest-listener",
] as const;

export type GuardId = (typeof GUARD_IDS)[number];

export interface ScannedFile {
  /** Repository-relative, `/`-separated. */
  path: string;
  source: string;
  /** A `*.test.*` file, run by `bun test` (Playwright specs are `*.spec.*`). */
  isBunTest: boolean;
  /**
   * Another repository file's text (repository-relative path), or `null` when
   * it is not a regular file. Lets a guard follow a relative import into a
   * test-support module; absent when the scan has no repository to read.
   */
  readSource?: (relative: string) => string | null;
}

export interface SourceGuard {
  id: GuardId;
  /** What to do instead; printed under every new finding. */
  advice: string;
  /**
   * Repository-relative roots whose production (non-test) sources the guard
   * reads instead of the test sources. Absent for a test-source guard.
   */
  productionRoots?: readonly string[];
  appliesTo(file: ScannedFile): boolean;
  /** A cheap text test: `false` means the file cannot offend and is not parsed for this guard. */
  mayOffend(source: string): boolean;
  /**
   * Starts the guard on one parsed file. The scan walks each file once,
   * calling every applicable guard's handlers for the node types it names.
   */
  visit(program: AnyNode, file: ScannedFile): GuardVisitor;
}

/** Handlers keyed by ESTree node type, as oxc-parser's `Visitor` takes them. */
export type NodeHandlers = Record<string, (node: AnyNode) => void>;

/**
 * A finding counted under a subject within its file (for example, the store
 * a shim call is made on), so the baseline holds one entry per subject and
 * file instead of one per file.
 */
export interface SubjectFinding {
  offset: number;
  subject: string;
}

export interface GuardVisitor {
  handlers: NodeHandlers;
  /** Source offsets of each finding (or offset and subject), once the walk is over. */
  finish(): Array<number | SubjectFinding>;
}
