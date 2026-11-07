#!/usr/bin/env bun
/**
 * Regenerates the committed client adapter list from the domain client
 * definitions (plan item 1009, docs/reports/unified-federation.md §11.3
 * step 3).
 *
 *   bun scripts/generate-contract-adapters.ts           # write
 *   bun scripts/generate-contract-adapters.ts --check   # verify, no writes
 *
 * `packages/protocol/contracts/adapters.json` lists, per domain, the client's
 * current version and every adapter version it has (`DOMAIN_CLIENTS` in
 * `packages/protocol/src/contract/client-adapters.ts`). The contract CI job
 * (plan item 1008) reads it to assert an adapter exists for every (domain,
 * version) in the support window. The definitions are browser-safe modules
 * with no side effects, so they are imported directly; nothing runs.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ADAPTER_LIST_PATH,
  buildAdapterList,
  DOMAIN_CLIENTS,
  describeAdapterListDrift,
  serializeAdapterList,
} from "@orkestrator/protocol/contract/client-adapters";

const repoRoot = join(import.meta.dir, "..");

export function parseArguments(args: readonly string[]): { check: boolean } {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === "--check") return { check: true };
  throw new Error("usage: bun scripts/generate-contract-adapters.ts [--check]");
}

/** Writes the list, or with `check` returns the drift without writing. */
export async function runContractAdapters(options: {
  readonly check: boolean;
  readonly root?: string;
  readonly clients?: typeof DOMAIN_CLIENTS;
}): Promise<string[]> {
  const path = join(options.root ?? repoRoot, ADAPTER_LIST_PATH);
  const list = buildAdapterList(options.clients ?? DOMAIN_CLIENTS);
  if (options.check) {
    const committed = existsSync(path) ? await readFile(path, "utf8") : null;
    return describeAdapterListDrift(committed, list);
  }
  await writeFile(path, serializeAdapterList(list));
  return [];
}

if (import.meta.main) {
  try {
    const { check } = parseArguments(process.argv.slice(2));
    const problems = await runContractAdapters({ check });
    if (problems.length > 0) {
      console.error(
        `${problems.join("\n")}\nRun \`mise run contract:adapters\` and commit ${ADAPTER_LIST_PATH}.`,
      );
      process.exit(1);
    }
    console.log(check ? `${ADAPTER_LIST_PATH} is up to date.` : `Wrote ${ADAPTER_LIST_PATH}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
