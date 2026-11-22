#!/usr/bin/env bun
/**
 * Git merge driver entry point for the files that conflicted on every merge.
 * `.gitattributes` names the driver per path and `mise run git:merge-drivers`
 * (`install.ts`) registers it in the clone's Git configuration.
 *
 *   bun scripts/merge-drivers/driver.ts <kind> <base> <ours> <theirs> <path>
 *
 * Git passes the three versions as temporary files (`%O %A %B`) and the
 * result is written over `<ours>`. Exit 0 means merged cleanly. When the
 * structured merge cannot decide, this falls back to `git merge-file`, which
 * leaves ordinary conflict markers in `<ours>`, and exits 1 so Git reports
 * the path as conflicted.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeContractManifest } from "./contract-manifest-merge.ts";
import { mergeMarkdownIndex, type TextMerge } from "./markdown-index-merge.ts";

export const MERGE_DRIVER_KINDS = ["markdown-index", "contract-manifest"] as const;
export type MergeDriverKind = (typeof MERGE_DRIVER_KINDS)[number];

/** `git merge-file -p` over temporary copies: the merged text, or null on a conflict. */
export const gitTextMerge: TextMerge = (base, ours, theirs) => {
  const dir = mkdtempSync(join(tmpdir(), "orkestrator-merge-"));
  try {
    const [b, o, t] = ["base", "ours", "theirs"].map((name) => join(dir, name));
    writeFileSync(b!, base);
    writeFileSync(o!, ours);
    writeFileSync(t!, theirs);
    const result = spawnSync("git", ["merge-file", "-p", o!, b!, t!], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The structured merge of one kind, or null when a person has to decide. */
export function mergeByKind(
  kind: MergeDriverKind,
  base: string,
  ours: string,
  theirs: string,
  mergeText: TextMerge = gitTextMerge,
): string | null {
  return kind === "markdown-index"
    ? mergeMarkdownIndex(base, ours, theirs, mergeText)
    : mergeContractManifest(base, ours, theirs);
}

function main(args: readonly string[]): number {
  const [kind, basePath, oursPath, theirsPath, path = "file"] = args;
  if (!kind || !basePath || !oursPath || !theirsPath) {
    console.error("usage: driver.ts <kind> <base> <ours> <theirs> [path]");
    return 2;
  }
  if (!(MERGE_DRIVER_KINDS as readonly string[]).includes(kind)) {
    console.error(`unknown merge driver kind: ${kind}`);
    return 2;
  }
  let merged: string | null = null;
  try {
    merged = mergeByKind(
      kind as MergeDriverKind,
      readFileSync(basePath, "utf8"),
      readFileSync(oursPath, "utf8"),
      readFileSync(theirsPath, "utf8"),
    );
  } catch {
    merged = null;
  }
  if (merged !== null) {
    writeFileSync(oursPath, merged);
    return 0;
  }
  console.error(`${path}: the structured merge cannot decide; falling back to a line merge`);
  const fallback = spawnSync(
    "git",
    [
      "merge-file",
      "-L",
      `${path} (ours)`,
      "-L",
      "base",
      "-L",
      "theirs",
      oursPath,
      basePath,
      theirsPath,
    ],
    { stdio: "inherit" },
  );
  return fallback.status === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
