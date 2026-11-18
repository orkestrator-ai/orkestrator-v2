import path from "node:path";

/**
 * Parsers for `git diff -z` output. A scan asks one process for
 * `--raw --numstat -z -M` (docs/architecture/git-scan-caches.md), which writes
 * every raw record and then every numstat record with no separator between them.
 */

export type GitFileChange = {
  path: string;
  originalPath?: string;
  filename: string;
  directory: string;
  additions: number;
  deletions: number;
  status: string;
  /** Git reported no line counts; `additions`/`deletions` are 0 for old readers. */
  binary?: true;
  /** Listed but not counted (scan cap, unreadable, too large); counts are 0 for old readers. */
  countOmitted?: true;
};

type GitNumstat = Map<string, { additions: number; deletions: number; binary?: true }>;

export function splitNulTerminatedGitFields(output: string, label: string): string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) {
    throw new Error(`Malformed ${label}: missing NUL terminator`);
  }
  return output.slice(0, -1).split("\0");
}

function numstatFromFields(fields: readonly string[], start: number): GitNumstat {
  const stats: GitNumstat = new Map();
  for (let index = start; index < fields.length;) {
    const header = fields[index++] ?? "";
    const firstTab = header.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : header.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab === -1) {
      throw new Error("Malformed git numstat output: invalid record header");
    }
    const additions = header.slice(0, firstTab);
    const deletions = header.slice(firstTab + 1, secondTab);
    if (
      (additions !== "-" && !/^\d+$/.test(additions)) ||
      (deletions !== "-" && !/^\d+$/.test(deletions))
    ) {
      throw new Error("Malformed git numstat output: invalid statistics");
    }
    const inlinePath = header.slice(secondTab + 1);
    let filePath = inlinePath;
    if (inlinePath.length === 0) {
      if (index + 1 >= fields.length) {
        throw new Error("Malformed git numstat output: truncated rename/copy record");
      }
      index += 1; // The preimage path is not the result path used by name-status.
      filePath = fields[index++] ?? "";
    }
    if (!filePath) {
      throw new Error("Malformed git numstat output: empty path");
    }
    stats.set(filePath, {
      additions: additions === "-" ? 0 : Number.parseInt(additions, 10) || 0,
      deletions: deletions === "-" ? 0 : Number.parseInt(deletions, 10) || 0,
      ...(additions === "-" || deletions === "-" ? { binary: true as const } : {}),
    });
  }
  return stats;
}

export function parseGitNumstat(numstatOutput: string): GitNumstat {
  return numstatFromFields(splitNulTerminatedGitFields(numstatOutput, "git numstat output"), 0);
}

/** `fields`: status, then one path, or two for a rename or copy, per record. */
function fileChangesFromStatusFields(
  fields: readonly string[],
  stats: GitNumstat,
): GitFileChange[] {
  const changes: GitFileChange[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? "";
    if (!status) throw new Error("Malformed git name-status output: empty status");
    const isRenameOrCopy = status.startsWith("R") || status.startsWith("C");
    const pathCount = isRenameOrCopy ? 2 : 1;
    if (index + pathCount > fields.length) {
      throw new Error("Malformed git name-status output: truncated record");
    }
    const originalPath = isRenameOrCopy ? fields[index++] : undefined;
    const filePath = fields[index++] ?? "";
    if (!filePath || (isRenameOrCopy && !originalPath)) {
      throw new Error("Malformed git name-status output: empty path");
    }
    const fileStats: { additions: number; deletions: number; binary?: true } = stats.get(
      filePath,
    ) ?? {
      additions: 0,
      deletions: 0,
    };
    changes.push({
      path: filePath,
      originalPath,
      filename: path.basename(filePath),
      directory: path.dirname(filePath) === "." ? "" : path.dirname(filePath),
      additions: fileStats.additions,
      deletions: fileStats.deletions,
      status,
      ...(fileStats.binary ? { binary: true as const } : {}),
    });
  }
  return changes;
}

export function parseGitFileChanges(
  nameStatusOutput: string,
  numstatOutput: string,
): GitFileChange[] {
  return fileChangesFromStatusFields(
    splitNulTerminatedGitFields(nameStatusOutput, "git name-status output"),
    parseGitNumstat(numstatOutput),
  );
}

/** `:<mode> <mode> <oid> <oid> <status>`; the paths are the fields after it. */
const RAW_RECORD_HEADER = /^:[0-7]+ [0-7]+ [0-9a-f.]+ [0-9a-f.]+ ([A-Z][0-9]*)$/;

/**
 * Parses one `git diff --raw --numstat -z` run. Records are read in sequence,
 * so a path that starts with `:` or looks like a count stays a path.
 *
 * `numstat` is what the counts pass found. Without `diff.autoRefreshIndex` the
 * raw records can list a stat-only modification, which numstat omits because it
 * checks contents; see {@link withoutStatOnlyModifications}.
 */
export function parseGitDiffSummary(output: string): {
  changes: GitFileChange[];
  numstat: GitNumstat;
} {
  const fields = splitNulTerminatedGitFields(output, "git diff summary");
  const statusFields: string[] = [];
  let index = 0;
  while (index < fields.length && fields[index]!.startsWith(":")) {
    const status = RAW_RECORD_HEADER.exec(fields[index++]!)?.[1];
    if (!status) throw new Error("Malformed git raw output: invalid record header");
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    if (index + pathCount > fields.length) {
      throw new Error("Malformed git raw output: truncated record");
    }
    statusFields.push(status, ...fields.slice(index, index + pathCount));
    index += pathCount;
  }
  const numstat = numstatFromFields(fields, index);
  return { changes: fileChangesFromStatusFields(statusFields, numstat), numstat };
}

/**
 * Drops stat-only modifications from a summary taken without refreshing the
 * index, keeping real zero-line changes (empty files, mode changes and binary
 * files), which numstat lists as explicit records.
 */
export function withoutStatOnlyModifications(summary: {
  changes: GitFileChange[];
  numstat: GitNumstat;
}): GitFileChange[] {
  return summary.changes.filter(
    (change) => change.status !== "M" || summary.numstat.has(change.path),
  );
}
