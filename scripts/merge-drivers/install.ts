#!/usr/bin/env bun
/**
 * Registers the repository's merge drivers in this clone's Git configuration
 * (`mise run git:merge-drivers`; `mise run setup` runs it too).
 *
 *   bun scripts/merge-drivers/install.ts           # register (idempotent)
 *   bun scripts/merge-drivers/install.ts --check   # exit 1 unless registered
 *
 * `.gitattributes` names a driver per path, but Git never runs a command a
 * repository names by itself: each clone has to register it. Without the
 * registration Git silently uses its ordinary line merge, so the folder
 * indexes and the contract manifest conflict again. Worktrees share their
 * repository's configuration, so one registration covers all of them; the
 * command resolves the driver from the worktree being merged, so each
 * worktree runs its own copy. When that copy or Bun is missing, the command
 * falls back to `git merge-file`, Git's own line merge.
 */
import { spawnSync } from "node:child_process";
import { MERGE_DRIVER_KINDS, type MergeDriverKind } from "./driver.ts";

export const MERGE_DRIVER_NAMES: Readonly<Record<MergeDriverKind, string>> = {
  "markdown-index": "orkestrator-index",
  "contract-manifest": "orkestrator-contract-manifest",
};

const DESCRIPTIONS: Readonly<Record<MergeDriverKind, string>> = {
  "markdown-index": "Orkestrator index tables: merge rows by the file they index",
  "contract-manifest": "Orkestrator contract manifest: merge entries and recompute totals",
};

/** The shell command Git runs for a driver (`%O %A %B %P` are Git's placeholders). */
export function mergeDriverCommand(kind: MergeDriverKind): string {
  const script = '"$(git rev-parse --show-toplevel)/scripts/merge-drivers/driver.ts"';
  return (
    `test -f ${script} && command -v bun >/dev/null 2>&1 && ` +
    `exec bun ${script} ${kind} %O %A %B %P; ` +
    "git merge-file -L ours -L base -L theirs %A %O %B"
  );
}

function git(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/** The drivers whose registration is missing or out of date. */
export function staleMergeDrivers(): MergeDriverKind[] {
  return MERGE_DRIVER_KINDS.filter((kind) => {
    const current = git(["config", "--get", `merge.${MERGE_DRIVER_NAMES[kind]}.driver`]);
    return current.status !== 0 || current.stdout.trim() !== mergeDriverCommand(kind);
  });
}

function main(args: readonly string[]): number {
  if (args.includes("--check")) {
    const stale = staleMergeDrivers();
    if (stale.length === 0) {
      console.log("Merge drivers are registered.");
      return 0;
    }
    console.error(
      `Merge drivers not registered: ${stale.map((kind) => MERGE_DRIVER_NAMES[kind]).join(", ")}. Run mise run git:merge-drivers.`,
    );
    return 1;
  }
  for (const kind of MERGE_DRIVER_KINDS) {
    const name = MERGE_DRIVER_NAMES[kind];
    for (const [key, value] of [
      ["name", DESCRIPTIONS[kind]],
      ["driver", mergeDriverCommand(kind)],
    ] as const) {
      const result = git(["config", `merge.${name}.${key}`, value]);
      if (result.status !== 0) {
        console.error(`Could not set merge.${name}.${key}.`);
        return 1;
      }
    }
  }
  console.log(
    `Registered merge drivers: ${MERGE_DRIVER_KINDS.map((kind) => MERGE_DRIVER_NAMES[kind]).join(", ")}.`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
