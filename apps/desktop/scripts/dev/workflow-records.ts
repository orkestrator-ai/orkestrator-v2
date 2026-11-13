import { spawn } from "node:child_process";
import path from "node:path";

import type { RuntimeProfile } from "../../electron/runtime-profile.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const backendRoot = path.join(repositoryRoot, "apps", "backend");
const seedScript = path.join(backendRoot, "scripts", "seed-coordinator-workflows.ts");
const MAX_SEED_OUTPUT_CHARS = 256 * 1024;

/**
 * `--seed-workflow-records`: how many in-use coordinator workflow records a
 * `dev:test` start seeds. `near-limit` and `full` are the counts at which the
 * coordinator panel's store banner shows each state; the backend script
 * resolves them from its own constants (`COORDINATOR_WORKFLOW_NEAR_LIMIT`,
 * `MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS`), so they cannot drift from the
 * banner's thresholds.
 */
export type WorkflowRecordSeed = number | "near-limit" | "full";

export function parseWorkflowRecordSeed(value: string): WorkflowRecordSeed {
  if (value === "near-limit" || value === "full") return value;
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  throw new Error("--seed-workflow-records accepts a positive count, near-limit or full");
}

/** Where the seeded records' own project is checked out. */
export function seededWorkflowCheckout(profile: Pick<RuntimeProfile, "fixtureDir">): string {
  return path.join(profile.fixtureDir, "seeded-workflows");
}

export type SeededWorkflowRecords = {
  projectId: string;
  coordinatorId: string;
  added: number;
  inUse: number;
  stale: number;
  /** Requested records the store refused because every record left was in use. */
  refused: number;
  storeRecords: number;
};

/** Runs the backend seeding script; injectable so tests need no backend. */
export type WorkflowSeedRunner = (
  args: string[],
) => Promise<{ code: number | null; output: string }>;

const runSeedScript: WorkflowSeedRunner = (args) =>
  new Promise((resolve, reject) => {
    // In the backend package, as the backend itself runs: `bun` reads
    // `bunfig.toml` and `.env` from its working directory.
    const child = spawn(process.execPath, [seedScript, ...args], {
      cwd: backendRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Only the tail is kept: the result line is printed last, and storage
    // logging must not grow the launcher's memory without bound.
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_SEED_OUTPUT_CHARS) output = output.slice(-MAX_SEED_OUTPUT_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

/**
 * Seeds the profile's store before Electron starts, so no backend has it open
 * and the records go in through the store's own API rather than behind a
 * running backend's back. Every start with the option refreshes the records,
 * which stay in use for a day (the replay window) after it.
 */
export async function seedProfileWorkflowRecords(
  profile: Pick<RuntimeProfile, "dataDir" | "fixtureDir">,
  seed: WorkflowRecordSeed,
  options: { run?: WorkflowSeedRunner; writeLog?: (text: string) => Promise<void> } = {},
): Promise<SeededWorkflowRecords> {
  const checkout = seededWorkflowCheckout(profile);
  const { code, output } = await (options.run ?? runSeedScript)([
    "--data-dir",
    profile.dataDir,
    "--checkout",
    checkout,
    "--records",
    String(seed),
  ]);
  await options.writeLog?.(output);
  const result = output
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as Partial<SeededWorkflowRecords> & { type?: string };
      } catch {
        return null;
      }
    })
    .find((line) => line?.type === "orkestrator-seeded-workflow-records");
  if (code !== 0 || !result) {
    const reason = output.trim().split("\n").at(-1) ?? "";
    throw new Error(
      `Seeding coordinator workflow records failed${reason ? `: ${reason}` : ` (exit ${code ?? "unknown"})`}`,
    );
  }
  return {
    projectId: String(result.projectId),
    coordinatorId: String(result.coordinatorId),
    added: Number(result.added),
    inUse: Number(result.inUse),
    stale: Number(result.stale),
    refused: Number(result.refused ?? 0),
    storeRecords: Number(result.storeRecords),
  };
}

export function formatSeededWorkflowRecords(
  records: SeededWorkflowRecords,
  checkout: string,
): string {
  const refused =
    records.refused > 0 ? ` (${records.refused} refused: the store is full of records in use)` : "";
  return (
    `Seeded coordinator workflow records: ${records.inUse} in use (${records.added} new)${refused}, ` +
    `${records.storeRecords} in the store; open the coordinator of ${checkout}`
  );
}
