#!/usr/bin/env bun
/**
 * Picks the number for a new to-do or flake case
 * (`mise run number:next -- todo` or `mise run number:next -- flaky-tests`).
 *
 * "The next number after the highest in use" collided whenever two branches
 * cut from the same `main` each took it: both claimed the same number, and the
 * later pull request had to renumber its file, its index row and every link
 * (docs/number-claims/README.md). This picks a number that:
 *
 * - is above every number in use in this checkout, files and claims alike;
 * - is above every claim on every branch origin has (after a best-effort
 *   `git fetch`), so a branch pushed by a parallel worker is never reused;
 * - adds a small random step, so two workers that have not pushed yet rarely
 *   pick the same one.
 *
 * The claim check (`tests/unit/number-claims.test.ts`) still turns the rare
 * remaining clash into a conflict; this only makes it rare.
 *
 *   bun scripts/number-claims.ts next <todo|flaky-tests> [--no-fetch] [--spread N]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const NUMBER_REGISTERS = {
  todo: { register: "docs/todo", claims: "docs/number-claims/todo", maxDigits: 4 },
  "flaky-tests": {
    register: "docs/tests/flaky-tests",
    claims: "docs/number-claims/flaky-tests",
    maxDigits: Infinity,
  },
} as const;
export type NumberRegister = keyof typeof NUMBER_REGISTERS;

/** How many of origin's branches, newest first, are read for claims. */
export const MAX_REMOTE_BRANCHES = 300;
export const DEFAULT_SPREAD = 10;

const NUMBERED = /^(\d{4,})(?:-.+\.md)?$/;

/** The numbers a list of file or claim names uses. */
export function numbersIn(names: Iterable<string>): number[] {
  const numbers: number[] = [];
  for (const name of names) {
    const match = path.basename(name).match(NUMBERED);
    if (match && path.basename(name) !== "0000-index.md") numbers.push(Number(match[1]));
  }
  return numbers;
}

/**
 * The number to take: above `highest` by a random step of 1 to `spread`.
 * Throws when it would need more digits than the register's files allow.
 */
export function nextNumber(
  highest: number,
  options: { spread?: number; maxDigits?: number; random?: () => number } = {},
): string {
  const spread = Math.max(1, Math.floor(options.spread ?? DEFAULT_SPREAD));
  const random = options.random ?? Math.random;
  const limit = Number.isFinite(options.maxDigits) ? 10 ** options.maxDigits! - 1 : Infinity;
  const room = Math.min(spread, limit - highest);
  if (room < 1) throw new Error(`no number above ${highest} fits in ${options.maxDigits} digits`);
  const next = highest + 1 + Math.floor(random() * room);
  return String(next).padStart(4, "0");
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
  return result.status === 0 ? result.stdout : null;
}

function localNames(root: string, register: NumberRegister): string[] {
  const { register: dir, claims } = NUMBER_REGISTERS[register];
  const names: string[] = [];
  const registerDir = path.join(root, dir);
  if (existsSync(registerDir)) {
    for (const folder of readdirSync(registerDir, { withFileTypes: true })) {
      if (folder.isDirectory()) names.push(...readdirSync(path.join(registerDir, folder.name)));
    }
  }
  const claimsDir = path.join(root, claims);
  if (existsSync(claimsDir)) names.push(...readdirSync(claimsDir));
  return names;
}

function remoteClaimNames(root: string, register: NumberRegister): string[] {
  const refs = git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    `--count=${MAX_REMOTE_BRANCHES}`,
    "--format=%(refname)",
    "refs/remotes/origin",
  ]);
  const names: string[] = [];
  for (const ref of refs?.split("\n").filter(Boolean) ?? []) {
    const listed = git(root, [
      "ls-tree",
      "--name-only",
      ref,
      `${NUMBER_REGISTERS[register].claims}/`,
    ]);
    if (listed) names.push(...listed.split("\n").filter(Boolean));
  }
  return names;
}

function main(args: readonly string[]): number {
  const [command, register] = args;
  if (command !== "next" || !register || !(register in NUMBER_REGISTERS)) {
    console.error("usage: number-claims.ts next <todo|flaky-tests> [--no-fetch] [--spread N]");
    return 2;
  }
  const spreadAt = args.indexOf("--spread");
  const spread = spreadAt === -1 ? DEFAULT_SPREAD : Number(args[spreadAt + 1]);
  if (!Number.isInteger(spread) || spread < 1) {
    console.error("--spread takes a whole number of at least 1");
    return 2;
  }
  const root = path.resolve(import.meta.dir, "..");
  const name = register as NumberRegister;
  if (!args.includes("--no-fetch") && git(root, ["fetch", "--quiet", "origin"]) === null) {
    console.error("git fetch origin failed; using the branches already fetched");
  }
  const used = numbersIn([...localNames(root, name), ...remoteClaimNames(root, name)]);
  const highest = used.reduce((max, n) => Math.max(max, n), 0);
  console.log(nextNumber(highest, { spread, maxDigits: NUMBER_REGISTERS[name].maxDigits }));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
