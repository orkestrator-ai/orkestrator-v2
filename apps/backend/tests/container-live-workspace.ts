import { runCommand } from "../src/core/shell";

/**
 * Workspace and provider-state fixture shared by the live replacement suites
 * (container-live-replacement.test.ts, container-live-rebuild-faults.test.ts):
 * what a user would lose to a naive recreate, and the snapshots that prove it
 * survived byte for byte.
 */

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

/** Workspace and provider state a user would lose to a naive recreate. */
export const POPULATE = [
  "set -e",
  "cd /workspace",
  "git init -q -b main . && git config user.email q@example.invalid && git config user.name q",
  "printf 'tracked\\n' > tracked.txt && printf 'ignored.log\\nnode_modules/\\n' > .gitignore",
  "git add . && git commit -qm base",
  "git checkout -qb feature && printf 'unpushed\\n' > feature.txt && git add feature.txt && git commit -qm unpushed",
  "printf 'edited\\n' >> tracked.txt",
  "printf 'untracked\\n' > untracked.txt && printf 'noise\\n' > ignored.log",
  "mkdir -p node_modules/pkg && printf 'dep\\n' > node_modules/pkg/index.js",
  "head -c 3145728 /dev/urandom > large.bin",
  "printf '#!/bin/sh\\n' > run.sh && chmod 750 run.sh",
  "ln -s tracked.txt internal-link && ln -s /etc/hostname external-link",
  "mkdir -p /home/node/.claude/projects/p && printf '{\"t\":1}\\n' > /home/node/.claude/projects/p/s.jsonl",
  "mkdir -p /home/node/.codex/sessions/2026 && printf '{}\\n' > /home/node/.codex/sessions/2026/r.jsonl",
  'mkdir -p /home/node/.codex/orkestrator-bridge && printf \'{"threadId":"t","title":"Explicit title!","source":"explicit"}\\n\' > /home/node/.codex/orkestrator-bridge/session-titles.jsonl',
  "printf 'config' > /home/node/.codex/config.toml",
  "mkdir -p /home/node/.local/share/opencode",
  "printf 'snapshot' > /home/node/.local/share/opencode/other.bin",
  "mkdir -p /home/node/.grok/sessions/w/s && printf 'update' > /home/node/.grok/sessions/w/s/updates.jsonl",
  "printf '[]' > /home/node/.grok/active_sessions.json",
  "printf 'worktree registry' > /home/node/.grok/worktrees.db",
  "mkdir -p /home/node/.grok/memory-v2 && printf 'memory' > /home/node/.grok/memory-v2/sentinel",
].join("\n");

/** Actual SQLite files, so the live copy proves they reopen at the relocated paths. */
export function sqlitePaths(relocated: boolean): string[] {
  const codex = relocated ? "/home/node/.codex/orkestrator-sqlite" : "/home/node/.codex";
  const opencode = relocated
    ? "/home/node/.local/share/opencode/orkestrator-db"
    : "/home/node/.local/share/opencode";
  return [`${codex}/state_5.sqlite`, `${codex}/thread_history_1.sqlite`, `${opencode}/opencode.db`];
}

export async function sqliteSnapshot(containerId: string, relocated: boolean): Promise<string> {
  return docker([
    "exec",
    "-u",
    "node",
    containerId,
    "bun",
    "-e",
    `
    const { Database } = require("bun:sqlite");
    const result = ${JSON.stringify(sqlitePaths(relocated))}.map(path => {
      const db = new Database(path, { readonly: true, strict: true });
      const integrity = db.query("PRAGMA integrity_check").values();
      const rows = db.query("SELECT id, value FROM preservation ORDER BY id").values();
      db.close();
      return { integrity, rows };
    });
    console.log(JSON.stringify(result));
  `,
  ]);
}

export const WORKSPACE_SNAPSHOT = [
  "cd /workspace",
  "git rev-parse HEAD feature main",
  "git branch --show-current",
  // `.orkestrator` holds Orkestrator's private storage marker; setup adds it
  // to .git/info/exclude on every start, which this fixture does not run.
  "git status --porcelain --ignored -- . ':!.orkestrator' | sort",
  "stat -c '%a %U' run.sh",
  "readlink internal-link external-link",
  "sha256sum large.bin tracked.txt node_modules/pkg/index.js",
  "git fsck --no-progress 2>&1 | head -3",
].join(" && ");

/** Provider state as a volume-backed runtime mounts it (relocated databases). */
export const STATE_SNAPSHOT = [
  "cat /home/node/.claude/projects/p/s.jsonl",
  "cat /home/node/.codex/sessions/2026/r.jsonl",
  "test -s /home/node/.codex/orkestrator-sqlite/state_5.sqlite-wal && echo sqlite-wal",
  "cat /home/node/.codex/orkestrator-bridge/session-titles.jsonl",
  "test ! -e /home/node/.local/share/opencode/orkestrator-db/other.bin && echo no-snapshot",
  "cat /home/node/.grok/sessions/w/s/updates.jsonl; echo",
  // A process registry, deliberately not preserved: it names dead PIDs.
  "test ! -e /home/node/.grok/active_sessions.json && echo no-registry",
  "test ! -e /home/node/.grok/worktrees.db && echo no-worktrees",
  "test ! -e /home/node/.grok/memory-v2 && echo no-memory",
].join(" && ");

export async function exec(containerId: string, script: string): Promise<string> {
  return docker(["exec", "-u", "node", containerId, "bash", "-c", script]);
}

/**
 * Fills a running legacy runtime with `POPULATE` plus real SQLite databases
 * whose committed rows are still in their WAL files.
 */
export async function populateLegacyRuntime(containerId: string): Promise<void> {
  await exec(containerId, POPULATE);
  await docker([
    "exec",
    "-u",
    "node",
    containerId,
    "bun",
    "-e",
    `
    const { spawnSync } = require("node:child_process");
    const { existsSync } = require("node:fs");
    for (const path of ${JSON.stringify(sqlitePaths(false))}) {
      // Simulate a stopped writer with committed rows still in its WAL. A
      // normal last close checkpoints and deletes it, missing this copy path.
      const script = [
        'const { Database } = require("bun:sqlite");',
        'const db = new Database(' + JSON.stringify(path) + ', { create: true });',
        'db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE preservation (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");',
        'db.query("INSERT INTO preservation VALUES (?, ?)").run(1, "retained sqlite data");',
        'process.kill(process.pid, "SIGKILL");',
      ].join("");
      const child = spawnSync("bun", ["-e", script], { stdio: "ignore" });
      if (child.signal !== "SIGKILL" || !existsSync(path + "-wal")) {
        throw new Error("SQLite WAL fixture was not created");
      }
    }
  `,
  ]);
}
