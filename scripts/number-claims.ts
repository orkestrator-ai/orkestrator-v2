#!/usr/bin/env bun
/**
 * Picks the number for a new to-do or flake case
 * (`mise run number:next -- todo` or `mise run number:next -- flaky-tests`).
 *
 * Scans local files and origin's branch claims, then reserves a number
 * through an atomic Git ref update shared by all worktrees in this clone.
 * Random spacing reduces collisions across independent clones.
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

function gitResult(root: string, args: string[], input?: string) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(root: string, args: string[], input?: string): string | null {
  const result = gitResult(root, args, input);
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

const REMOTE_CLAIMS = "refs/orkestrator/number-origin";

async function fetchRemoteClaims(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = gitResult(root, [
      "fetch",
      "--quiet",
      "--atomic",
      "--prune",
      "--no-tags",
      "--no-write-fetch-head",
      "--refmap=",
      "origin",
      `+refs/heads/*:${REMOTE_CLAIMS}/*`,
    ]);
    if (result.status === 0) return;
    // Two worktrees can fetch the same newly published refs concurrently.
    if (!result.stderr?.includes("cannot lock ref") || attempt === 4) break;
    await Bun.sleep(50 * (attempt + 1));
  }
  throw new Error(
    "Could not fetch every branch from origin. Use --no-fetch to allocate with cached claims only.",
  );
}

function remoteClaimNames(root: string, register: NumberRegister, offline: boolean): string[] {
  const refs = git(root, [
    "for-each-ref",
    "--format=%(objectname)",
    REMOTE_CLAIMS,
    ...(offline ? ["refs/remotes/origin"] : []),
  ]);
  if (refs === null) throw new Error("Could not enumerate origin's branch tips");
  const trees = new Set(refs.trim().split("\n").filter(Boolean));
  const names = [];
  for (const tree of trees) {
    const listed = git(root, [
      "ls-tree",
      "-z",
      "--name-only",
      tree,
      `${NUMBER_REGISTERS[register].claims}/`,
    ]);
    if (listed === null) throw new Error("Could not read a claim tree from origin");
    names.push(...listed.split("\0").filter(Boolean));
  }
  return names;
}

function reserve(root: string, name: NumberRegister, highest: number, spread: number): string {
  const ref = `refs/orkestrator/number-reservations/${name}`;
  for (let attempt = 0; attempt < 40; attempt++) {
    const old = git(root, ["rev-parse", "--verify", "--quiet", ref])?.trim();
    const reserved = old ? git(root, ["cat-file", "blob", old])?.trim() : "0";
    if (!reserved || !/^\d+$/.test(reserved)) throw new Error("Invalid local number reservation");
    const next = nextNumber(Math.max(highest, Number(reserved)), {
      spread,
      maxDigits: NUMBER_REGISTERS[name].maxDigits,
    });
    const object = git(root, ["hash-object", "-w", "--stdin"], next)?.trim();
    if (!object) throw new Error("Could not store a local number reservation");
    if (git(root, ["update-ref", ref, object, old ?? ""]) !== null) return next;
  }
  throw new Error("Could not reserve a number after concurrent updates");
}

async function main(args: readonly string[]): Promise<number> {
  const [command, register, ...options] = args;
  const spreadAt = options.indexOf("--spread");
  const spread = spreadAt === -1 ? DEFAULT_SPREAD : Number(options[spreadAt + 1]);
  const offline = options.includes("--no-fetch");
  const expectedOptions = (offline ? 1 : 0) + (spreadAt === -1 ? 0 : 2);
  if (
    command !== "next" ||
    !register ||
    !Object.hasOwn(NUMBER_REGISTERS, register) ||
    options.length !== expectedOptions ||
    !Number.isSafeInteger(spread) ||
    spread < 1
  ) {
    console.error("usage: number-claims.ts next <todo|flaky-tests> [--no-fetch] [--spread N]");
    return 2;
  }

  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"])?.trimEnd();
  if (!root) {
    console.error("Run number:next in the checkout where you will add the claim.");
    return 1;
  }
  try {
    const name = register as NumberRegister;
    if (offline) console.error("Using cached origin claims only.");
    else await fetchRemoteClaims(root);
    const used = numbersIn([...localNames(root, name), ...remoteClaimNames(root, name, offline)]);
    const highest = used.reduce((max, number) => Math.max(max, number), 0);
    console.log(reserve(root, name, highest, spread));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
