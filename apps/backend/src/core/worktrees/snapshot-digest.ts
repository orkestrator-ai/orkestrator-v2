import { createHash } from "node:crypto";

/**
 * Digests for the worktree snapshot views.
 *
 * Two main digests with different jobs:
 *
 * - {@link responseDigest} is the wire digest the Files panel's conditional
 *   reads have always used (`sha256(JSON.stringify(value))`, as in
 *   `conditionalSnapshot`). It must stay byte-identical so an older client's
 *   `knownDigest` keeps answering `unchanged`.
 * - {@link semanticFileListDigest} decides whether the file-list *revision*
 *   advances. It covers exactly the fields the list promises — path, original
 *   path, status, additions, deletions — plus the truncation flag, in a
 *   canonical order, and nothing derived. It is independent of the aggregate
 *   counts: two lists with identical totals but different paths differ here.
 *
 * {@link measuredResponseDigest} is the same wire digest plus the encoded size,
 * from one serialization: a tree walk needs both (the digest for conditional
 * replies, the size for the cache's byte bounds), and a 5,000-node tree is
 * worth stringifying once, not twice. {@link treeMembershipDigest} is the part
 * of a file list that can reveal a tree-membership change (see its comment).
 */

export function responseDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** {@link responseDigest} and the UTF-8 size of the value it hashed. */
export function measuredResponseDigest(value: unknown): { digest: string; bytes: number } {
  const serialized = JSON.stringify(value);
  return {
    digest: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/**
 * The paths and statuses of a working-tree file list, without line counts.
 *
 * Every Git-visible membership change — a created (untracked, listed one by
 * one by `--untracked-files=all`), deleted or renamed file — changes this
 * digest, while another edit to an already-changed file does not. It is a
 * *signal* that the tree may have changed, never proof that it did not: an
 * ignored file or an empty directory is invisible to Git, and a truncated list
 * hides whatever lies past its cap, so its user keeps a TTL for those.
 */
export function treeMembershipDigest(changes: readonly unknown[], truncated: boolean): string {
  const rows = changes.map((change) => {
    const entry = (typeof change === "object" && change !== null ? change : {}) as ChangeLike;
    return JSON.stringify([
      typeof entry.path === "string" ? entry.path : "",
      typeof entry.originalPath === "string" ? entry.originalPath : null,
      typeof entry.status === "string" ? entry.status : "",
    ]);
  });
  rows.sort();
  const hash = createHash("sha256");
  hash.update(truncated ? "truncated\n" : "complete\n");
  for (const row of rows) hash.update(`${row}\n`);
  return hash.digest("hex");
}

interface ChangeLike {
  path?: unknown;
  originalPath?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
}

export function semanticFileListDigest(changes: readonly unknown[], truncated: boolean): string {
  const rows = changes.map((change) => {
    const entry = (typeof change === "object" && change !== null ? change : {}) as ChangeLike;
    return [
      typeof entry.path === "string" ? entry.path : "",
      typeof entry.originalPath === "string" ? entry.originalPath : null,
      typeof entry.status === "string" ? entry.status : "",
      typeof entry.additions === "number" ? entry.additions : 0,
      typeof entry.deletions === "number" ? entry.deletions : 0,
    ] as const;
  });
  // Git's output order is stable, but the revision must not depend on it.
  rows.sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : compareRest(left, right),
  );
  const hash = createHash("sha256");
  hash.update(truncated ? "truncated\n" : "complete\n");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function compareRest(
  left: readonly [string, string | null, string, number, number],
  right: readonly [string, string | null, string, number, number],
): number {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
