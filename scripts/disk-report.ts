import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseEnvironmentBranchNamespace } from "../apps/backend/src/core/commands-agent-support";
import { pruneProfiles } from "../apps/desktop/scripts/dev/profile-cleanup";
import { defaultRuntimeProfileRoots } from "../packages/protocol/src/runtime-profile-status";

/**
 * Read-only inventory of the disk state Orkestrator work leaves behind, with
 * the owner of each location and the command that cleans it. See
 * docs/plans/orphaned-disk-state-cleanup.md for why each location grows.
 *
 * Nothing here deletes anything except the explicit `--fix legacy-turbo`,
 * which removes Turbo artifacts that no current Turbo version reads.
 */

export type ReportRow = {
  location: string;
  bytes: number | null;
  orphaned: string;
  owner: string;
  cleanup: string;
};

type Run = (command: string, args: string[]) => { status: number | null; stdout: string };

const run: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "" };
};

function isDirectory(candidate: string): boolean {
  try {
    return lstatSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function childDirectories(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

/** Allocated size, counting hard links once per `du` invocation. */
function diskUsage(paths: string[]): number | null {
  const existing = paths.filter((candidate) => existsSync(candidate));
  if (existing.length === 0) return 0;
  const result = run("du", ["-skc", ...existing]);
  if (result.status !== 0 && !result.stdout) return null;
  const total = result.stdout.trim().split("\n").at(-1)?.split(/\s+/)[0];
  return total && /^\d+$/.test(total) ? Number(total) * 1024 : null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Claude Code names a project's transcript directory after its path this way. */
export function claudeProjectDirectoryName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Turbo artifacts at the top of `.turbo`, written by an older layout. */
export function legacyTurboArtifacts(turboDirectory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(turboDirectory);
  } catch {
    return [];
  }
  const legacy = names
    .filter((name) => /^[0-9a-f]{16}(?:\.tar\.zst|-manifest\.json|-meta\.json)$/.test(name))
    .map((name) => path.join(turboDirectory, name));
  const cache = path.join(turboDirectory, "cache");
  try {
    for (const name of readdirSync(cache)) {
      if (name.endsWith(".tmp")) legacy.push(path.join(cache, name));
    }
  } catch {
    // No cache directory yet.
  }
  return legacy;
}

type Environment = { id?: unknown; worktreePath?: unknown };

function readEnvironments(dataDir: string): Environment[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, "environments.json"), "utf8"));
    return Array.isArray(parsed) ? (parsed as Environment[]) : [];
  } catch {
    return [];
  }
}

function gitLines(repository: string, args: string[]): string[] {
  const result = run("git", ["-C", repository, ...args]);
  return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

function isAncestorOfMain(repository: string, ref: string): boolean {
  return ["refs/remotes/origin/main", "refs/heads/main"].some(
    (base) => run("git", ["-C", repository, "merge-base", "--is-ancestor", ref, base]).status === 0,
  );
}

export type ReportContext = {
  mainCheckout: string;
  homeDir: string;
  dataDir: string;
  developmentRoot: string;
  workspacesRoot: string;
  tmpDir: string;
};

export async function collectReport(context: ReportContext): Promise<ReportRow[]> {
  const rows: ReportRow[] = [];
  const environments = readEnvironments(context.dataDir);
  const environmentIds = environments
    .map((environment) => (typeof environment.id === "string" ? environment.id : ""))
    .filter(Boolean);
  const environmentFragments = new Set(
    environmentIds.map((id) => id.replace(/-/g, "").slice(0, 12)),
  );
  const registeredWorktrees = new Set(
    gitLines(context.mainCheckout, ["worktree", "list", "--porcelain"])
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length))),
  );

  const df = run("docker", ["system", "df", "--format", "{{.Type}}\t{{.Size}}\t{{.Reclaimable}}"]);
  if (df.status === 0) {
    for (const line of df.stdout.split("\n")) {
      const [type, size, reclaimable] = line.split("\t");
      if (type !== "Build Cache" && type !== "Images") continue;
      rows.push({
        location: `Docker ${type.toLowerCase()}`,
        bytes: parseDecimalSize(size ?? ""),
        orphaned: `${reclaimable ?? "?"} reclaimable`,
        owner: "Docker daemon",
        cleanup:
          type === "Build Cache"
            ? "builder.gc.defaultKeepStorage in daemon.json; docker builder prune --max-used-space 15GB"
            : "docker image ls; docker image rm <unused image>",
      });
    }
  }

  const turbo = path.join(context.mainCheckout, ".turbo");
  const legacy = legacyTurboArtifacts(turbo);
  rows.push({
    location: `${turbo}/cache (shared by every worktree)`,
    bytes: diskUsage([path.join(turbo, "cache")]),
    orphaned: "-",
    owner: "Turborepo (cacheMaxAge/cacheMaxSize in turbo.json)",
    cleanup: "evicted automatically at the start of each turbo run",
  });
  rows.push({
    location: `${turbo} legacy artifacts`,
    bytes: diskUsage(legacy),
    orphaned: `${legacy.length} files`,
    owner: "nobody",
    cleanup: "mise run disk:report -- --fix legacy-turbo",
  });

  const profiles = await pruneProfiles({
    roots: {
      developmentRoot: context.developmentRoot,
      productionDataDir: context.dataDir,
      homeDir: context.homeDir,
    },
    dryRun: true,
  });
  const orphanProfiles = profiles.filter((outcome) => outcome.action === "would-remove");
  rows.push({
    location: path.join(context.developmentRoot, "profiles"),
    bytes: diskUsage([path.join(context.developmentRoot, "profiles")]),
    orphaned: `${orphanProfiles.length} of ${profiles.length} (${formatBytes(
      diskUsage(
        orphanProfiles.map((outcome) => path.join(context.developmentRoot, "profiles", outcome.id)),
      ),
    )})`,
    owner: "dev:test (prunes orphans on start)",
    cleanup: "mise run dev:prune [--older-than <days>]",
  });

  const referenced = new Set(
    environments
      .map((environment) =>
        typeof environment.worktreePath === "string" ? path.resolve(environment.worktreePath) : "",
      )
      .filter(Boolean),
  );
  const workspaces = childDirectories(context.workspacesRoot);
  const unowned = workspaces.filter(
    (directory) => !referenced.has(directory) && !registeredWorktrees.has(directory),
  );
  const unreferencedWorktrees = workspaces.filter(
    (directory) => !referenced.has(directory) && registeredWorktrees.has(directory),
  );
  rows.push({
    location: context.workspacesRoot,
    bytes: diskUsage([context.workspacesRoot]),
    orphaned: `${unowned.length} unregistered, ${unreferencedWorktrees.length} not an environment`,
    owner: "Orkestrator (removes empty leftovers at startup)",
    cleanup: "inspect, then git worktree remove <path> or rm -r <path>",
  });

  const branches = gitLines(context.mainCheckout, [
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:short)",
  ]);
  const checkedOut = new Set(
    gitLines(context.mainCheckout, ["worktree", "list", "--porcelain"])
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.slice("branch refs/heads/".length)),
  );
  const orphanBranches = branches.filter((branch) => {
    const fragment = parseEnvironmentBranchNamespace(branch);
    return fragment !== null && !environmentFragments.has(fragment) && !checkedOut.has(branch);
  });
  const mergedOrphans = orphanBranches.filter((branch) =>
    isAncestorOfMain(context.mainCheckout, `refs/heads/${branch}`),
  );
  rows.push({
    location: `${context.mainCheckout} environment branches`,
    bytes: null,
    orphaned: `${orphanBranches.length} without an environment (${mergedOrphans.length} merged)`,
    owner: "Orkestrator (deletes merged ones daily)",
    cleanup: "git branch -D <branch> after checking it is merged",
  });

  const agentWorktrees = childDirectories(path.join(context.mainCheckout, ".claude", "worktrees"));
  const dirtyAgentWorktrees = agentWorktrees.filter(
    (worktree) => gitLines(worktree, ["status", "--porcelain"]).length > 0,
  );
  const mergedAgentWorktrees = agentWorktrees.filter((worktree) =>
    isAncestorOfMain(worktree, "HEAD"),
  );
  rows.push({
    location: path.join(context.mainCheckout, ".claude", "worktrees"),
    bytes: diskUsage([path.join(context.mainCheckout, ".claude", "worktrees")]),
    orphaned: `${agentWorktrees.length} (${mergedAgentWorktrees.length} merged, ${dirtyAgentWorktrees.length} with uncommitted changes)`,
    owner: "Claude Code (keeps worktrees with commits)",
    cleanup: "git worktree remove <path> for merged, clean ones",
  });

  const transcripts = path.join(context.homeDir, ".claude", "projects");
  const transcriptRoots = [
    context.workspacesRoot,
    path.join(context.mainCheckout, ".claude", "worktrees"),
    path.join(context.developmentRoot, "profiles"),
  ].map(claudeProjectDirectoryName);
  const livePrefixes = [
    ...workspaces,
    ...agentWorktrees,
    ...childDirectories(path.join(context.developmentRoot, "profiles")),
  ].map(claudeProjectDirectoryName);
  const staleTranscripts = childDirectories(transcripts).filter((directory) => {
    const name = path.basename(directory);
    if (!transcriptRoots.some((prefix) => name.startsWith(`${prefix}-`))) return false;
    return !livePrefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`));
  });
  rows.push({
    location: `${transcripts} (deleted worktrees and profiles)`,
    bytes: diskUsage(staleTranscripts),
    orphaned: `${staleTranscripts.length} directories`,
    owner: "Claude Code (cleanupPeriodDays, default 30)",
    cleanup: "lower cleanupPeriodDays in ~/.claude/settings.json",
  });

  rows.push({
    location: path.join(context.homeDir, ".codex", "sessions"),
    bytes: diskUsage([path.join(context.homeDir, ".codex", "sessions")]),
    orphaned: "-",
    owner: "Codex",
    cleanup: "remove old months under ~/.codex/sessions/<year>/",
  });

  const miseInstalls = path.join(context.homeDir, ".local", "share", "mise", "installs");
  if (isDirectory(miseInstalls)) {
    rows.push({
      location: miseInstalls,
      bytes: diskUsage([miseInstalls]),
      orphaned: "superseded versions",
      owner: "mise",
      cleanup: "mise prune",
    });
  }

  const tempLeftovers = childDirectories(context.tmpDir).filter((directory) =>
    path.basename(directory).startsWith("orkestrator-"),
  );
  rows.push({
    location: `${context.tmpDir}/orkestrator-*`,
    bytes: diskUsage(tempLeftovers),
    orphaned: `${tempLeftovers.length} directories`,
    owner: "test runs (swept at the next run)",
    cleanup: "removed automatically once their process has exited",
  });
  return rows;
}

function parseDecimalSize(value: string): number | null {
  const match = /^([\d.]+)\s*([kKMGT]?)B$/.exec(value.trim());
  if (!match) return null;
  const power = ["", "K", "M", "G", "T"].indexOf(match[2]!.toUpperCase());
  return Number(match[1]) * 1e3 ** power;
}

export function formatReport(rows: ReportRow[]): string {
  const header = ["Location", "Size", "Orphaned", "Owner", "Cleanup"];
  const cells = rows.map((row) => [
    row.location,
    formatBytes(row.bytes === null ? null : row.bytes),
    row.orphaned,
    row.owner,
    row.cleanup,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((line) => line[column]!.length)),
  );
  const render = (line: string[]) =>
    line.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
  return [render(header), render(widths.map((width) => "-".repeat(width))), ...cells.map(render)]
    .join("\n")
    .replace(/ +$/gm, "");
}

function defaultContext(): ReportContext {
  const common = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.status !== 0) throw new Error("disk:report must run inside the repository");
  const roots = defaultRuntimeProfileRoots();
  return {
    mainCheckout: path.dirname(common.stdout.trim()),
    homeDir: roots.homeDir,
    dataDir: roots.productionDataDir,
    developmentRoot: roots.developmentRoot,
    workspacesRoot:
      process.env.ORKESTRATOR_WORKTREE_DIR?.trim() ||
      path.join(roots.homeDir, "orkestrator-v2", "workspaces"),
    tmpDir: os.tmpdir(),
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== "--");
    const context = defaultContext();
    const fix = args.indexOf("--fix");
    if (fix !== -1) {
      if (args[fix + 1] !== "legacy-turbo") throw new Error("--fix accepts legacy-turbo");
      const legacy = legacyTurboArtifacts(path.join(context.mainCheckout, ".turbo"));
      const bytes = diskUsage(legacy);
      for (const file of legacy) rmSync(file, { force: true });
      console.log(`Removed ${legacy.length} legacy Turbo artifacts (${formatBytes(bytes)}).`);
    } else {
      const rows = await collectReport(context);
      console.log(args.includes("--json") ? JSON.stringify(rows, null, 2) : formatReport(rows));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
