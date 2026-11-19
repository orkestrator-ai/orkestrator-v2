/**
 * Selective staging: write one reviewed hunk of a live file diff to the Git
 * index (`changes_stage_hunk`; docs/architecture/change-tracking.md#hunk-staging).
 *
 * The client names a diff identity it displayed and one hunk of it. The
 * identity is immutable — it binds the exact bytes of both sides — so the
 * backend re-renders the same hunks from those bytes and refuses the request
 * unless the hunk at that index still has the ranges the client showed.
 *
 * It then verifies the live state the hunk would be applied to, and refuses
 * rather than merges when anything moved:
 *
 * - stage: the index entry must hold exactly the identity's before bytes and
 *   the working file exactly its after bytes. The new index blob is the
 *   before bytes with this one hunk's region replaced by the after side's.
 * - unstage: the index entry must hold exactly the identity's after bytes
 *   (a `staged` HEAD-to-index diff). The new index blob is the after bytes
 *   with this one hunk's region put back to the before side's.
 *
 * Every other hunk, the working tree and every other index entry are left
 * untouched. Mutations run in the backend only, serialized per worktree, and
 * the index entry is re-read immediately before `update-index`.
 */

import type { DiffIdentity } from "@orkestrator/protocol/change-resources";
import type {
  ChangeErrorCode,
  ChangeHunkSelector,
  ChangesStageHunkRequest,
  ChangesStageHunkResult,
} from "@orkestrator/protocol/change-resources";
import {
  diffRawLines,
  isProbablyBinary,
} from "@orkestrator/protocol/node/change-tracking/raw-line-diff";
import { runCommandBuffer } from "../shell.js";
import { decodePath, SAFE_GIT_CONFIG } from "./capture.js";
import type { ChangeLedger } from "./change-ledger.js";
import {
  INDEX_FILE_REPRESENTATION_ID,
  LIVE_FILE_REPRESENTATION_ID,
  STAGED_FILE_REPRESENTATION_ID,
} from "./diff-bodies.js";
import { configuredFilterDrivers, filteredPaths, type GitRunner } from "./git-scopes.js";
import type { ObjectStore } from "./object-store.js";
import type { WorktreeRegistry, WorktreeTarget } from "./worktree-owner.js";

/** Index modes a hunk can be applied to: regular and executable files. */
const REGULAR_MODES = new Set(["100644", "100755"]);
const LF = 0x0a;

/**
 * Scopes whose identity compares some version of the file against the
 * working-tree bytes. Staging needs the before side to equal the current
 * index entry; for `unstaged` it was read from the index, for the others it
 * is a commit that matches the index only while the file has nothing staged.
 */
const STAGE_REPRESENTATIONS = new Set([INDEX_FILE_REPRESENTATION_ID, LIVE_FILE_REPRESENTATION_ID]);

class StagingRefusal extends Error {
  constructor(
    readonly code: ChangeErrorCode,
    readonly reasonKey: string,
  ) {
    super(reasonKey);
  }
}

function refuse(code: ChangeErrorCode, reason: string): never {
  throw new StagingRefusal(code, reason);
}

/** Byte offset where each raw line (raw-lines-v1: split after LF) starts, plus the end. */
function lineStarts(bytes: Uint8Array): number[] {
  const starts = [0];
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === LF) starts.push(index + 1);
  }
  if (starts[starts.length - 1] !== bytes.length) starts.push(bytes.length);
  return starts;
}

/** A hunk's 0-based line range on one side; a zero-length range sits after line `start`. */
function lineRange(start: number, count: number): { begin: number; end: number } {
  const begin = count === 0 ? start : start - 1;
  return { begin, end: begin + count };
}

/**
 * `base` with one hunk's region replaced by the matching region of `source`.
 * Staging passes (before, after) with the old range as `baseRange`;
 * unstaging passes (after, before) with the ranges swapped. Lines outside the
 * region keep `base`'s exact bytes, line endings included.
 */
export function spliceHunk(
  base: Uint8Array,
  source: Uint8Array,
  baseRange: { start: number; count: number },
  sourceRange: { start: number; count: number },
): Uint8Array {
  const baseStarts = lineStarts(base);
  const sourceStarts = lineStarts(source);
  const into = lineRange(baseRange.start, baseRange.count);
  const from = lineRange(sourceRange.start, sourceRange.count);
  if (
    into.begin < 0 ||
    from.begin < 0 ||
    into.end > baseStarts.length - 1 ||
    from.end > sourceStarts.length - 1
  ) {
    throw new RangeError("hunk range outside its file");
  }
  const head = base.subarray(0, baseStarts[into.begin]!);
  const middle = source.subarray(sourceStarts[from.begin]!, sourceStarts[from.end]!);
  const tail = base.subarray(baseStarts[into.end]!);
  const out = new Uint8Array(head.length + middle.length + tail.length);
  out.set(head, 0);
  out.set(middle, head.length);
  out.set(tail, head.length + middle.length);
  return out;
}

function validSelector(hunk: ChangeHunkSelector): boolean {
  return [hunk.index, hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
}

export class HunkStagingService {
  /** One staging operation at a time per worktree. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      ledger: ChangeLedger;
      store: ObjectStore;
      registry: WorktreeRegistry;
      environmentTarget: (environmentId: string) => Promise<WorktreeTarget | null>;
      /** The index of `environmentId` changed; refresh the Git scopes that read it. */
      onIndexChanged: (environmentId: string) => void;
    },
  ) {}

  async apply(request: ChangesStageHunkRequest): Promise<ChangesStageHunkResult> {
    try {
      return await this.applyChecked(request);
    } catch (error) {
      if (error instanceof StagingRefusal) {
        return { kind: "error", error: { code: error.code, reasonKey: error.reasonKey } };
      }
      throw error;
    }
  }

  private async applyChecked(request: ChangesStageHunkRequest): Promise<ChangesStageHunkResult> {
    if (!validSelector(request.hunk)) refuse("invalid-request", "changes.error.invalid-request");
    const identity = this.deps.ledger.diffIdentity(request.diffIdentityId);
    if (!identity) refuse("not-found", "changes.error.not-found");
    const file = this.checkIdentity(identity, request.action);
    const measurement = this.deps.ledger.measurement(identity.measurementId);
    const environmentId = measurement?.logicalOwner.environmentId;
    if (!environmentId) refuse("unsupported-capability", "changes.staging.unsupported-identity");

    const before = await this.deps.store.get(file.beforeBlob);
    const after = await this.deps.store.get(file.afterBlob);
    if (!before || !after) refuse("body-expired", "changes.error.body-expired");
    if (isProbablyBinary(before) || isProbablyBinary(after)) {
      refuse("unsupported-capability", "changes.staging.binary");
    }
    // The same rendering the client reviewed (default budget, whitespace kept).
    const rendered = diffRawLines(before, after);
    if (rendered.kind !== "diff") refuse("unsupported-capability", "changes.staging.too-large");
    const hunk = rendered.hunks[request.hunk.index];
    if (
      !hunk ||
      hunk.oldStart !== request.hunk.oldStart ||
      hunk.oldLines !== request.hunk.oldLines ||
      hunk.newStart !== request.hunk.newStart ||
      hunk.newLines !== request.hunk.newLines
    ) {
      refuse("stale-revision", "changes.staging.hunk-changed");
    }
    // A cut hunk does not cover its whole region.
    if (rendered.truncated && request.hunk.index === rendered.hunks.length - 1) {
      refuse("unsupported-capability", "changes.staging.truncated");
    }
    const old = { start: hunk.oldStart, count: hunk.oldLines };
    const next = { start: hunk.newStart, count: hunk.newLines };
    const content =
      request.action === "stage"
        ? spliceHunk(before, after, old, next)
        : spliceHunk(after, before, next, old);

    const target = await this.deps.environmentTarget(environmentId);
    const worktree = target ? await this.deps.registry.resolve(target) : null;
    if (!target || !worktree) {
      refuse("unsupported-capability", "changes.error.runtime-unavailable");
    }
    if (
      worktree.worktreeId !== identity.worktreeId ||
      worktree.incarnation !== identity.worktreeIncarnation
    ) {
      refuse("owner-replaced", "changes.error.owner-replaced");
    }
    return this.serialized(worktree.worktreeId, async () => {
      try {
        this.deps.registry.owner(worktree).assertCurrent();
      } catch {
        refuse("owner-replaced", "changes.error.owner-replaced");
      }
      await this.writeIndex({
        target,
        path: file.path,
        action: request.action,
        expectedIndex: request.action === "stage" ? before : after,
        expectedWorktree: request.action === "stage" ? after : null,
        indexMismatchReason:
          identity.representationPolicyId === LIVE_FILE_REPRESENTATION_ID
            ? "changes.staging.index-mismatch"
            : "changes.staging.index-changed",
        content,
      });
      this.deps.onIndexChanged(environmentId);
      return { kind: "applied", action: request.action, pathId: file.pathId };
    });
  }

  /** The identity is a live, same-path, text file diff this action applies to. */
  private checkIdentity(
    identity: DiffIdentity,
    action: ChangesStageHunkRequest["action"],
  ): { pathId: string; path: string; beforeBlob: string; afterBlob: string } {
    if (identity.kind !== "file" || identity.whitespacePolicy !== "preserve") {
      refuse("unsupported-capability", "changes.staging.unsupported-identity");
    }
    const representationOk =
      action === "stage"
        ? STAGE_REPRESENTATIONS.has(identity.representationPolicyId) &&
          identity.scope !== "committed-net"
        : identity.representationPolicyId === STAGED_FILE_REPRESENTATION_ID;
    if (!representationOk) refuse("unsupported-capability", "changes.staging.unsupported-identity");
    const { before, after } = identity;
    if (before.state === "unknown" || after.state === "unknown") {
      refuse("unsupported-capability", "changes.staging.side-unknown");
    }
    // New, deleted and renamed files change the index entry itself, not a region of it.
    if (before.state !== "present" || after.state !== "present" || before.pathId !== after.pathId) {
      refuse("unsupported-capability", "changes.staging.whole-file");
    }
    const pathId = after.pathId;
    if (!pathId.startsWith("u:")) refuse("unsupported-capability", "changes.staging.path-encoding");
    const path = pathId.slice(2);
    if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || !part)) {
      refuse("invalid-request", "changes.error.invalid-request");
    }
    // Sanity: the display spelling decodes to the same bytes.
    if (Buffer.from(decodePath(pathId)).toString("utf8") !== path) {
      refuse("unsupported-capability", "changes.staging.path-encoding");
    }
    return { pathId, path, beforeBlob: before.blobId, afterBlob: after.blobId };
  }

  private serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const settled = next.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }

  private async writeIndex(input: {
    target: WorktreeTarget;
    path: string;
    action: ChangesStageHunkRequest["action"];
    expectedIndex: Uint8Array;
    expectedWorktree: Uint8Array | null;
    indexMismatchReason: string;
    content: Uint8Array;
  }): Promise<void> {
    const git = gitRunner(input.target);
    const text = async (args: string[], stdin?: Uint8Array) =>
      (await git(args, stdin)).toString("utf8");
    const hashOf = async (bytes: Uint8Array) =>
      (await text(["hash-object", "--no-filters", "--stdin"], bytes)).trim();

    const entry = await this.indexEntry(text, input.path);
    if (entry.oid !== (await hashOf(input.expectedIndex))) {
      refuse("precondition-failed", input.indexMismatchReason);
    }
    if (input.expectedWorktree) {
      const raw = (
        await text(["hash-object", "--no-filters", "--", input.path]).catch(() =>
          refuse("precondition-failed", "changes.staging.worktree-changed"),
        )
      ).trim();
      if (raw !== (await hashOf(input.expectedWorktree))) {
        refuse("precondition-failed", "changes.staging.worktree-changed");
      }
      // The working bytes must be what Git itself would store: no external
      // filter program (never run here), and no built-in conversion (line
      // endings, ident, working-tree encoding) that would change them.
      const runner: GitRunner = (args) => text(args);
      const drivers = await configuredFilterDrivers(runner);
      if ((await filteredPaths(runner, drivers.names, [input.path])).size > 0) {
        refuse("unsupported-capability", "changes.staging.git-conversion");
      }
      const converted = (
        await text([...drivers.neutralize, "hash-object", "--", input.path]).catch(() =>
          refuse("unsupported-capability", "changes.staging.git-conversion"),
        )
      ).trim();
      if (converted !== raw) refuse("unsupported-capability", "changes.staging.git-conversion");
    }
    const written = (
      await text(["hash-object", "-w", "--no-filters", "--stdin"], input.content)
    ).trim();
    // Re-read the entry immediately before replacing it.
    const current = await this.indexEntry(text, input.path);
    if (current.oid !== entry.oid || current.mode !== entry.mode) {
      refuse("precondition-failed", "changes.staging.index-changed");
    }
    await text(["update-index", "--cacheinfo", `${entry.mode},${written},${input.path}`]).catch(
      () => refuse("precondition-failed", "changes.staging.git-failed"),
    );
  }

  /** The path's single stage-0 index entry of a regular file. */
  private async indexEntry(
    text: (args: string[]) => Promise<string>,
    path: string,
  ): Promise<{ mode: string; oid: string }> {
    const listing = await text(["--literal-pathspecs", "ls-files", "-s", "-z", "--", path]);
    const entries = listing
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf("\t");
        const [mode, oid, stage] = record.slice(0, tab).split(" ");
        return {
          mode: mode ?? "",
          oid: oid ?? "",
          stage: stage ?? "",
          path: record.slice(tab + 1),
        };
      })
      .filter((entry) => entry.path === path);
    if (entries.length === 0) refuse("precondition-failed", "changes.staging.not-in-index");
    if (entries.length > 1 || entries[0]!.stage !== "0") {
      refuse("precondition-failed", "changes.staging.index-conflict");
    }
    const entry = entries[0]!;
    if (!REGULAR_MODES.has(entry.mode))
      refuse("unsupported-capability", "changes.staging.special-file");
    return { mode: entry.mode, oid: entry.oid };
  }
}

/** Runs Git in the environment's worktree (host or container) with optional stdin bytes. */
function gitRunner(
  target: WorktreeTarget,
): (args: string[], stdin?: Uint8Array) => Promise<Buffer> {
  return async (args, stdin) => {
    const input = stdin ? Buffer.from(stdin.buffer, stdin.byteOffset, stdin.byteLength) : undefined;
    const result =
      target.kind === "local"
        ? await runCommandBuffer("git", [...SAFE_GIT_CONFIG, "-C", target.worktreePath, ...args], {
            timeoutMs: 30_000,
            ...(input ? { stdin: input } : {}),
          })
        : await runCommandBuffer(
            "docker",
            [
              "exec",
              ...(input ? ["-i"] : []),
              target.containerId,
              "git",
              ...SAFE_GIT_CONFIG,
              "-C",
              target.root ?? "/workspace",
              ...args,
            ],
            { timeoutMs: 30_000, ...(input ? { stdin: input } : {}) },
          );
    return result.stdout;
  };
}
