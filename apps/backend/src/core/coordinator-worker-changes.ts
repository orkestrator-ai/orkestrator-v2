import {
  changeResourceKey,
  environmentChangeResourceKey,
  type ChangeDiffFileBody,
  type ChangeFileRow,
  type ChangeProjection,
  type ChangesGetDiffResult,
  type ChangesGetFilesResult,
  type ChangesResolveLiveDetailResult,
  type ChangeViewResult,
} from "@orkestrator/protocol/change-resources";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { coordinatorNodeTarget, withRetryAdvice } from "./commands-registry-coordinator-nodes.js";
import { coordinatorCaller } from "./coordinator-action-scope.js";
import { diffBaseGitForEnvironment, type DiffBaseGit } from "./diff-base-override.js";
import { isImmutableCommitRef } from "./commands-files.js";
import type { Environment } from "./models.js";
import { requireProjectWorker, surfaceRecord } from "./worker-surface-runs.js";
import {
  WORKER_CHANGES_LIMITS,
  WORKER_DIFF_SCOPES,
  type WorkerDiffScope,
} from "./coordinator-worker-changes-limits.js";

/**
 * `get_worker_changes` (coordinator gap item 4): what a worker environment
 * changed, local or container, without the coordinator fetching its branch.
 *
 * Everything comes from backend change tracking through the same `changes_*`
 * commands the Changes panel and `changes.view` read:
 *
 * - `sinceBase`: the `environment-net` measurement, the worker's base commit
 *   to its working tree (committed and uncommitted together), with each
 *   file's status and line counts;
 * - `committed`: the `committed-net` measurement, that base commit to `HEAD`;
 * - `uncommitted`: the `uncommitted-net` measurement, `HEAD` to the working
 *   tree, untracked files included;
 * - `diffs`: backend-rendered hunks of `sinceBase` files, through
 *   `changes_resolve_live_detail` and `changes_get_diff` (the Diff tab), or
 *   with `diffScope`, `committedDiffs` and `uncommittedDiffs`: the same
 *   rendering over the two Git scopes, so a file changed both ways shows
 *   which lines are committed;
 * - `commits`: `git log <base>..HEAD` through the checkout's Git runner the
 *   Changes panel's base picker uses (`diffBaseGitForEnvironment`).
 *
 * Every list and buffer is bounded and the result says what was cut, with the
 * argument that pages or narrows it. Read-only: it changes nothing in the
 * worker, and it never reads the project home.
 */

type JsonRecord = Record<string, unknown>;
type Run = (command: string, args: JsonRecord) => Promise<unknown>;

/** The Git scope resource `HEAD` → working tree (`gitScopeResourceKey` in change tracking). */
export function uncommittedChangeResourceKey(environmentId: string): string {
  return changeResourceKey({
    scope: "uncommitted-net",
    ownerKind: "environment",
    ownerId: environmentId,
    selector: "live",
  });
}

/** The Git scope resource base commit → `HEAD`, split from `environment-net` at `HEAD`. */
export function committedChangeResourceKey(environmentId: string): string {
  return changeResourceKey({
    scope: "committed-net",
    ownerKind: "environment",
    ownerId: environmentId,
    selector: "live",
  });
}

/** The tool's own read options, forwarded unchanged to the worker's node. */
const WORKER_CHANGES_INPUT_FIELDS = [
  "paths",
  "file",
  "offset",
  "maxFiles",
  "maxCommits",
  "includeDiff",
  "maxDiffFiles",
  "maxDiffBytes",
  "diffScope",
] as const;

export interface WorkerChangesOptions {
  paths?: string[];
  file?: string;
  offset: number;
  maxFiles: number;
  maxCommits: number;
  includeDiff: boolean;
  diffScope: WorkerDiffScope;
  maxDiffFiles: number;
  maxFileDiffBytes: number;
  maxTotalDiffBytes: number;
}

function boundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Expected ${name} between ${min} and ${max}`);
  return value as number;
}

function relativePath(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > WORKER_CHANGES_LIMITS.maxPathChars ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  )
    throw new Error(`Expected ${name} to be a path inside the worker`);
  return value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

function diffScopeFrom(value: unknown): WorkerDiffScope {
  if (value === undefined) return "sinceBase";
  if ((WORKER_DIFF_SCOPES as readonly unknown[]).includes(value)) return value as WorkerDiffScope;
  throw new Error(`Expected diffScope to be one of ${WORKER_DIFF_SCOPES.join(", ")}`);
}

export function parseWorkerChangesOptions(input: JsonRecord): WorkerChangesOptions {
  const L = WORKER_CHANGES_LIMITS;
  let paths: string[] | undefined;
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > L.maxPaths)
      throw new Error(`Expected paths to be 1-${L.maxPaths} paths`);
    paths = input.paths.map((entry, index) => relativePath(entry, `paths[${index}]`));
  }
  const file = input.file === undefined ? undefined : relativePath(input.file, "file");
  if (file && paths) throw new Error("Pass file or paths, not both");
  const maxTotalDiffBytes = boundedInteger(
    input.maxDiffBytes,
    "maxDiffBytes",
    1_024,
    L.maxTotalDiffBytes,
    // One file gets the whole budget.
    file ? L.maxTotalDiffBytes : L.defaultTotalDiffBytes,
  );
  return {
    ...(paths ? { paths } : {}),
    ...(file ? { file } : {}),
    offset: boundedInteger(input.offset, "offset", 0, L.maxScannedRows, 0),
    maxFiles: boundedInteger(input.maxFiles, "maxFiles", 1, L.maxFiles, L.defaultFiles),
    maxCommits: boundedInteger(input.maxCommits, "maxCommits", 0, L.maxCommits, L.defaultCommits),
    includeDiff: input.includeDiff !== false,
    diffScope: diffScopeFrom(input.diffScope),
    maxDiffFiles: file
      ? 1
      : boundedInteger(input.maxDiffFiles, "maxDiffFiles", 0, L.maxDiffFiles, L.defaultDiffFiles),
    maxFileDiffBytes: file
      ? maxTotalDiffBytes
      : Math.min(L.defaultFileDiffBytes, maxTotalDiffBytes),
    maxTotalDiffBytes,
  };
}

function rowPath(row: ChangeFileRow): string {
  return row.newPathDisplay ?? row.oldPathDisplay ?? row.pathId;
}

function matches(row: ChangeFileRow, options: WorkerChangesOptions): boolean {
  const filters = options.file ? [options.file] : options.paths;
  if (!filters) return true;
  const candidates = [row.newPathDisplay, row.oldPathDisplay].filter(
    (entry): entry is string => typeof entry === "string",
  );
  return candidates.some((candidate) =>
    filters.some(
      (filter) => candidate === filter || (!options.file && candidate.startsWith(`${filter}/`)),
    ),
  );
}

/** Paths of the two Git scopes, for flagging a sinceBase file. */
interface ChangeFlags {
  uncommitted?: ReadonlySet<string>;
  committed?: ReadonlySet<string>;
}

function inSet(row: ChangeFileRow, paths: ReadonlySet<string>): boolean {
  return paths.has(rowPath(row)) || (row.oldPathDisplay !== null && paths.has(row.oldPathDisplay));
}

function fileSummary(row: ChangeFileRow, flags: ChangeFlags = {}): JsonRecord {
  return {
    path: rowPath(row),
    ...(row.oldPathDisplay && row.oldPathDisplay !== row.newPathDisplay && row.newPathDisplay
      ? { oldPath: row.oldPathDisplay }
      : {}),
    status: row.status,
    kind: row.fileKind,
    additions: row.additions.value,
    deletions: row.deletions.value,
    ...(row.additions.quality !== "complete" || row.deletions.quality !== "complete"
      ? {
          countQuality:
            row.additions.quality === "complete" ? row.deletions.quality : row.additions.quality,
        }
      : {}),
    ...(flags.uncommitted ? { uncommitted: inSet(row, flags.uncommitted) } : {}),
    ...(flags.committed ? { committed: inSet(row, flags.committed) } : {}),
  };
}

interface Measurement {
  projection: ChangeProjection | null;
  unavailable?: string;
  /** Matching rows from `offset`, at most `maxFiles` (plus one, to detect more). */
  rows: ChangeFileRow[];
  /** Matching rows seen, when every row was read. */
  matched: number | null;
  scanCapped: boolean;
}

async function readMeasurement(
  run: Run,
  resourceKey: string,
  options: WorkerChangesOptions,
  allRows = false,
): Promise<Measurement> {
  const L = WORKER_CHANGES_LIMITS;
  let view: ChangeViewResult;
  try {
    view = (await run("changes_get_view", {
      resourceKey,
      pageSize: L.pageRows,
    })) as ChangeViewResult;
  } catch {
    // A backend without change tracking, or a refused key.
    return {
      projection: null,
      unavailable: "changes.error.unavailable",
      rows: [],
      matched: null,
      scanCapped: false,
    };
  }
  if (view.kind !== "projection" && view.kind !== "reset")
    return {
      projection: null,
      unavailable:
        view.kind === "error"
          ? view.error.reasonKey
          : view.kind === "deleted"
            ? "changes.error.resource-deleted"
            : "changes.error.unavailable",
      rows: [],
      matched: null,
      scanCapped: false,
    };
  const { projection } = view;
  // One past the page tells whether there is more.
  const wanted = allRows ? L.maxScannedRows : options.maxFiles + 1;
  const rows: ChangeFileRow[] = [];
  let matched = 0;
  let scanned = 0;
  let page = projection.filePage;
  let cursor = page?.nextCursor ?? null;
  let pageRows = page?.rows ?? [];
  while (page) {
    for (const row of pageRows) {
      scanned += 1;
      if (!matches(row, options)) continue;
      if (matched >= (allRows ? 0 : options.offset) && rows.length < wanted) rows.push(row);
      matched += 1;
    }
    if (!cursor || rows.length >= wanted || scanned >= L.maxScannedRows) break;
    const next = (await run("changes_get_files", {
      resourceKey,
      snapshotToken: page.snapshotToken,
      cursor,
      pageSize: L.pageRows,
    })) as ChangesGetFilesResult;
    // A newer measurement replaced this one mid-read: stop with what is read.
    if (next.kind !== "page") break;
    pageRows = next.rows;
    cursor = next.nextCursor;
  }
  const complete = !cursor;
  return {
    projection,
    rows,
    matched: complete ? matched : null,
    scanCapped: !complete && scanned >= L.maxScannedRows,
  };
}

function measurementSummary(
  measurement: Measurement,
  description: string,
  options: WorkerChangesOptions,
  flags?: ChangeFlags,
  pageable = true,
): JsonRecord {
  const { projection } = measurement;
  if (!projection)
    return { description, available: false, reason: measurement.unavailable ?? null, files: [] };
  const shown = measurement.rows.slice(0, options.maxFiles);
  const more = measurement.rows.length > options.maxFiles || measurement.scanCapped;
  return {
    description,
    available: true,
    state: projection.state,
    observation: projection.observationState,
    coverage: projection.coverageState,
    ...(projection.reasonKeys.length ? { reasons: projection.reasonKeys.slice(0, 10) } : {}),
    revision: projection.revision,
    totals: {
      additions: projection.counters.additions.value,
      deletions: projection.counters.deletions.value,
      changedFiles: projection.counters.changedFiles,
    },
    ...(measurement.matched !== null && (options.paths || options.file)
      ? { matchingFiles: measurement.matched }
      : {}),
    files: shown.map((row) => fileSummary(row, flags)),
    truncated: more,
    ...(more && pageable ? { nextOffset: options.offset + shown.length } : {}),
    ...(measurement.scanCapped ? { scanCapped: true } : {}),
  };
}

/** Backend hunks as unified-diff text, cut at `limit` UTF-8 bytes. */
export function renderDiffBody(
  body: ChangeDiffFileBody,
  limit: number,
): { text: string; bytes: number; truncated: boolean } {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let bytes = 0;
  let truncated = body.truncated;
  const push = (line: string) => {
    const size = encoder.encode(line).length + 1;
    if (bytes + size > limit) {
      truncated = true;
      return false;
    }
    lines.push(line);
    bytes += size;
    return true;
  };
  outer: for (const hunk of body.hunks) {
    if (!push(hunk.header)) break;
    for (const line of hunk.lines) {
      const prefix =
        line.type === "add"
          ? "+"
          : line.type === "remove"
            ? "-"
            : line.type === "context"
              ? " "
              : "\\";
      const text =
        line.type === "no-newline" ? "\\ No newline at end of file" : `${prefix}${line.text}`;
      if (!push(text)) break outer;
    }
  }
  return { text: lines.join("\n"), bytes, truncated };
}

async function renderDiffs(
  run: Run,
  resourceKey: string,
  revision: number,
  rows: ChangeFileRow[],
  options: WorkerChangesOptions,
  description: string,
): Promise<JsonRecord> {
  const files: JsonRecord[] = [];
  let total = 0;
  let omitted = 0;
  let truncated = false;
  for (const row of rows) {
    const path = rowPath(row);
    if (files.length >= options.maxDiffFiles || total >= options.maxTotalDiffBytes) {
      omitted += 1;
      continue;
    }
    if (row.fileKind === "binary" || row.fileKind === "gitlink") {
      files.push({ path, diff: null, reason: `${row.fileKind}-file` });
      continue;
    }
    const resolved = (await run("changes_resolve_live_detail", {
      resourceKey,
      revision,
      rowId: row.rowId,
    })) as ChangesResolveLiveDetailResult;
    if (resolved.kind !== "identity") {
      files.push({ path, diff: null, reason: resolved.error.reasonKey });
      if (resolved.error.code === "stale-revision") truncated = true;
      continue;
    }
    const body = (await run("changes_get_diff", {
      diffIdentityId: resolved.identity.id,
    })) as ChangesGetDiffResult;
    const file = body.kind === "body" ? body.files[0] : undefined;
    if (!file) {
      files.push({
        path,
        diff: null,
        reason: body.kind === "error" ? body.error.reasonKey : "changes.error.not-found",
      });
      continue;
    }
    const rendered = renderDiffBody(
      file,
      Math.min(options.maxFileDiffBytes, options.maxTotalDiffBytes - total),
    );
    total += rendered.bytes;
    if (rendered.truncated) truncated = true;
    files.push({
      path,
      diff: rendered.text,
      ...(rendered.truncated ? { truncated: true } : {}),
      ...(file.bodyAvailability !== "available" ? { bodyAvailability: file.bodyAvailability } : {}),
    });
  }
  return {
    description,
    files,
    bytes: total,
    truncated: truncated || omitted > 0,
    ...(omitted ? { omittedFiles: omitted } : {}),
  };
}

const COMMIT_FIELD = "\x1f";
const COMMIT_RECORD = "\x1e";

async function readCommits(
  git: DiffBaseGit | null,
  base: string | undefined,
  limit: number,
): Promise<JsonRecord> {
  if (limit === 0) return { items: [], truncated: false, skipped: true };
  if (!base || !isImmutableCommitRef(base))
    return { items: [], unavailable: "The worker has no recorded base commit" };
  if (!git) return { items: [], unavailable: "Start the worker to read its commits" };
  let output: string;
  try {
    output = await git([
      "log",
      `--max-count=${limit + 1}`,
      `--format=%H${COMMIT_FIELD}%s${COMMIT_FIELD}%an${COMMIT_FIELD}%cI${COMMIT_RECORD}`,
      `${base}..HEAD`,
      "--",
    ]);
  } catch {
    return { items: [], unavailable: "Git could not list the worker's commits since its base" };
  }
  const items: JsonRecord[] = [];
  for (const record of output.split(COMMIT_RECORD)) {
    const [commit, subject = "", author = "", committedAt = ""] = record.trim().split(COMMIT_FIELD);
    if (!commit || !isImmutableCommitRef(commit)) continue;
    items.push({
      commit,
      subject: subject.slice(0, 200),
      author: author.slice(0, 200),
      committedAt,
    });
  }
  const truncated = items.length > limit;
  return {
    items: items.slice(0, limit),
    truncated,
    ...(truncated ? { more: "Pass a larger maxCommits (at most 200) to list more." } : {}),
  };
}

/** Read one worker's changes on this node. */
export async function readWorkerChanges(
  run: Run,
  environment: Environment,
  options: WorkerChangesOptions,
  git: DiffBaseGit | null,
): Promise<JsonRecord> {
  const environmentKey = environmentChangeResourceKey(environment.id);
  const uncommittedKey = uncommittedChangeResourceKey(environment.id);
  const committedKey = committedChangeResourceKey(environment.id);
  // First materialize the Git scopes: their initial measurement can advance
  // the environment projection revision. Read sinceBase after them so its live
  // detail identities still belong to the revision returned to this caller.
  const uncommitted = await readMeasurement(run, uncommittedKey, options, true);
  const committed = await readMeasurement(run, committedKey, options, true);
  const sinceBase = await readMeasurement(run, environmentKey, options);
  const flags: ChangeFlags = {
    uncommitted: new Set(uncommitted.rows.map(rowPath)),
    ...(committed.projection ? { committed: new Set(committed.rows.map(rowPath)) } : {}),
  };
  const base =
    environment.diffBaseOverride?.commit ??
    environment.createdFromCommit ??
    environment.delegationBaseCommit;
  const diffs = options.includeDiff && options.maxDiffFiles > 0 ? options.diffScope : null;
  // A split answer shares one byte budget between its two halves.
  const half =
    diffs === "split"
      ? {
          ...options,
          maxTotalDiffBytes: Math.floor(options.maxTotalDiffBytes / 2),
          maxFileDiffBytes: Math.min(
            options.maxFileDiffBytes,
            Math.floor(options.maxTotalDiffBytes / 2),
          ),
        }
      : options;
  const scopeDiffs = (measurement: Measurement, resourceKey: string, description: string) =>
    measurement.projection
      ? renderDiffs(
          run,
          resourceKey,
          measurement.projection.revision,
          measurement.rows.slice(0, options.maxFiles),
          half,
          description,
        )
      : Promise.resolve({
          description,
          files: [],
          bytes: 0,
          truncated: false,
          unavailable: measurement.unavailable ?? null,
        });
  const [commits, sinceBaseDiffs, committedDiffs, uncommittedDiffs] = await Promise.all([
    readCommits(git, base, options.maxCommits),
    diffs === "sinceBase" && sinceBase.projection
      ? renderDiffs(
          run,
          environmentKey,
          sinceBase.projection.revision,
          sinceBase.rows.slice(0, options.maxFiles),
          options,
          "Unified diff of each listed sinceBase file, base commit to working tree (committed and uncommitted changes together).",
        )
      : Promise.resolve(null),
    diffs === "committed" || diffs === "split"
      ? scopeDiffs(
          committed,
          committedKey,
          "Unified diff of each listed committed file, base commit to HEAD: only what the worker's commits changed.",
        )
      : Promise.resolve(null),
    diffs === "uncommitted" || diffs === "split"
      ? scopeDiffs(
          uncommitted,
          uncommittedKey,
          "Unified diff of each listed uncommitted file, HEAD to the working tree: only what the worker has not committed.",
        )
      : Promise.resolve(null),
  ]);
  // Not paged by offset (that pages sinceBase); narrowed by paths or file.
  const uncommittedSummary = measurementSummary(
    uncommitted,
    "HEAD to the working tree: changes the worker has not committed, untracked files included.",
    { ...options, offset: 0 },
    undefined,
    false,
  );
  const committedSummary = measurementSummary(
    committed,
    "The worker's base commit to HEAD: what its commits changed, without uncommitted changes.",
    { ...options, offset: 0 },
    undefined,
    false,
  );
  const sinceBaseSummary = measurementSummary(
    sinceBase,
    "The worker's base commit to its working tree: committed and uncommitted changes together. uncommitted: true marks a file that also has uncommitted changes, committed: true one its commits changed.",
    options,
    flags,
  );
  const truncated =
    sinceBaseSummary.truncated === true ||
    committedSummary.truncated === true ||
    uncommittedSummary.truncated === true ||
    commits.truncated === true ||
    sinceBaseDiffs?.truncated === true ||
    committedDiffs?.truncated === true ||
    uncommittedDiffs?.truncated === true;
  return {
    environmentId: environment.id,
    name: environment.name,
    environmentType: environment.environmentType,
    status: environment.status,
    branch: environment.branch,
    base: {
      branch: environment.delegationBaseBranch ?? null,
      commit: base ?? null,
      ...(environment.diffBaseOverride ? { userChosen: true } : {}),
    },
    commits,
    sinceBase: sinceBaseSummary,
    committed: committedSummary,
    uncommitted: uncommittedSummary,
    ...(sinceBaseDiffs ? { diffs: sinceBaseDiffs } : {}),
    ...(committedDiffs ? { committedDiffs } : {}),
    ...(uncommittedDiffs ? { uncommittedDiffs } : {}),
    truncated,
    ...(truncated
      ? {
          narrow:
            "Some output was cut. Page files with offset (sinceBase.nextOffset), narrow with paths (files or directories), read one file's whole diff with file, ask for one diffScope instead of split, or raise maxFiles, maxDiffFiles, maxDiffBytes or maxCommits up to their limits.",
        }
      : {}),
    ...(sinceBase.projection?.state === "loading" ||
    committed.projection?.state === "loading" ||
    uncommitted.projection?.state === "loading"
      ? { pending: "Change tracking is still measuring this worker; read again shortly." }
      : {}),
  };
}

/** An older node parses no `diffScope` and answers with the combined diff only. */
export function olderNodeIgnoredDiffScope(
  options: WorkerChangesOptions,
  answer: JsonRecord,
): boolean {
  if (options.diffScope === "sinceBase" || !options.includeDiff || options.maxDiffFiles === 0)
    return false;
  return !("committedDiffs" in answer) && !("uncommittedDiffs" in answer);
}

function gitFor(environment: Environment): DiffBaseGit | null {
  try {
    return diffBaseGitForEnvironment(environment);
  } catch {
    return null;
  }
}

export function registerCoordinatorWorkerChanges(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  const runner =
    (context: CommandContext): Run =>
    async (command, args) => {
      const handler = dependencies.commands.get(command);
      if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
      return handler(args, context);
    };

  register("get_coordinator_worker_changes", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = surfaceRecord(args.input, "the changes input");
    const environmentId = asNonBlankString(input.environmentId, "environmentId");
    const options = parseWorkerChangesOptions(input);
    const nodeId = input.nodeId;
    if (nodeId !== undefined && (typeof nodeId !== "string" || !nodeId.trim()))
      throw new Error("Expected nodeId");
    if (nodeId && (await context.nodes?.status())?.nodeId !== nodeId) {
      const remote = await coordinatorNodeTarget(context, caller.projectId, nodeId);
      await remote.environment(environmentId);
      // A read changes nothing, so a lost answer is simply asked again.
      const answer = await withRetryAdvice("Call get_worker_changes again; it only reads.", () =>
        remote.call<JsonRecord>("get_controller_worker_changes", {
          projectId: remote.projectId,
          environmentId,
          // The caller's own fields: that node parses and bounds them again.
          options: Object.fromEntries(
            WORKER_CHANGES_INPUT_FIELDS.flatMap((field) =>
              input[field] === undefined ? [] : [[field, input[field]]],
            ),
          ),
        }),
      );
      return {
        ...answer,
        ...(olderNodeIgnoredDiffScope(options, answer)
          ? {
              diffScopeUnsupported:
                "That node's backend predates diffScope, so this answer has only the combined sinceBase diff; sinceBase files marked uncommitted: true also have uncommitted changes.",
            }
          : {}),
        nodeId: remote.nodeId,
      };
    }
    const environment = await requireProjectWorker(context, caller.projectId, environmentId);
    return readWorkerChanges(runner(context), environment, options, gitFor(environment));
  });

  /** The same read on the node owning the worker, for a command node's coordinator. */
  register("get_controller_worker_changes", async (args, context) => {
    const environment = await requireProjectWorker(
      context,
      asNonBlankString(args.projectId, "projectId"),
      args.environmentId,
    );
    // Revalidated here: the bounds are this node's, whatever the caller sent.
    const options = parseWorkerChangesOptions(surfaceRecord(args.options ?? {}, "options"));
    return readWorkerChanges(runner(context), environment, options, gitFor(environment));
  });
}
