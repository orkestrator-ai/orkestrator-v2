import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { StorageDatabase } from "../storage-database.js";
import { openBackendDatabase } from "../storage-stores.js";
import { ChangeTrackingService, type EvidenceSource } from "./service.js";
import type { ChangeTrackingPolicy } from "./policy-registry.js";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).toString();
}

export interface Harness {
  service: ChangeTrackingService;
  repo: string;
  dataDir: string;
  events: Array<{ event: string; payload: unknown }>;
  cleanup(): void;
  database(): StorageDatabase;
}

export function createHarness(
  options: {
    policy?: Partial<ChangeTrackingPolicy>;
    repo?: boolean;
    manualScheduling?: boolean;
  } = {},
): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "ork-ct-data-"));
  const repo = mkdtempSync(join(tmpdir(), "ork-ct-repo-"));
  if (options.repo !== false) {
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
  }
  let database: StorageDatabase | null = null;
  const events: Array<{ event: string; payload: unknown }> = [];
  const service = new ChangeTrackingService({
    dataDir,
    database: () => (database ??= openBackendDatabase(dataDir)),
    emit: (event, payload) => events.push({ event, payload }),
    environmentTarget: async (environmentId) =>
      environmentId === "env-1" ? { kind: "local", worktreePath: repo } : null,
    durable: false,
    manualScheduling: options.manualScheduling ?? true,
    policy: options.policy,
  });
  service.start();
  return {
    service,
    repo,
    dataDir,
    events,
    database: () => (database ??= openBackendDatabase(dataDir)),
    cleanup() {
      service.shutdown();
      database?.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

/** An in-process evidence source over a bridge-style spool. */
export function spoolSource(
  spool: ChangeEvidenceSpool,
  provider = "claude",
  environmentId = "env-1",
): EvidenceSource {
  return {
    sourceKey: `${environmentId}\0${provider}\0test`,
    environmentId,
    provider,
    read: async (cursor, epoch) => spool.read(epoch && epoch !== spool.runtimeEpoch ? 0 : cursor),
    body: async (id) => spool.readBody(id),
    ack: async (request) => {
      spool.acknowledge(request);
    },
  };
}
